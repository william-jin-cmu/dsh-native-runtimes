// Stream parsers fed with lines recorded from the real CLIs (claude 2.1.314, codex-cli 0.165.0, dsh ACP 0.2.1-rc.5).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpTurn, pickPermissionOption } from '../src/runtimes/acp.ts'
import { ClaudeStream, claudeArgs, claudeToolLine } from '../src/runtimes/claude.ts'
import { CodexStream, codexArgs } from '../src/runtimes/codex.ts'

function recorder() {
  const activity = []
  const refs = []
  return { activity, refs, hooks: { onActivity: (line) => activity.push(line), onSessionRef: (ref) => refs.push(ref) } }
}

test('claude: init, tool use and result fold into a reply', () => {
  const rec = recorder()
  const stream = new ClaudeStream(rec.hooks)
  for (const line of [
    '{"type":"system","subtype":"hook_started","hook_id":"x","session_id":"46108a5e-d632-470b-a91f-2281993ff123"}',
    '{"type":"system","subtype":"init","cwd":"/private/tmp/ws","session_id":"46108a5e-d632-470b-a91f-2281993ff123","tools":["Bash"]}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Creating the file."},{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/tmp/ws/a.txt","content":"x"}}]},"session_id":"46108a5e-d632-470b-a91f-2281993ff123"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}',
    'not json at all',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"46108a5e-d632-470b-a91f-2281993ff123","total_cost_usd":0.2}',
  ]) stream.push(line)
  assert.deepEqual(rec.refs, ['46108a5e-d632-470b-a91f-2281993ff123'])
  assert.deepEqual(rec.activity, ['Write: /tmp/ws/a.txt'])
  assert.deepEqual(stream.finish(0, ''), { ok: true, reply: 'pong' })
})

test('claude: an error result and a missing result are failures', () => {
  const failed = new ClaudeStream(recorder().hooks)
  failed.push('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}')
  failed.push('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s"}')
  assert.equal(failed.outcome.ok, false)
  assert.equal(failed.outcome.error, 'Claude Code stopped: error max turns')
  assert.equal(failed.outcome.reply, 'working')

  const cut = new ClaudeStream(recorder().hooks)
  const outcome = cut.finish(1, 'warn\nInvalid API key\n')
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /exited with code 1 before finishing: warn \| Invalid API key/)
})

test('claude: arguments', () => {
  const options = { command: 'claude', model: '', permissionMode: 'acceptEdits' }
  assert.deepEqual(claudeArgs(options, { threadId: 't', cwd: '/', prompt: 'p' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(claudeArgs({ ...options, model: 'sonnet' }, { threadId: 't', cwd: '/', prompt: 'p', sessionRef: 'abc', model: 'opus' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'acceptEdits', '--resume', 'abc'])
  assert.equal(claudeToolLine('Bash', { command: 'echo hi', description: 'say hi' }), 'Bash: echo hi')
  assert.equal(claudeToolLine('TodoWrite', { todos: [] }), 'TodoWrite')
})

test('codex: thread id, commands and the last agent message', () => {
  const rec = recorder()
  const stream = new CodexStream(rec.hooks)
  for (const line of [
    '{"type":"thread.started","thread_id":"01a1c36b-1296-7b12-88e5-6384db1bac47"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run the command now.\\n"}}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'echo hi\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'echo hi\'","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"pong"}}',
    '{"type":"turn.completed","usage":{"input_tokens":41855,"cached_input_tokens":33792,"output_tokens":46}}',
  ]) stream.push(line)
  assert.deepEqual(rec.refs, ['01a1c36b-1296-7b12-88e5-6384db1bac47'])
  assert.deepEqual(rec.activity, ["$ /bin/zsh -lc 'echo hi'"])
  assert.deepEqual(stream.finish(0, ''), { ok: true, reply: 'pong' })
})

test('codex: failed turn, non-zero command exit, and exit without a turn end', () => {
  const rec = recorder()
  const stream = new CodexStream(rec.hooks)
  stream.push('{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":1,"status":"failed"}}')
  stream.push('{"type":"turn.failed","error":{"message":"usage limit reached"}}')
  assert.deepEqual(rec.activity, ['  exit 1'])
  assert.deepEqual(stream.outcome, { ok: false, reply: '', error: 'usage limit reached' })

  const cut = new CodexStream(recorder().hooks)
  cut.push('{"type":"error","message":"stream disconnected"}')
  assert.match(cut.finish(1, 'ignored').error, /exited with code 1 before finishing: stream disconnected/)
})

test('codex: arguments for a first turn and a resume', () => {
  const options = { command: 'codex', model: '', sandbox: 'workspace-write' }
  assert.deepEqual(codexArgs(options, { threadId: 't', cwd: '/', prompt: 'p' }),
    ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-'])
  assert.deepEqual(codexArgs({ ...options, model: 'gpt-x' }, { threadId: 't', cwd: '/', prompt: 'p', sessionRef: 'abc' }),
    ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-x', 'abc', '-'])
})

test('acp: the reply is the text after the last tool call', () => {
  const rec = recorder()
  const turn = new AcpTurn(rec.hooks)
  for (const update of [
    { sessionUpdate: 'usage_update', used: 9660, size: 1000000 },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me run it.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { description: 'Run echo command', command: 'echo acp-ok' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'acp-ok\n' } }] },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The command `echo acp-ok` ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'output `acp-ok`.' } },
  ]) turn.update(update)
  assert.deepEqual(rec.activity, ['bash: echo acp-ok'])
  assert.equal(turn.reply(), 'The command `echo acp-ok` output `acp-ok`.')

  const silent = new AcpTurn(recorder().hooks)
  silent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
  silent.update({ sessionUpdate: 'tool_call', title: 'write', rawInput: {} })
  assert.equal(silent.reply(), 'Done.')
})

test('acp: permission answers', () => {
  const options = [{ optionId: 'r', kind: 'reject_once' }, { optionId: 'aa', kind: 'allow_always' }, { optionId: 'a', kind: 'allow_once' }]
  assert.equal(pickPermissionOption(options, true), 'a')
  assert.equal(pickPermissionOption(options, false), 'r')
  assert.equal(pickPermissionOption([{ optionId: 'r', kind: 'reject_once' }], true), undefined)
  assert.equal(pickPermissionOption(undefined, true), undefined)
})
