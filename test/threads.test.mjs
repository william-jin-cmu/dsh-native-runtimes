// ThreadManager with a fake runtime: turn lifecycle, the one-message queue, stop, limits and restart recovery.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { turnNotice } from '../src/notice.ts'
import { ThreadError, ThreadManager } from '../src/threads.ts'

/** A driver whose turns end only when the test says so. */
function fakeDriver() {
  const turns = []
  return {
    turns,
    driver: {
      id: 'fake',
      label: 'fake runtime',
      runTurn(request, hooks) {
        let settle
        const done = new Promise((resolve) => (settle = resolve))
        const turn = { request, hooks, finish: (outcome) => settle(outcome), stopped: false }
        turns.push(turn)
        return { done, stop: () => { turn.stopped = true; settle({ ok: false, reply: '', error: 'stopped' }) } }
      },
    },
  }
}

function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ntr-test-'))
  const fake = fakeDriver()
  const ended = []
  const manager = new ThreadManager({ dir, maxConcurrent: 2, turnTimeoutMs: 60_000, onTurnEnd: (thread, turn) => ended.push({ status: thread.status, turn }), ...overrides }, [fake.driver])
  return { dir, fake, ended, manager }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a turn runs, records activity and the session ref, and ends idle', async () => {
  const { dir, fake, ended, manager } = setup()
  const thread = manager.start({ runtime: 'fake', task: 'do the thing\nwith details', cwd: '/tmp', ownerSessionId: 'owner-1' })
  assert.match(thread.id, /^t-[0-9a-f]{6}$/)
  assert.equal(thread.title, 'do the thing')
  assert.equal(thread.status, 'running')
  fake.turns[0].hooks.onSessionRef('sess-1')
  fake.turns[0].hooks.onActivity('$ ls')
  fake.turns[0].finish({ ok: true, reply: 'done' })
  await tick()
  assert.equal(thread.status, 'idle')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].turn.reply, 'done')
  const saved = JSON.parse(readFileSync(join(dir, `${thread.id}.json`), 'utf8'))
  assert.equal(saved.sessionRef, 'sess-1')
  assert.deepEqual(saved.turns[0].activity, ['$ ls'])
  assert.equal(saved.ownerSessionId, 'owner-1')

  manager.send(thread.id, 'more')
  assert.equal(fake.turns[1].request.sessionRef, 'sess-1')
  manager.dispose()
})

test('a busy thread queues one follow-up and refuses a second', async () => {
  const { fake, ended, manager } = setup()
  const thread = manager.start({ runtime: 'fake', task: 'first', cwd: '/tmp' })
  assert.deepEqual(manager.send(thread.id, 'second').queued, true)
  assert.throws(() => manager.send(thread.id, 'third'), ThreadError)
  fake.turns[0].finish({ ok: true, reply: 'one' })
  await tick()
  assert.equal(fake.turns.length, 2)
  assert.equal(fake.turns[1].request.prompt, 'second')
  assert.equal(thread.status, 'running')
  assert.equal(thread.pending, undefined)
  fake.turns[1].finish({ ok: true, reply: 'two' })
  await tick()
  assert.deepEqual(ended.map((entry) => entry.turn.reply), ['one', 'two'])
  manager.dispose()
})

test('stop ends the turn, drops the queue, and the thread can continue', async () => {
  const { fake, ended, manager } = setup()
  const thread = manager.start({ runtime: 'fake', task: 'long', cwd: '/tmp' })
  manager.send(thread.id, 'queued')
  assert.equal(manager.stop(thread.id), true)
  await tick()
  assert.equal(fake.turns[0].stopped, true)
  assert.equal(thread.status, 'stopped')
  assert.equal(fake.turns.length, 1)
  assert.equal(ended[0].status, 'stopped')
  assert.equal(manager.stop(thread.id), false)
  assert.equal(manager.send(thread.id, 'again').queued, false)
  manager.dispose()
})

test('limits, unknown runtimes and unknown ids are readable errors', () => {
  const { manager } = setup()
  manager.start({ runtime: 'fake', task: 'a', cwd: '/tmp' })
  manager.start({ runtime: 'fake', task: 'b', cwd: '/tmp' })
  assert.throws(() => manager.start({ runtime: 'fake', task: 'c', cwd: '/tmp' }), /2 threads are already running/)
  assert.throws(() => manager.start({ runtime: 'nope', task: 'c', cwd: '/tmp' }), /Unknown runtime "nope". Available: fake/)
  assert.throws(() => manager.get('t-000000'), /No thread "t-000000"/)
  manager.dispose()
})

test('a failed turn marks the thread failed; a timeout stops it and says so', async () => {
  const { fake, ended, manager } = setup({ turnTimeoutMs: 20 })
  const failing = manager.start({ runtime: 'fake', task: 'x', cwd: '/tmp' })
  fake.turns[0].finish({ ok: false, reply: 'partial', error: 'boom' })
  await tick()
  assert.equal(failing.status, 'failed')
  assert.equal(ended[0].turn.error, 'boom')
  assert.equal(ended[0].turn.reply, 'partial')

  const slow = manager.start({ runtime: 'fake', task: 'y', cwd: '/tmp' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(slow.status, 'failed')
  assert.match(slow.turns[0].error, /timed out/)
  manager.dispose()
})

test('threads survive a restart; one that was running is marked interrupted', () => {
  const { dir, manager } = setup()
  const thread = manager.start({ runtime: 'fake', task: 'survive', cwd: '/tmp' })
  // A host that died without unloading leaves the file saying "running".
  const path = join(dir, `${thread.id}.json`)
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.status, 'running')
  writeFileSync(join(dir, 'garbage.json'), '{not json')

  const reborn = new ThreadManager({ dir, maxConcurrent: 2, turnTimeoutMs: 60_000, onTurnEnd() {} }, [fakeDriver().driver])
  const loaded = reborn.get(thread.id)
  assert.equal(loaded.status, 'interrupted')
  assert.match(loaded.turns[0].error, /interrupted/)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'interrupted')
  assert.equal(reborn.send(thread.id, 'pick it up again').queued, false)
  reborn.dispose()
  manager.dispose()
})

test('notices: a finished turn carries the reply, a long one is cut, a failure says why', () => {
  const thread = { id: 't-abc123', runtime: 'codex', title: 'Fix it' }
  const done = turnNotice(thread, { prompt: 'p', startedAt: 0, activity: [], reply: 'All fixed.' })
  assert.match(done.text, /^Thread t-abc123 \(codex, "Fix it"\) finished its turn\. Its reply:\n\nAll fixed\./)
  assert.equal(done.summary, 'Thread t-abc123 "Fix it" finished')
  const long = turnNotice(thread, { prompt: 'p', startedAt: 0, activity: [], reply: 'x'.repeat(5000) })
  assert.match(long.text, /Reply cut at 4000 characters; thread_read t-abc123 has all of it/)
  const failed = turnNotice(thread, { prompt: 'p', startedAt: 0, activity: [], error: 'usage limit reached' })
  assert.match(failed.text, /did not finish its turn: usage limit reached/)
})
