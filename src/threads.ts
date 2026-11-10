/** Thread state: start, follow up, stop, persist. Knows nothing about DSH; index.ts wires it to tools and notices. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeDriver, Thread, Turn, TurnHandle, TurnOutcome } from './types.ts'

const ACTIVITY_MAX_LINES = 200
const SAVE_DEBOUNCE_MS = 1000

export class ThreadError extends Error {}

export interface ThreadManagerOptions {
  /** Directory holding one `<id>.json` per thread. */
  dir: string
  maxConcurrent: number
  turnTimeoutMs: number
  /** A turn ended (finished, failed, stopped or timed out). Not called for turns cut short by `dispose`. */
  onTurnEnd(thread: Thread, turn: Turn): void
}

export class ThreadManager {
  private readonly threads = new Map<string, Thread>()
  private readonly drivers = new Map<string, RuntimeDriver>()
  private readonly live = new Map<string, { handle: TurnHandle; timer: NodeJS.Timeout }>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private disposed = false
  private readonly options: ThreadManagerOptions

  constructor(options: ThreadManagerOptions, drivers: readonly RuntimeDriver[]) {
    this.options = options
    for (const driver of drivers) this.drivers.set(driver.id, driver)
    mkdirSync(options.dir, { recursive: true })
    for (const file of readdirSync(options.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const thread = JSON.parse(readFileSync(join(options.dir, file), 'utf8')) as Thread
        if (typeof thread.id !== 'string' || !Array.isArray(thread.turns)) continue
        // A thread still marked running belongs to a host that is gone; its process went with it.
        if (thread.status === 'running') {
          thread.status = 'interrupted'
          delete thread.pending
          const turn = thread.turns.at(-1)
          if (turn !== undefined && turn.endedAt === undefined) {
            turn.endedAt = thread.updatedAt
            turn.error = 'interrupted: DSH stopped while this turn was running'
          }
          this.write(thread)
        }
        this.threads.set(thread.id, thread)
      } catch {
        // An unreadable file is not worth failing the plugin over.
      }
    }
  }

  runtimes(): RuntimeDriver[] {
    return [...this.drivers.values()]
  }

