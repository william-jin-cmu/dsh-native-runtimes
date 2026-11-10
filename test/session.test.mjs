// Session mode: what is sent to the runtime, and how a CLI turn becomes DSH stream chunks.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeStream, claudeArgs } from '../src/runtimes/claude.ts'
import { NativeRuntimeAdapter, flatPrompt, newInput, preface } from '../src/session.ts'

const user = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } })

test('newInput: only what the user typed since the last reply is sent', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } },
    user('first'), assistant('one'),
    user('AGENTS.md says…', 'agent-instructions'), user('second'), user('cwd is /x', 'runtime-context'),
  ]
  const { text, earlier } = newInput(messages)
  assert.equal(text, 'second')
  assert.equal(earlier.length, 3)
})

test('newInput: a turn started by a notice sends the notice', () => {
  assert.equal(newInput([user('a'), assistant('b'), user('Thread t1 finished.', 'ntr-thread')]).text, 'Thread t1 finished.')
})

test('preface: retells the conversation without injected context', () => {
  const text = preface([user('first'), user('skill list', 'skill-catalog'), assistant('one')])
  assert.match(text, /User: first\n\nAssistant: one/)
  assert.doesNotMatch(text, /skill list/)
  assert.equal(preface([]), '')
})

test('flatPrompt: a one-shot request becomes one prompt', () => {
  assert.equal(flatPrompt({ system: 'Title this.', messages: [user('fix the build'), assistant('done')] }), 'Title this.\n\nUser: fix the build\n\nAssistant: done')
})

