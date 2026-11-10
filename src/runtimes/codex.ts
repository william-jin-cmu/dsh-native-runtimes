/**
 * Codex, through the user's own `codex` CLI:
 *   codex exec --json --skip-git-repo-check -c sandbox_mode="..." [-m model] -          (first turn)
 *   codex exec resume --json --skip-git-repo-check -c sandbox_mode="..." <thread_id> -   (follow-up)
 * The prompt goes in on stdin (`-`). One process per turn. `resume` has no -s/-C flags, so the sandbox is set with
 * -c and the working directory is the process cwd for both forms.
 */
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVITY_LINE_MAX, clip, type RuntimeDriver, type TurnHandle, type TurnHooks, type TurnOutcome, type TurnRequest } from '../types.ts'
import { childEnv, killGroup, parseJson, spawnLines, stderrTail } from './process.ts'

export const CODEX_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access'] as const
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]

export interface CodexOptions {
  command: string
  model: string
  sandbox: CodexSandboxMode
}

/** One activity line for a finished or started item, or undefined for items that are not actions. */
export function codexItemLine(phase: 'started' | 'completed', item: Record<string, unknown>): string | undefined {
  const type = item.type
  if (type === 'command_execution') {
    if (phase === 'started') return clip(`$ ${String(item.command ?? '')}`, ACTIVITY_LINE_MAX)
    return typeof item.exit_code === 'number' && item.exit_code !== 0 ? `  exit ${item.exit_code}` : undefined
  }
  if (phase !== 'completed') return undefined
  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []
    return clip(`edit: ${changes.map((change) => `${String(change.kind ?? 'update')} ${String(change.path ?? '')}`).join(', ')}`, ACTIVITY_LINE_MAX)
  }
  if (type === 'mcp_tool_call') return clip(`mcp: ${String(item.server ?? '')}.${String(item.tool ?? '')}`, ACTIVITY_LINE_MAX)
  if (type === 'web_search') return clip(`search: ${String(item.query ?? '')}`, ACTIVITY_LINE_MAX)
  if (type === 'error') return clip(`error: ${String(item.message ?? '')}`, ACTIVITY_LINE_MAX)
  return undefined
}

/** Folds `codex exec --json` lines into a turn outcome. Pure. */
export class CodexStream {
  threadId: string | undefined
  outcome: TurnOutcome | undefined
  private messages: string[] = []
  private lastError = ''
  private readonly hooks: TurnHooks

  constructor(hooks: TurnHooks) {
    this.hooks = hooks
  }

  push(line: string): void {
    const event = parseJson(line)
    if (event === undefined) return
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string' && event.thread_id !== '') {
          this.threadId = event.thread_id
          this.hooks.onSessionRef(event.thread_id)
        }
        return
      case 'item.started':
      case 'item.completed': {
        const item = event.item
        if (item === null || typeof item !== 'object') return
        const record = item as Record<string, unknown>
        if (record.type === 'agent_message' && event.type === 'item.completed') {
          if (typeof record.text === 'string' && record.text.trim() !== '') {
            this.messages.push(record.text.trim())
            // Codex reports whole messages, so each one is shown as it lands.
            this.hooks.onBreak?.()
            this.hooks.onText?.(record.text.trim())
          }
          return
        }
        if (record.type === 'reasoning' && event.type === 'item.completed') {
          if (typeof record.text === 'string' && record.text.trim() !== '') this.hooks.onThinking?.(`${record.text.trim()}\n`)
          return
        }
        if (record.type === 'error' && typeof record.message === 'string') this.lastError = record.message
        const activity = codexItemLine(event.type === 'item.started' ? 'started' : 'completed', record)
        if (activity !== undefined) this.hooks.onActivity(activity)
        return
      }
      case 'turn.completed': {
        const usage = event.usage as Record<string, unknown> | undefined
        if (usage !== undefined && typeof usage.input_tokens === 'number') {
          const cached = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0
          this.hooks.onUsage?.({ inputTokens: Math.max(0, usage.input_tokens - cached), cacheReadTokens: cached, outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0 })
        }
        // Earlier agent messages are progress notes; the last one is the answer.
        this.outcome = { ok: true, reply: this.messages.at(-1) ?? '' }
        return
      }
      case 'turn.failed': {
        const message = (event.error as { message?: unknown } | undefined)?.message
        this.outcome = { ok: false, reply: this.messages.at(-1) ?? '', error: clip(typeof message === 'string' ? message : 'Codex turn failed', 600) }
        return
      }
      case 'error':
        if (typeof event.message === 'string') this.lastError = event.message
        return
      default:
        return
    }
  }

  finish(code: number | null, stderr: string): TurnOutcome {
    if (this.outcome !== undefined) return this.outcome
    const detail = this.lastError !== '' ? clip(this.lastError, 600) : stderrTail(stderr)
    return { ok: false, reply: this.messages.at(-1) ?? '', error: `Codex exited${code === null ? '' : ` with code ${code}`} before finishing${detail === '' ? '' : `: ${detail}`}` }
  }
}

export function codexArgs(options: CodexOptions, request: TurnRequest, imagePaths: readonly string[] = []): string[] {
  // A one-shot answer (a title, a summary) may read but never write.
  // -i takes several values, so each one sits in front of a flag that ends it.
  const common = [...imagePaths.flatMap((path) => ['-i', path]), '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${request.oneShot ? 'read-only' : options.sandbox}"`]
  const model = request.model ?? options.model
  if (model !== '') common.push('-m', model)
  if (request.oneShot) return ['exec', ...common, '--ephemeral', '-']
  return request.sessionRef === undefined ? ['exec', ...common, '-'] : ['exec', 'resume', ...common, request.sessionRef, '-']
}

export function codexDriver(options: CodexOptions): RuntimeDriver {
  const live = new Set<() => void>()
  return {
    id: 'codex',
    label: 'Codex (the `codex` CLI installed on this machine, with the user\'s own login and settings)',
    runTurn(request: TurnRequest, hooks: TurnHooks): TurnHandle {
      const stream = new CodexStream(hooks)
      // Codex takes pictures as files; they live only for the turn.
      const imagePaths = (request.oneShot ? [] : request.images ?? []).map((image) => {
        const path = join(tmpdir(), `dsh-ntr-${randomUUID()}.${image.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`)
        writeFileSync(path, image.data)
        return path
      })
      const { child, closed } = spawnLines({
        command: options.command,
        args: codexArgs(options, request, imagePaths),
        cwd: request.cwd,
        env: childEnv(),
        stdin: request.prompt,
        onLine: (line) => stream.push(line),
      })
      let stopped = false
      const stop = () => {
        stopped = true
        killGroup(child)
      }
      live.add(stop)
      const done = closed.then(({ code, stderr }): TurnOutcome => {
        live.delete(stop)
        for (const path of imagePaths) rmSync(path, { force: true })
        if (stopped) return { ok: false, reply: stream.outcome?.reply ?? '', error: 'stopped' }
        return stream.finish(code, stderr)
      })
      return { done, stop }
    },
    dispose() {
      for (const stop of [...live]) stop()
    },
  }
}
