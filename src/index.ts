/**
 * Native Third-party Runtimes: hand work to the agent runtimes the user already has on this machine.
 *
 * A thread is one conversation with Claude Code, Codex or an ACP agent, run through the user's own CLI and login.
 * The DSH agent starts it, gets a notice when a turn ends (which wakes it if it was idle), and can follow up on
 * the same thread with the earlier context intact. Threads are kept under $DSH_HOME/ntr so they outlive a restart.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { turnNotice } from './notice.ts'
import { acpDriver } from './runtimes/acp.ts'
import { CLAUDE_PERMISSION_MODES, claudeDriver, type ClaudePermissionMode } from './runtimes/claude.ts'
import { CODEX_SANDBOX_MODES, codexDriver, type CodexSandboxMode } from './runtimes/codex.ts'
import { findCommand } from './runtimes/process.ts'
import { NativeRuntimeAdapter, type SessionRuntime } from './session.ts'
import { ThreadError, ThreadManager } from './threads.ts'
import type { RuntimeDriver, Thread, Turn } from './types.ts'
import { providerUsage, type ProviderUsage } from './usage.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ntr-thread': { kind: 'ntr-thread' } & ContextFormed
  }
}

export const name = 'ntr'

export const inject = ['tools', 'agents']

interface AcpAgentConfig {
  command: string
  args: string[]
  env: Record<string, string>
  autoApprove: boolean
}

export interface Config {
  sessions: boolean
  claude: { command: string; model: string; permissionMode: ClaudePermissionMode; models: string[]; sessionArgs: string[] }
  codex: { command: string; model: string; sandbox: CodexSandboxMode; models: string[] }
  acp: Record<string, AcpAgentConfig>
  maxConcurrent: number
  turnTimeoutMinutes: number
  acpIdleMinutes: number
}

export const Config: Schema<Config> = Schema.object({
  sessions: Schema.boolean().default(true).description('Offer Claude Code and Codex in the model picker, so a session can be run by your own CLI instead of a DSH model.'),
  claude: Schema.object({
    command: Schema.string().default('').description('Path to the `claude` CLI. Empty looks on PATH and the usual install directories.'),
    model: Schema.string().default('').description('Model for Claude Code threads. Empty uses the CLI\'s own default.'),
    permissionMode: Schema.union([...CLAUDE_PERMISSION_MODES]).default('acceptEdits')
      .description('What Claude Code may do without asking. Its permission prompts cannot be answered from DSH, so anything not allowed is denied.'),
    models: Schema.array(Schema.string()).default(['opus', 'sonnet', 'haiku']).description('Models offered for Claude Code sessions besides the CLI\'s own default.'),
    sessionArgs: Schema.array(Schema.string()).default(['--thinking-display', 'summarized']).description('Extra `claude` flags for sessions. The default shows a summary of its thinking; clear it if your CLI rejects the flag.'),
  }),
  codex: Schema.object({
    command: Schema.string().default('').description('Path to the `codex` CLI. Empty looks on PATH and the usual install directories.'),
    model: Schema.string().default('').description('Model for Codex threads. Empty uses the CLI\'s own default.'),
    sandbox: Schema.union([...CODEX_SANDBOX_MODES]).default('workspace-write').description('Sandbox for the commands Codex runs.'),
    models: Schema.array(Schema.string()).default([]).description('Models offered for Codex sessions besides the CLI\'s own default.'),
  }),
  acp: Schema.dict(Schema.object({
    command: Schema.string().required().description('Executable that speaks the Agent Client Protocol on stdio.'),
    args: Schema.array(Schema.string()).default([]),
    env: Schema.dict(Schema.string()).default({}),
    autoApprove: Schema.boolean().default(true).description('Allow the agent\'s permission requests. Off rejects them.'),
  })).default({}).description('ACP agents, by name. Each becomes the runtime `acp:<name>`.'),
  maxConcurrent: Schema.number().min(1).max(16).default(4).description('How many threads may run a turn at the same time.'),
  turnTimeoutMinutes: Schema.number().min(1).default(60).description('A turn running longer than this is stopped.'),
  acpIdleMinutes: Schema.number().min(1).default(15).description('How long an idle ACP agent process is kept for follow-ups.'),
})

/** The slices of the host context this plugin uses. */
interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session?: { readonly header?: { readonly cwd?: string } }
  followup(message: unknown): void
  inject(message: unknown): void
}
/** `tools` and `agents` as this plugin calls them; the host's own types are stricter than these slices need. */
type HostContext = Context & {
  tools: { register(tool: unknown): unknown }
  agents: { get(id: string): AgentLike | undefined; list?(): readonly AgentLike[] }
  llm?: { registerAdapter(providers: string[], adapter: unknown): () => void }
}
interface ToolExec {
  readonly agent?: AgentLike
}