test('claudeArgs: session turns stream, one-shots have no tools and keep nothing', () => {
  const options = { command: 'claude', model: '', permissionMode: 'acceptEdits', sessionArgs: ['--thinking-display', 'summarized'] }
  assert.deepEqual(claudeArgs(options, { threadId: 's', cwd: '/', prompt: 'x', stream: true, sessionRef: 'abc', model: 'opus' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'acceptEdits', '--include-partial-messages', '--thinking-display', 'summarized', '--resume', 'abc'])
  assert.deepEqual(claudeArgs(options, { threadId: 's', cwd: '/', prompt: 'x', oneShot: true, model: 'haiku' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--tools', '', '--no-session-persistence'])
})

test('claude stream: partial text is not repeated by the finished message; subagent output is skipped', () => {
  const out = []
  const stream = new ClaudeStream({
    onActivity: (line) => out.push(['activity', line]), onSessionRef: () => {}, onBreak: () => out.push(['break']),
    onText: (delta) => out.push(['text', delta]), onThinking: (delta) => out.push(['thinking', delta]), onUsage: (usage) => out.push(['usage', usage]),
  })
  for (const line of [
    '{"type":"stream_event","event":{"type":"message_start"},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ng"}},"parent_tool_use_id":null}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"inner"}},"parent_tool_use_id":"toolu_1"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":100,"output_tokens":4}},"parent_tool_use_id":null}',
    '{"type":"result","subtype":"success","is_error":false,"result":"pong","usage":{"input_tokens":9,"output_tokens":30}}',
  ]) stream.push(line)
  assert.deepEqual(out, [
    ['break'], ['thinking', 'hmm'], ['text', 'po'], ['text', 'ng'], ['activity', 'Bash: ls'],
    ['usage', { inputTokens: 2, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 }],
  ])
})

/** A driver that plays a script instead of running a CLI. */
function fakeRuntime(script) {
  const calls = []
  return {
    calls,
    runtime: {
      provider: 'claude-cli', name: 'Claude Code', models: [{ id: 'default', name: 'Claude Code' }], auxModel: 'haiku', contextWindow: 200_000,
      driver: {
        id: 'claude-code', label: 'fake',
        runTurn(request, hooks) {
          calls.push(request)
          let stop = () => {}
          const done = new Promise((resolve) => {
            stop = () => resolve({ ok: false, reply: '', error: 'stopped' })
            // A script that never answers must still be stoppable, so its promise is not adopted.
            queueMicrotask(() => void Promise.resolve(script(request, hooks)).then(resolve))
          })
          return { done, stop: () => stop() }
        },
      },
    },
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('adapter: a session turn streams reasoning and text, then resumes the same conversation', async () => {
  const fake = fakeRuntime((request, hooks) => {
    hooks.onSessionRef('conv-1')
    hooks.onThinking('Let me look.\n')
    hooks.onActivity('Bash: ls')
    hooks.onBreak()
    hooks.onText('Two files.')
    hooks.onUsage({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 })
    return { ok: true, reply: 'Two files.' }
  })
  const adapter = new NativeRuntimeAdapter({ runtimes: [fake.runtime], cwdOf: () => '/work', stateDir: mkdtempSync(join(tmpdir(), 'ntr-test-')), log: () => {} })
  const chunks = await collect(adapter.stream({ provider: 'claude-cli', model: 'default', sessionId: 's1', messages: [user('what is here?')] }))
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'reasoning-delta', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks[3].block, { type: 'reasoning', text: 'Let me look.\n▸ Bash: ls\n' })
  assert.deepEqual(chunks[6].block, { type: 'text', text: 'Two files.' })
  assert.deepEqual(fake.calls[0], { threadId: 's1', cwd: '/work', prompt: 'what is here?', stream: true })

  await collect(adapter.stream({ provider: 'claude-cli', model: 'opus', sessionId: 's1', messages: [user('what is here?'), assistant('Two files.'), user('and now?')] }))
  assert.deepEqual(fake.calls[1], { threadId: 's1', cwd: '/work', prompt: 'and now?', model: 'opus', stream: true, sessionRef: 'conv-1' })
})

test('adapter: a session that began on another model is retold; a lost conversation starts over', async () => {
  let attempt = 0
  const fake = fakeRuntime((request, hooks) => {
    attempt += 1
    if (request.sessionRef !== undefined) return { ok: false, reply: '', error: 'No conversation found with session ID: gone' }
    hooks.onSessionRef(`conv-${attempt}`)
    return { ok: true, reply: 'ok' }
  })
  const adapter = new NativeRuntimeAdapter({ runtimes: [fake.runtime], cwdOf: () => undefined, stateDir: mkdtempSync(join(tmpdir(), 'ntr-test-')), log: () => {} })
  const history = [user('first'), assistant('one'), user('second')]
  const first = await collect(adapter.stream({ provider: 'claude-cli', model: 'default', sessionId: 's2', messages: history }))
  assert.match(fake.calls[0].prompt, /^This conversation began with another assistant[\s\S]*User: first\n\nAssistant: one[\s\S]*second$/)
  // The reply arrived only as the outcome: it is still shown.
  assert.deepEqual(first.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])

  const second = await collect(adapter.stream({ provider: 'claude-cli', model: 'default', sessionId: 's2', messages: [...history, assistant('ok'), user('third')] }))
  assert.equal(fake.calls[1].sessionRef, 'conv-1')
  assert.equal(fake.calls[2].sessionRef, undefined)
  assert.match(fake.calls[2].prompt, /Assistant: ok[\s\S]*third$/)
  assert.equal(second.at(-1).type, 'finish')
})

test('adapter: a title request is a one-shot on the small model; a failed turn throws', async () => {
  const fake = fakeRuntime((request) => (request.oneShot ? { ok: true, reply: 'Fix the build' } : { ok: false, reply: '', error: 'not logged in' }))
  const adapter = new NativeRuntimeAdapter({ runtimes: [fake.runtime], cwdOf: () => '/work', stateDir: mkdtempSync(join(tmpdir(), 'ntr-test-')), log: () => {} })
  const chunks = await collect(adapter.stream({ provider: 'claude-cli', model: 'opus', sessionId: 's3', purpose: 'session-title', system: 'Title this.', messages: [user('fix the build')] }))
  assert.equal(fake.calls[0].oneShot, true)
  assert.equal(fake.calls[0].model, 'haiku')
  assert.equal(chunks[1].text, 'Fix the build')
  await assert.rejects(collect(adapter.stream({ provider: 'claude-cli', model: 'default', sessionId: 's3', messages: [user('hi')] })), /Claude Code: not logged in/)
})

test('adapter: an abort stops the CLI turn', async () => {
  const fake = fakeRuntime(() => new Promise(() => {}))
  const adapter = new NativeRuntimeAdapter({ runtimes: [fake.runtime], cwdOf: () => '/work', stateDir: mkdtempSync(join(tmpdir(), 'ntr-test-')), log: () => {} })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(collect(adapter.stream({ provider: 'claude-cli', model: 'default', sessionId: 's4', messages: [user('hi')], signal: controller.signal })), /abort/i)
})
