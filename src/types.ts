/** Shared shapes: a thread, its turns, and what a runtime driver has to do. */

/** `claude-code`, `codex`, or `acp:<name>` for an ACP agent declared in config. */
export type RuntimeId = string

export type ThreadStatus = 'running' | 'idle' | 'failed' | 'stopped' | 'interrupted'

export interface Turn {
  prompt: string
  startedAt: number
  endedAt?: number
  /** The runtime's final answer for this turn. */
  reply?: string
  error?: string
  /** What the runtime did, one short line per tool call or command, oldest first. */
  activity: string[]
}

export interface Thread {
  id: string
  runtime: RuntimeId
  title: string
  cwd: string
  model?: string
  status: ThreadStatus
  /** The runtime's own conversation id; what a follow-up resumes. */
  sessionRef?: string
  /** DSH session that started (or last messaged) the thread; it gets the completion notice. */
  ownerSessionId?: string
  createdAt: number
  updatedAt: number
  turns: Turn[]
  /** One follow-up waiting for the running turn to finish. */
  pending?: string
}

export interface TurnOutcome {
  ok: boolean
  reply: string
  error?: string
}

export interface TurnUsage {
  /** Uncached input of the turn's last model call. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface TurnHooks {
  onActivity(line: string): void
  onSessionRef(ref: string): void
  /** The answer as it is written. A driver that cannot stream calls it once per finished message. */
  onText?(delta: string): void
  /** The runtime's reasoning, when it shows any. */
  onThinking?(delta: string): void
  /** A new message begins: what follows is not a continuation of the text before it. */
  onBreak?(): void
  onUsage?(usage: TurnUsage): void
}

export interface TurnRequest {
  threadId: string
  cwd: string
  prompt: string
  model?: string
  /** Set on follow-ups. */
  sessionRef?: string
  /** Pictures that go with the prompt. */
  images?: readonly TurnImage[]
  /** Ask the runtime for partial output (`onText` / `onThinking`); a live session wants it, a thread does not. */
  stream?: boolean
  /** One answer with no tools and nothing kept: a title, a summary. */
  oneShot?: boolean
}

export interface TurnImage {
  /** `image/png`, `image/jpeg`, … */
  mediaType: string
  data: Uint8Array
}

export interface TurnHandle {
  readonly done: Promise<TurnOutcome>
  /** Ends the turn and kills what it spawned. Idempotent. */
  stop(): void
}

export interface RuntimeDriver {
  readonly id: RuntimeId
  /** One line for tool descriptions and thread_list. */
  readonly label: string
  runTurn(request: TurnRequest, hooks: TurnHooks): TurnHandle
  /** Forget per-thread state (a kept-alive process). */
  release?(threadId: string): void
  /** Kill everything this driver still owns. */
  dispose?(): void
}

export const ACTIVITY_LINE_MAX = 300

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
