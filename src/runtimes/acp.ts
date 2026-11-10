/**
 * Any Agent Client Protocol agent, declared in config as a command line. JSON-RPC over stdio:
 *   initialize -> session/new {cwd, mcpServers: []} -> session/prompt, with session/update notifications in between.
 * The agent process stays alive between turns so a follow-up continues the same session; after `idleMs` without a
 * turn it is shut down, and the next follow-up starts it again and resumes (session/resume or session/load) when
 * the agent advertises one of them. This client offers no fs or terminal capabilities: the agent uses its own tools.
 */
import type { ChildProcess } from 'node:child_process'
import { ACTIVITY_LINE_MAX, clip, type RuntimeDriver, type TurnHandle, type TurnHooks, type TurnOutcome, type TurnRequest } from '../types.ts'
import { childEnv, killGroup, parseJson, spawnLines, stderrTail } from './process.ts'

export interface AcpAgentOptions {
  name: string
  command: string
  args: readonly string[]
  env: Record<string, string>
  /** Answer permission requests by picking the agent's "allow" option; otherwise they are rejected. */
  autoApprove: boolean
  idleMs: number
}

interface PermissionOption {
  optionId?: unknown
  kind?: unknown
}

/** The option to answer a permission request with: an allow option when approving, a reject one otherwise. */
export function pickPermissionOption(options: unknown, approve: boolean): string | undefined {
  if (!Array.isArray(options)) return undefined
  const list = options as PermissionOption[]
  const wanted = approve ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of wanted) {
    const match = list.find((option) => option.kind === kind && typeof option.optionId === 'string')
    if (match !== undefined) return match.optionId as string
  }
  return undefined
}

/** Folds one prompt's session/update notifications into the reply text and activity lines. Pure. */
export class AcpTurn {
  private text = ''
  private previousText = ''
  private readonly hooks: TurnHooks

  constructor(hooks: TurnHooks) {
    this.hooks = hooks
  }

  update(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: unknown; text?: unknown } | undefined
        if (content?.type === 'text' && typeof content.text === 'string') this.text += content.text
        return
      }
      case 'tool_call': {
        // Text before a tool call is a progress note; the answer is what follows the last call.
        if (this.text.trim() !== '') this.previousText = this.text
        this.text = ''
        const raw = update.rawInput !== null && typeof update.rawInput === 'object' ? (update.rawInput as Record<string, unknown>) : {}
        const detail = [raw.command, raw.file_path, raw.path, raw.pattern, raw.url, raw.query]
          .find((value): value is string => typeof value === 'string' && value !== '')
        const title = typeof update.title === 'string' && update.title !== '' ? update.title : String(update.kind ?? 'tool')
        this.hooks.onActivity(clip(detail === undefined || title.includes(detail) ? title : `${title}: ${detail}`, ACTIVITY_LINE_MAX))
        return
      }
      default:
        return
    }
  }

  reply(): string {
    return (this.text.trim() !== '' ? this.text : this.previousText).trim()
  }
}

type Reply = { result?: unknown; error?: { message?: unknown } }

/** One live agent process and its JSON-RPC plumbing. */
class AcpConnection {
  private nextId = 1
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly child: ChildProcess
  readonly closed: Promise<{ code: number | null; stderr: string }>
  alive = true
  sessionId: string | undefined
  canResume = false
  canLoad = false
  /** The turn currently consuming updates, if any. */
  turn: AcpTurn | undefined
  idleTimer: NodeJS.Timeout | undefined
  private readonly options: AcpAgentOptions

  constructor(options: AcpAgentOptions, cwd: string) {
    this.options = options
    const spawned = spawnLines({
      command: options.command,
      args: options.args,
      cwd,
      env: childEnv(options.env),
      keepStdin: true,
      onLine: (line) => this.receive(line),
    })
    this.child = spawned.child
    this.closed = spawned.closed
    void this.closed.then(({ code, stderr }) => {
      this.alive = false
      const tail = stderrTail(stderr)
      const message = `ACP agent "${options.name}" exited${code === null ? '' : ` with code ${code}`}${tail === '' ? '' : `: ${tail}`}`
      for (const [id, settle] of this.pending) {
        this.pending.delete(id)
        settle({ error: { message } })
      }
    })
  }