  list(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Thread {
    const thread = this.threads.get(id.trim())
    if (thread === undefined) throw new ThreadError(`No thread "${id}". thread_list shows the ids.`)
    return thread
  }

  start(input: { runtime: string; task: string; title?: string; cwd: string; model?: string; ownerSessionId?: string }): Thread {
    const driver = this.drivers.get(input.runtime)
    if (driver === undefined) {
      const available = [...this.drivers.keys()]
      throw new ThreadError(available.length === 0
        ? 'No runtime is available on this machine: neither `claude` nor `codex` was found and no ACP agent is configured.'
        : `Unknown runtime "${input.runtime}". Available: ${available.join(', ')}.`)
    }
    this.assertCapacity()
    const now = Date.now()
    let id = `t-${randomBytes(3).toString('hex')}`
    while (this.threads.has(id)) id = `t-${randomBytes(3).toString('hex')}`
    const thread: Thread = {
      id,
      runtime: input.runtime,
      title: (input.title?.trim() || input.task.trim().split('\n')[0] || 'Thread').slice(0, 80),
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      status: 'idle',
      ...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
      createdAt: now,
      updatedAt: now,
      turns: [],
    }
    this.threads.set(id, thread)
    this.runTurn(thread, driver, input.task)
    return thread
  }

  /** A follow-up turn. While a turn is running, one message can wait in line; a second one is refused. */
  send(id: string, message: string, ownerSessionId?: string): { thread: Thread; queued: boolean } {
    const thread = this.get(id)
    const driver = this.drivers.get(thread.runtime)
    if (driver === undefined) throw new ThreadError(`The "${thread.runtime}" runtime is not available any more, so thread ${thread.id} cannot continue.`)
    if (ownerSessionId !== undefined) thread.ownerSessionId = ownerSessionId
    if (thread.status === 'running') {
      if (thread.pending !== undefined) throw new ThreadError(`Thread ${thread.id} is busy and already has a message waiting. Wait for its next notice, or thread_stop it first.`)
      thread.pending = message
      this.saveNow(thread)
      return { thread, queued: true }
    }
    this.assertCapacity()
    this.runTurn(thread, driver, message)
    return { thread, queued: false }
  }

  /** Ends the running turn. Returns false when nothing was running. */
  stop(id: string): boolean {
    const thread = this.get(id)
    const live = this.live.get(thread.id)
    if (live === undefined) return false
    delete thread.pending
    live.handle.stop()
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const [id, live] of this.live) {
      clearTimeout(live.timer)
      live.handle.stop()
      const thread = this.threads.get(id)
      if (thread === undefined) continue
      thread.status = 'interrupted'
      delete thread.pending
      const turn = thread.turns.at(-1)
      if (turn !== undefined && turn.endedAt === undefined) {
        turn.endedAt = Date.now()
        turn.error = 'interrupted: DSH stopped while this turn was running'
      }
      this.saveNow(thread)
    }
    this.live.clear()
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer)
      const thread = this.threads.get(id)
      if (thread !== undefined) this.write(thread)
    }
    this.saveTimers.clear()
    for (const driver of this.drivers.values()) driver.dispose?.()
  }

  private assertCapacity(): void {
    if (this.live.size >= this.options.maxConcurrent) {
      throw new ThreadError(`${this.live.size} threads are already running (the limit is ${this.options.maxConcurrent}). Wait for one to finish or thread_stop one.`)
    }
  }

  private runTurn(thread: Thread, driver: RuntimeDriver, prompt: string): void {
    const turn: Turn = { prompt, startedAt: Date.now(), activity: [] }
    thread.turns.push(turn)
    thread.status = 'running'
    thread.updatedAt = turn.startedAt
    this.saveNow(thread)

    let timedOut = false
    const handle = driver.runTurn(
      { threadId: thread.id, cwd: thread.cwd, prompt, ...(thread.model ? { model: thread.model } : {}), ...(thread.sessionRef ? { sessionRef: thread.sessionRef } : {}) },
      {
        onActivity: (line) => {
          turn.activity.push(line)
          if (turn.activity.length > ACTIVITY_MAX_LINES) turn.activity.splice(0, turn.activity.length - ACTIVITY_MAX_LINES)
          thread.updatedAt = Date.now()
          this.saveSoon(thread)
        },
        onSessionRef: (ref) => {
          thread.sessionRef = ref
          this.saveSoon(thread)
        },
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      handle.stop()
    }, this.options.turnTimeoutMs)
    timer.unref()
    this.live.set(thread.id, { handle, timer })

    void handle.done
      .catch((error: unknown): TurnOutcome => ({ ok: false, reply: '', error: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        clearTimeout(timer)
        if (this.disposed || this.live.get(thread.id)?.handle !== handle) return
        this.live.delete(thread.id)
        const stopped = outcome.error === 'stopped'
        turn.endedAt = Date.now()
        if (outcome.reply !== '') turn.reply = outcome.reply
        if (!outcome.ok) turn.error = timedOut ? `timed out after ${Math.round(this.options.turnTimeoutMs / 60_000)} minutes` : (outcome.error ?? 'failed')
        thread.status = outcome.ok ? 'idle' : stopped && !timedOut ? 'stopped' : 'failed'
        thread.updatedAt = turn.endedAt
        const next = outcome.ok ? thread.pending : undefined
        delete thread.pending
        this.saveNow(thread)
        this.options.onTurnEnd(thread, turn)
        if (next !== undefined) {
          try {
            this.runTurn(thread, driver, next)
          } catch {
            // The queued message is dropped; the notice for the finished turn already went out.
          }
        }
      })
  }

  private saveSoon(thread: Thread): void {
    if (this.saveTimers.has(thread.id)) return
    const timer = setTimeout(() => {
      this.saveTimers.delete(thread.id)
      this.write(thread)
    }, SAVE_DEBOUNCE_MS)
    timer.unref()
    this.saveTimers.set(thread.id, timer)
  }

  private saveNow(thread: Thread): void {
    const timer = this.saveTimers.get(thread.id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.saveTimers.delete(thread.id)
    }
    this.write(thread)
  }

  private write(thread: Thread): void {
    const path = join(this.options.dir, `${thread.id}.json`)
    const temp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(thread, null, 1))
      renameSync(temp, path)
    } catch {
      rmSync(temp, { force: true })
    }
  }
}