const READ_ACTIVITY_LINES = 40

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 129_600) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

function lastTurn(thread: Thread): Turn | undefined {
  return thread.turns.at(-1)
}

function threadRow(thread: Thread) {
  const turn = lastTurn(thread)
  return {
    id: thread.id,
    runtime: thread.runtime,
    title: thread.title,
    status: thread.status,
    cwd: thread.cwd,
    turns: thread.turns.length,
    updatedAt: thread.updatedAt,
    ...(thread.pending !== undefined ? { queued: true } : {}),
    ...(turn?.error !== undefined && thread.status !== 'stopped' ? { error: turn.error } : {}),
  }
}

const JSON_OUTPUT = { type: 'json' } as const
const text = (value: string) => [{ type: 'text' as const, text: value }]

function usageText(report: ProviderUsage): string {
  const title = report.provider === 'claude' ? 'Claude' : 'Codex'
  if (report.status === 'signedOut') return `${title}: not signed in with a subscription on this machine.`
  if (report.status === 'expired') return `${title}: the stored login has expired; opening the CLI refreshes it.`
  if (report.status === 'error') return `${title}: ${report.error ?? 'unavailable'}`
  const head = `${title}${report.plan ? ` (${report.plan})` : ''}${report.account ? `, ${report.account}` : ''}`
  const lines = report.windows.map((window) => {
    const used = window.usedPct === null ? 'usage unknown' : `${Math.round(window.usedPct)}% used, ${Math.max(0, 100 - Math.round(window.usedPct))}% left`
    return `- ${window.label}: ${used}${window.resetsAt ? `, resets ${window.resetsAt}` : ''}`
  })
  return [head, ...lines, ...report.details.map((detail) => `- ${detail.label}: ${detail.value}`)].join('\n')
}