  private write(message: Record<string, unknown>): void {
    if (this.alive && this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private receive(line: string): void {
    const message = parseJson(line)
    if (message === undefined) return
    if (typeof message.method === 'string') {
      const params = message.params !== null && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : {}
      if (message.id === undefined) {
        if (message.method === 'session/update' && params.update !== null && typeof params.update === 'object') {
          this.turn?.update(params.update as Record<string, unknown>)
        }
        return
      }
      if (message.method === 'session/request_permission') {
        const optionId = pickPermissionOption(params.options, this.options.autoApprove)
        this.write({ id: message.id, result: { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } })
        return
      }
      // fs/* and terminal/* were not offered at initialize.
      this.write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
      return
    }
    if (typeof message.id === 'number') {
      const settle = this.pending.get(message.id)
      if (settle === undefined) return
      this.pending.delete(message.id)
      settle(message as Reply)
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.alive) throw new Error(`ACP agent "${this.options.name}" is not running`)
    const reply = await new Promise<Reply>((resolve) => {
      const id = this.nextId++
      this.pending.set(id, resolve)
      this.write({ id, method, params })
    })
    if (reply.error !== undefined) throw new Error(typeof reply.error.message === 'string' ? reply.error.message : `${method} failed`)
    return reply.result !== null && typeof reply.result === 'object' ? (reply.result as Record<string, unknown>) : {}
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  async initialize(): Promise<void> {
    const result = await this.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-native-runtimes', version: '0.1.0' },
    })
    const capabilities = result.agentCapabilities !== null && typeof result.agentCapabilities === 'object' ? (result.agentCapabilities as Record<string, unknown>) : {}
    this.canLoad = capabilities.loadSession === true
    const session = capabilities.sessionCapabilities
    this.canResume = session !== null && typeof session === 'object' && 'resume' in session
  }

  kill(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.child.stdin?.end()
    killGroup(this.child)
  }
}

export function acpDriver(options: AcpAgentOptions): RuntimeDriver {
  const connections = new Map<string, AcpConnection>()

  function drop(threadId: string) {
    const connection = connections.get(threadId)
    if (connection === undefined) return
    connections.delete(threadId)
    connection.kill()
  }

  /** A connection with an open session for this thread: the live one, or a new process that resumes or starts over. */
  async function connect(request: TurnRequest, hooks: TurnHooks): Promise<AcpConnection> {
    const existing = connections.get(request.threadId)
    if (existing?.alive && existing.sessionId !== undefined) return existing
    if (existing !== undefined) drop(request.threadId)
    const connection = new AcpConnection(options, request.cwd)
    connections.set(request.threadId, connection)
    await connection.initialize()
    if (request.sessionRef !== undefined && (connection.canResume || connection.canLoad)) {
      try {
        // session/load replays history as updates; no turn is attached yet, so they are dropped.
        await connection.call(connection.canResume ? 'session/resume' : 'session/load', { sessionId: request.sessionRef, cwd: request.cwd, mcpServers: [] })
        connection.sessionId = request.sessionRef
        return connection
      } catch (error) {
        hooks.onActivity(clip(`could not resume the earlier session (${error instanceof Error ? error.message : String(error)}); started a new one`, ACTIVITY_LINE_MAX))
      }
    } else if (request.sessionRef !== undefined) {
      hooks.onActivity('the agent was restarted and cannot resume sessions; started a new one without the earlier context')
    }
    const created = await connection.call('session/new', { cwd: request.cwd, mcpServers: [] })
    if (typeof created.sessionId !== 'string') throw new Error(`ACP agent "${options.name}" returned no session id`)
    connection.sessionId = created.sessionId
    hooks.onSessionRef(created.sessionId)
    return connection
  }

  return {
    id: `acp:${options.name}`,
    label: `${options.name} (an ACP agent: \`${[options.command, ...options.args].join(' ')}\`)`,
    runTurn(request: TurnRequest, hooks: TurnHooks): TurnHandle {
      let stopped = false
      let active: AcpConnection | undefined
      const turn = new AcpTurn(hooks)
      const done = (async (): Promise<TurnOutcome> => {
        try {
          const connection = await connect(request, hooks)
          active = connection
          if (stopped) return { ok: false, reply: '', error: 'stopped' }
          if (connection.idleTimer !== undefined) clearTimeout(connection.idleTimer)
          connection.turn = turn
          const result = await connection.call('session/prompt', { sessionId: connection.sessionId, prompt: [{ type: 'text', text: request.prompt }] })
          connection.turn = undefined
          connection.idleTimer = setTimeout(() => drop(request.threadId), options.idleMs)
          connection.idleTimer.unref()
          if (stopped || result.stopReason === 'cancelled') return { ok: false, reply: turn.reply(), error: 'stopped' }
          if (result.stopReason === 'refusal') return { ok: false, reply: turn.reply(), error: 'the agent refused the request' }
          return { ok: true, reply: turn.reply() }
        } catch (error) {
          if (active !== undefined) active.turn = undefined
          if (stopped) return { ok: false, reply: turn.reply(), error: 'stopped' }
          drop(request.threadId)
          return { ok: false, reply: turn.reply(), error: clip(error instanceof Error ? error.message : String(error), 600) }
        }
      })()
      return {
        done,
        stop() {
          if (stopped) return
          stopped = true
          const connection = connections.get(request.threadId)
          if (connection?.alive && connection.sessionId !== undefined) connection.notify('session/cancel', { sessionId: connection.sessionId })
          // An agent that ignores the cancel must not keep the turn open.
          setTimeout(() => {
            if (connections.get(request.threadId)?.turn === turn) drop(request.threadId)
          }, 3000).unref()
        },
      }
    },
    release: drop,
    dispose() {
      for (const threadId of [...connections.keys()]) drop(threadId)
    },
  }
}
