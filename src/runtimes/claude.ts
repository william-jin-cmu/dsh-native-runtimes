/**
 * Claude Code, through the user's own `claude` CLI in print mode:
 *   claude -p --output-format stream-json --verbose [--resume <session>] [--model m] [--permission-mode mode]
 * The prompt goes in on stdin. One process per turn; a follow-up resumes the session id the first turn reported.
 */
import { ACTIVITY_LINE_MAX, clip, type RuntimeDriver, type TurnHandle, type TurnHooks, type TurnOutcome, type TurnRequest, type TurnUsage } from '../types.ts'
import { childEnv, killGroup, parseJson, spawnLines, stderrTail } from './process.ts'

export const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'default', 'plan', 'dontAsk', 'bypassPermissions'] as const
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]

export interface ClaudeOptions {
  command: string
  model: string
  permissionMode: ClaudePermissionMode
  /** Extra flags for streamed (session) turns. */
  sessionArgs?: readonly string[]
}

function usageOf(raw: unknown): TurnUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  return { inputTokens: count('input_tokens'), outputTokens: count('output_tokens'), cacheReadTokens: count('cache_read_input_tokens'), cacheWriteTokens: count('cache_creation_input_tokens') }
}

/** A tool call as one activity line: the tool name plus the argument that says what it touched. */
export function claudeToolLine(name: string, input: unknown): string {
  const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const detail = [args.command, args.file_path, args.path, args.pattern, args.url, args.query, args.description, args.prompt]
    .find((value): value is string => typeof value === 'string' && value !== '')
  return clip(detail === undefined ? name : `${name}: ${detail}`, ACTIVITY_LINE_MAX)
}

/** Folds stream-json lines into a turn outcome. Pure: feed it lines, read `outcome`. */
export class ClaudeStream {
  sessionId: string | undefined
  outcome: TurnOutcome | undefined
  private lastText = ''
  /** Whether the message being written has streamed any text, so its final form is not emitted a second time. */
  private streamed = false
  private lastUsage: TurnUsage | undefined
  private readonly hooks: TurnHooks

  constructor(hooks: TurnHooks) {
    this.hooks = hooks
  }

  push(line: string): void {
    const event = parseJson(line)
    if (event === undefined) return
    if (typeof event.session_id === 'string' && event.session_id !== '' && event.session_id !== this.sessionId) {
      this.sessionId = event.session_id
      this.hooks.onSessionRef(event.session_id)
    }
    // Partial output of the main conversation; a subagent's stream carries a parent tool id and is not shown.
    if (event.type === 'stream_event') {
      if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return
      const inner = event.event as { type?: unknown; delta?: { type?: unknown; text?: unknown; thinking?: unknown } } | undefined
      if (inner?.type === 'message_start') {
        this.streamed = false
        this.hooks.onBreak?.()
      } else if (inner?.type === 'content_block_delta') {
        if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
          this.streamed = true
          this.hooks.onText?.(inner.delta.text)
        } else if (inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string') {
          this.hooks.onThinking?.(inner.delta.thinking)
        }
      }
      return
    }
    if (event.type === 'assistant') {
      const message = event.message as { content?: unknown; usage?: unknown } | undefined
      const content = message?.content
      if (!Array.isArray(content)) return
      const main = event.parent_tool_use_id === null || event.parent_tool_use_id === undefined
      if (main) this.lastUsage = usageOf(message?.usage) ?? this.lastUsage
      const texts: string[] = []
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block.type === 'tool_use' && typeof block.name === 'string') this.hooks.onActivity(claudeToolLine(block.name, block.input))
      }
      if (texts.length > 0 && main) {
        this.lastText = texts.join('\n')
        // A CLI that sent no partial events still gets its text shown, one message at a time.
        if (!this.streamed && this.hooks.onText !== undefined) {
          this.hooks.onBreak?.()
          this.hooks.onText(this.lastText)
        }
      }
      return
    }
    if (event.type === 'result') {
      const total = usageOf(event.usage)
      if (this.lastUsage !== undefined || total !== undefined) {
        // Context size is the last call's input; output is what the whole turn wrote.
        this.hooks.onUsage?.({ ...(this.lastUsage ?? total!), outputTokens: total?.outputTokens ?? this.lastUsage!.outputTokens })
      }
      const text = typeof event.result === 'string' && event.result !== '' ? event.result : this.lastText
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
        const reason = typeof event.subtype === 'string' && event.subtype !== 'success' ? event.subtype.replace(/_/g, ' ') : 'error'
        this.outcome = { ok: false, reply: this.lastText, error: text !== '' && text !== this.lastText ? clip(text, 600) : `Claude Code stopped: ${reason}` }
      } else {
        this.outcome = { ok: true, reply: text }
      }
    }
  }

  /** What to report when the process ended without a `result` line. */
  finish(code: number | null, stderr: string): TurnOutcome {
    if (this.outcome !== undefined) return this.outcome
    const tail = stderrTail(stderr)
    return { ok: false, reply: this.lastText, error: `Claude Code exited${code === null ? '' : ` with code ${code}`} before finishing${tail === '' ? '' : `: ${tail}`}` }
  }
}

export function claudeArgs(options: ClaudeOptions, request: TurnRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  const model = request.model ?? options.model
  if (model !== '') args.push('--model', model)
  if (request.oneShot) {
    // A title or a summary: no tools to wander off with, and no session left behind.
    args.push('--tools', '', '--no-session-persistence')
    return args
  }
  args.push('--permission-mode', options.permissionMode)
  if (request.stream) args.push('--include-partial-messages', ...(options.sessionArgs ?? []))
  // Pictures cannot ride on a plain-text stdin; the JSON input form carries them.
  if (request.images !== undefined && request.images.length > 0) args.push('--input-format', 'stream-json')
  if (request.sessionRef !== undefined) args.push('--resume', request.sessionRef)
  return args
}

/** What goes on stdin: the prompt itself, or one JSON user message when it has pictures. */
export function claudeStdin(request: TurnRequest): string {
  if (request.images === undefined || request.images.length === 0 || request.oneShot) return request.prompt
  const content = [
    { type: 'text', text: request.prompt },
    ...request.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') } })),
  ]
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

export function claudeDriver(options: ClaudeOptions): RuntimeDriver {
  const live = new Set<() => void>()
  return {
    id: 'claude-code',
    label: 'Claude Code (the `claude` CLI installed on this machine, with the user\'s own login and settings)',
    runTurn(request: TurnRequest, hooks: TurnHooks): TurnHandle {
      const stream = new ClaudeStream(hooks)
      const { child, closed } = spawnLines({
        command: options.command,
        args: claudeArgs(options, request),
        cwd: request.cwd,
        // A host that itself runs under Claude Code must not make the child think it is nested.
        env: childEnv({}, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']),
        stdin: claudeStdin(request),
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