export function apply(context: Context, config: Config) {
  const ctx = context as unknown as HostContext
  const drivers: RuntimeDriver[] = []
  const sessionRuntimes: SessionRuntime[] = []
  const claude = findCommand('claude', config.claude.command)
  if (claude !== undefined) {
    const driver = claudeDriver({ command: claude, model: config.claude.model, permissionMode: config.claude.permissionMode, sessionArgs: config.claude.sessionArgs })
    drivers.push(driver)
    sessionRuntimes.push({
      provider: 'claude-cli',
      name: 'Claude Code',
      driver,
      models: [{ id: 'default', name: 'Claude Code', description: 'Your claude CLI, on the model it is set to' }, ...config.claude.models.map((id) => ({ id, name: `Claude Code · ${id}` }))],
      auxModel: 'haiku',
      contextWindow: 200_000,
    })
  } else if (config.claude.command !== '') ctx.logger.warn('claude command "%s" was not found', config.claude.command)
  const codex = findCommand('codex', config.codex.command)
  if (codex !== undefined) {
    const driver = codexDriver({ command: codex, model: config.codex.model, sandbox: config.codex.sandbox })
    drivers.push(driver)
    sessionRuntimes.push({
      provider: 'codex-cli',
      name: 'Codex',
      driver,
      models: [{ id: 'default', name: 'Codex', description: 'Your codex CLI, on the model it is set to' }, ...config.codex.models.map((id) => ({ id, name: `Codex · ${id}` }))],
      auxModel: '',
      contextWindow: 272_000,
    })
  } else if (config.codex.command !== '') ctx.logger.warn('codex command "%s" was not found', config.codex.command)

  // Session mode: each installed CLI becomes a provider in the model picker.
  if (config.sessions && sessionRuntimes.length > 0) {
    ctx.inject(['llm'], (scope) => {
      const adapter = new NativeRuntimeAdapter({
        runtimes: sessionRuntimes,
        cwdOf: (sessionId) => ctx.agents.get(sessionId)?.session?.header?.cwd,
        readImage: async (attachment, signal) => {
          const store = ctx.get('attachments' as never) as { readImage(ref: unknown, signal?: AbortSignal): Promise<{ ref: { mediaType: string }; data: Uint8Array }> } | undefined
          if (store === undefined) return undefined
          const stored = await store.readImage(attachment, signal)
          return { mediaType: stored.ref.mediaType, data: stored.data }
        },
        stateDir: join(dshHome(), 'ntr', 'sessions'),
        log: (message) => ctx.logger.info(message),
      })
      try {
        const release = (scope as HostContext).llm!.registerAdapter(sessionRuntimes.map((runtime) => runtime.provider), adapter)
        scope.effect(() => release, 'ntr: session providers')
        ctx.logger.info('session models: %s', sessionRuntimes.map((runtime) => runtime.name).join(', '))
      } catch (error) {
        ctx.logger.warn('could not offer session models: %s', error instanceof Error ? error.message : String(error))
      }
    })
  }
  for (const [agentName, agent] of Object.entries(config.acp)) {
    const command = findCommand(agent.command, agent.command)
    if (command === undefined) {
      ctx.logger.warn('ACP agent "%s": command "%s" was not found', agentName, agent.command)
      continue
    }
    drivers.push(acpDriver({ name: agentName, command, args: agent.args, env: agent.env, autoApprove: agent.autoApprove, idleMs: config.acpIdleMinutes * 60_000 }))
  }

  const manager = new ThreadManager({
    dir: join(dshHome(), 'ntr', 'threads'),
    maxConcurrent: config.maxConcurrent,
    turnTimeoutMs: config.turnTimeoutMinutes * 60_000,
    onTurnEnd(thread, turn) {
      // A thread the agent stopped itself needs no notice; the tool call already told it.
      if (thread.status === 'stopped' || thread.ownerSessionId === undefined) return
      const owner = ctx.agents.get(thread.ownerSessionId)
      if (owner === undefined) return
      const notice = turnNotice(thread, turn)
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: notice.text }],
          source: { kind: 'ntr-thread', form: 'notice', summary: boundContextSummary(notice.summary) },
        })
        if (owner.status === 'idle') owner.followup(message)
        else owner.inject(message)
      } catch (error) {
        ctx.logger.warn('could not deliver the notice for thread %s: %s', thread.id, error instanceof Error ? error.message : String(error))
      }
    },
  }, drivers)
  ctx.effect(() => () => manager.dispose(), 'ntr: stop running threads')

  const available = drivers.map((driver) => `- \`${driver.id}\`: ${driver.label}`).join('\n')
  const runtimeHelp = drivers.length === 0
    ? 'No runtime is available right now: neither `claude` nor `codex` was found on this machine and no ACP agent is configured.'
    : `Runtimes available on this machine:\n${available}`

  /** Thread tools report expected failures (unknown id, busy, no capacity) as a readable error result. */
  const guarded = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      if (error instanceof ThreadError) throw new Error(error.message)
      throw error
    }
  }

  ctx.tools.register(defineTool({
    name: 'thread_start',
    description: `Start a thread: hand a task to another agent runtime installed on this machine (it uses the user's own CLI, login and settings, and works in the given directory). Returns at once with a thread id; the work continues in the background and you get a notice with the reply when the turn ends, so do not poll. The thread cannot see this conversation: put everything it needs in \`task\`. Use it, not a subagent tool, when the user asks for one of these runtimes by name (a subagent is another DSH agent, not Claude Code or Codex); also for long or parallel work the user wants done by them.\n\n${runtimeHelp}`,
    parameters: {
      runtime: { type: 'string', required: true, description: 'Which runtime runs the thread; one of the ids listed above.' },
      task: { type: 'string', required: true, description: 'The full, self-contained task for the thread.' },
      title: { type: 'string', description: 'A few words naming the thread.' },
      cwd: { type: 'string', description: 'Absolute directory the thread works in. Defaults to this session\'s directory.' },
      model: { type: 'string', description: 'Model for the thread, only when the user named one. Not used by ACP agents.' },
    },
    output: {
      schema: JSON_OUTPUT,
      render: (_args, value) => {
        const thread = value as { id: string; runtime: string; cwd: string }
        return text(`Started thread ${thread.id} on ${thread.runtime} in ${thread.cwd}. A notice arrives when its turn ends.`)
      },
    },
    async execute(args, exec: ToolExec) {
      return guarded(() => {
        if (args.task.trim() === '') throw new ThreadError('`task` is empty.')
        const base = exec.agent?.session?.header?.cwd ?? process.cwd()
        const cwd = args.cwd === undefined || args.cwd.trim() === '' ? base : isAbsolute(args.cwd) ? args.cwd : resolve(base, args.cwd)
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ThreadError(`"${cwd}" is not a directory.`)
        const thread = manager.start({ runtime: args.runtime.trim(), task: args.task, title: args.title, cwd, model: args.model?.trim() || undefined, ownerSessionId: exec.agent?.id })
        return { id: thread.id, runtime: thread.runtime, title: thread.title, cwd: thread.cwd, status: thread.status }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thread_send',
    description: 'Send a follow-up or correction to an existing thread. It continues the same conversation, so the thread still knows what it did before. If the thread is in the middle of a turn, the message waits and runs next (one message can wait; a second is refused). A notice arrives when the turn ends.',
    parameters: {
      thread_id: { type: 'string', required: true, description: 'The thread id, e.g. t-1a2b3c.' },
      message: { type: 'string', required: true, description: 'What to tell the thread.' },
    },
    output: {
      schema: JSON_OUTPUT,
      render: (_args, value) => {
        const result = value as { id: string; queued: boolean }
        return text(result.queued
          ? `Thread ${result.id} is mid-turn; the message is queued and runs when that turn ends.`
          : `Sent to thread ${result.id}. A notice arrives when its turn ends.`)
      },
    },
    async execute(args, exec: ToolExec) {
      return guarded(() => {
        if (args.message.trim() === '') throw new ThreadError('`message` is empty.')
        const { thread, queued } = manager.send(args.thread_id, args.message, exec.agent?.id)
        return { id: thread.id, queued, status: thread.status }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thread_list',
    description: 'List the threads started on this machine (newest activity first): id, runtime, title, status, and how many turns each has had. Includes threads from earlier DSH sessions.',
    parameters: {},
    output: {
      schema: JSON_OUTPUT,
      render: (_args, value) => {
        const rows = (value as { threads: ReturnType<typeof threadRow>[] }).threads
        if (rows.length === 0) return text('No threads yet.')
        return text(rows.map((row) => `${row.id}  ${row.status}${row.queued ? ' (+1 queued)' : ''}  ${row.runtime}  "${row.title}"  ${row.turns} turn${row.turns === 1 ? '' : 's'}, ${ago(row.updatedAt)}  ${row.cwd}${row.error ? `\n    last error: ${row.error}` : ''}`).join('\n'))
      },
    },
    async execute() {
      return { threads: manager.list().map(threadRow) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thread_read',
    description: 'Read one thread: its task, status, and the full latest reply. With `activity`, also the recent tool calls and commands the runtime ran. Use it for a reply that was cut in a notice or to see what a running thread is doing; do not poll with it.',
    parameters: {
      thread_id: { type: 'string', required: true, description: 'The thread id.' },
      activity: { type: 'boolean', description: 'Also include what the runtime did in the latest turn.' },
    },
    output: {
      schema: JSON_OUTPUT,
      render: (args, value) => {
        const thread = value as unknown as Thread
        const first = thread.turns[0]
        const turn = lastTurn(thread)
        const lines = [
          `Thread ${thread.id} (${thread.runtime}) "${thread.title}": ${thread.status}${thread.pending !== undefined ? ', one message queued' : ''}`,
          `Directory: ${thread.cwd}`,
          `Turns: ${thread.turns.length}, last activity ${ago(thread.updatedAt)}`,
          '',
          `Task:\n${first?.prompt ?? ''}`,
        ]
        if (turn !== undefined && turn !== first) lines.push('', `Latest message to it:\n${turn.prompt}`)
        if (turn?.error !== undefined) lines.push('', thread.status === 'stopped' ? 'Latest turn was stopped before it finished.' : `Latest turn did not finish: ${turn.error}`)
        const replied = [...thread.turns].reverse().find((entry) => entry.reply !== undefined)
        if (replied !== undefined) lines.push('', `${replied === turn ? 'Latest reply' : 'Last reply (from an earlier turn)'}:\n${replied.reply}`)
        else if (thread.status === 'running') lines.push('', 'No reply yet; the first turn is still running.')
        if (args.activity === true && turn !== undefined) {
          const recent = turn.activity.slice(-READ_ACTIVITY_LINES)
          lines.push('', recent.length === 0 ? 'No tool calls in the latest turn.' : `Activity in the latest turn${turn.activity.length > recent.length ? ` (last ${recent.length} of ${turn.activity.length})` : ''}:\n${recent.join('\n')}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      return guarded(() => JSON.parse(JSON.stringify(manager.get(args.thread_id))) as never)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thread_stop',
    description: 'Interrupt a thread\'s running turn and kill what it started. The thread stays and can be continued later with thread_send.',
    parameters: {
      thread_id: { type: 'string', required: true, description: 'The thread id.' },
    },
    output: {
      schema: JSON_OUTPUT,
      render: (_args, value) => {
        const result = value as { id: string; stopped: boolean }
        return text(result.stopped ? `Stopped thread ${result.id}.` : `Thread ${result.id} was not running.`)
      },
    },
    async execute(args) {
      return guarded(() => {
        const thread = manager.get(args.thread_id)
        return { id: thread.id, stopped: manager.stop(thread.id) }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'runtime_usage',
    description: 'How much of the user\'s Claude and Codex subscription quota is used and when each limit resets (the same numbers the CLIs show under /usage). Read-only. Use it when the user asks about remaining quota, or before starting heavy work on one of those runtimes.',
    parameters: {
      refresh: { type: 'boolean', description: 'Skip the two-minute cache.' },
    },
    output: {
      schema: JSON_OUTPUT,
      render: (_args, value) => text((value as unknown as { providers: ProviderUsage[] }).providers.map(usageText).join('\n\n')),
    },
    async execute(args) {
      return (await providerUsage(args.refresh === true)) as never
    },
  }))
}
