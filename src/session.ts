/**
 * Session mode: Claude Code and Codex as models you pick for a DSH session.
 *
 * DSH asks a model for one reply at a time. Here the "model" is a whole agent: each reply is one turn of the user's
 * own CLI, resumed on the runtime's own conversation, in the session's folder. The runtime keeps its own context,
 * tools, instructions and permissions, so of a DSH request only the user's new message is passed on; DSH's system
 * prompt and tools are not. What the runtime does on the way (commands, edits, searches) is shown as reasoning,
 * and its answer as the reply.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RuntimeDriver, TurnImage, TurnOutcome, TurnUsage } from './types.ts'

export interface SessionRuntime {
  /** Provider id shown to DSH. */
  provider: string
  /** Name in the model picker. */
  name: string
  driver: RuntimeDriver
  /** Models offered; `default` is the CLI's own choice. */
  models: readonly { id: string; name: string; description?: string }[]
  /** Model for titles and summaries; empty uses the session's. */
  auxModel: string
  contextWindow: number
}

export interface SessionDeps {
  runtimes: readonly SessionRuntime[]
  /** Folder of a DSH session, when it is known. */
  cwdOf(sessionId: string): string | undefined
  /** Bytes of an image attached to a message; absent when the host has no attachment store. */
  readImage?(attachment: unknown, signal?: AbortSignal): Promise<TurnImage | undefined>
  /** Directory for the runtime conversation id of each DSH session. */
  stateDir: string
  log(message: string): void
}

/** How much of an earlier conversation is retold to a runtime that was not there for it. */
const PREFACE_MAX_CHARS = 12_000

type Block = { type?: string; text?: string; name?: string; attachment?: unknown }
type AnyMessage = { role: string; content: readonly Block[]; source?: { kind?: string } }

export function messageText(message: AnyMessage): string {
  return message.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : block.type === 'image' ? '[image]' : ''))
    .filter((text) => text !== '')
    .join('\n')
    .trim()
}

/**
 * What to send the runtime for this request: the user's messages since the last reply. Context that DSH or other
 * plugins add as user-role messages is left out, unless nothing else is new (a turn started by a notice).
 */
export function newInput(messages: readonly AnyMessage[]): { text: string; attachments: readonly unknown[]; earlier: readonly AnyMessage[] } {
  let start = messages.length
  while (start > 0 && messages[start - 1]!.role === 'user') start -= 1
  const fresh = messages.slice(start)
  const typed = fresh.filter((message) => message.source === undefined || message.source.kind === 'user')
  const sent = typed.length > 0 ? typed : fresh
  const text = sent.map(messageText).filter((part) => part !== '').join('\n\n')
  const attachments = sent.flatMap((message) => message.content.filter((block) => block.type === 'image' && block.attachment !== undefined).map((block) => block.attachment))
  return { text, attachments, earlier: messages.slice(0, start) }
}

/** The conversation so far, for a runtime joining a session that began on another model. */
export function preface(earlier: readonly AnyMessage[]): string {
  const lines: string[] = []
  for (const message of earlier) {
    if (message.role === 'user' && message.source !== undefined && message.source.kind !== 'user') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = messageText(message)
    if (text !== '') lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  if (lines.length === 0) return ''
  const joined = lines.join('\n\n')
  const tail = joined.length > PREFACE_MAX_CHARS ? `…${joined.slice(-PREFACE_MAX_CHARS)}` : joined
  return `This conversation began with another assistant. What was said so far:\n\n${tail}\n\n---\n\nThe user's new message:\n\n`
}

/** A request that is not a session turn (a title, a summary, a plugin's own call), as one prompt. */
export function flatPrompt(options: Pick<GenerateOptions, 'system' | 'messages'>): string {
  const parts: string[] = []
  if (options.system) parts.push(options.system)
  for (const message of options.messages as readonly AnyMessage[]) {
    const text = messageText(message)
    if (text === '') continue
    parts.push(message.role === 'system' ? text : `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`)
  }
  return parts.join('\n\n')
}

interface SessionState {
  provider: string
  /** The runtime's own conversation id. */
  ref: string
}

class StateStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  get(sessionId: string): SessionState | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file(sessionId), 'utf8')) as Partial<SessionState>
      return typeof value.provider === 'string' && typeof value.ref === 'string' ? { provider: value.provider, ref: value.ref } : undefined
    } catch {
      return undefined
    }
  }

  set(sessionId: string, state: SessionState): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(sessionId), JSON.stringify(state))
  }
}

type Piece = { kind: 'text' | 'reasoning'; text: string } | { kind: 'usage'; usage: TurnUsage } | { kind: 'end'; outcome: TurnOutcome }

/** Callbacks in, an async stream out. */
class Channel {
  private readonly items: Piece[] = []
  private wake: (() => void) | undefined

  push(piece: Piece): void {
    this.items.push(piece)
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Piece> {
    for (;;) {
      while (this.items.length > 0) {
        const piece = this.items.shift()!
        yield piece
        if (piece.kind === 'end') return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}

/** A resume that failed because the runtime no longer has the conversation. */
function lostConversation(outcome: TurnOutcome): boolean {
  return !outcome.ok && /no conversation found|session .*not found|no rollout found|thread .*not found/i.test(outcome.error ?? '')
}

export class NativeRuntimeAdapter extends LlmAdapter {
  private readonly deps: SessionDeps
  private readonly store: StateStore

  constructor(deps: SessionDeps) {
    super()
    this.deps = deps
    this.store = new StateStore(deps.stateDir)
  }

  private runtime(provider: string): SessionRuntime {
    const runtime = this.deps.runtimes.find((entry) => entry.provider === provider)
    if (runtime === undefined) throw new Error(`dsh-native-runtimes has no runtime for provider "${provider}"`)
    return runtime
  }

  /** Pictures can be passed on only when the host lets this plugin read them. */
  private modalities(): readonly ('text' | 'image')[] {
    return this.deps.readImage === undefined ? ['text'] : ['text', 'image']
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.runtime(provider).name }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const runtime = this.runtime(provider)
    return Promise.resolve(runtime.models.map((model) => ({ provider, id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}), inputModalities: this.modalities() })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const runtime = this.runtime(provider)
    const known = runtime.models.find((entry) => entry.id === model)
    return Promise.resolve({ provider, id: model, name: known?.name ?? model, inputModalities: this.modalities(), context: { contextWindow: runtime.contextWindow } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const runtime = this.runtime(options.provider)
    const model = options.model === 'default' || options.model === '' ? undefined : options.model
    const sessionId = options.purpose === undefined ? options.sessionId : undefined

    if (sessionId === undefined) {
      const aux = runtime.auxModel !== '' ? runtime.auxModel : model
      yield* this.run(runtime, options, { threadId: 'one-shot', cwd: tmpdir(), prompt: flatPrompt(options), ...(aux ? { model: aux } : {}), oneShot: true })
      return
    }

    const { text, attachments, earlier } = newInput(options.messages as readonly AnyMessage[])
    if (text === '') throw new Error(`${runtime.name}: there is no new message to send`)
    const images: TurnImage[] = []
    for (const attachment of attachments) {
      const image = await this.deps.readImage?.(attachment, options.signal).catch(() => undefined)
      if (image !== undefined) images.push(image)
    }
    const cwd = this.deps.cwdOf(sessionId) ?? process.cwd()
    const state = this.store.get(sessionId)
    const ref = state !== undefined && state.provider === runtime.provider ? state.ref : undefined
    const onRef = (next: string) => this.store.set(sessionId, { provider: runtime.provider, ref: next })
    const fresh = { threadId: sessionId, cwd, prompt: `${preface(earlier)}${text}`, ...(model ? { model } : {}), ...(images.length > 0 ? { images } : {}), stream: true }

    if (ref === undefined) {
      yield* this.run(runtime, options, fresh, onRef)
      return
    }
    // Resume the runtime's own conversation. If it is gone (cleared history, another machine), start over and
    // retell what DSH has of it.
    let lost = false
    for await (const chunk of this.run(runtime, options, { ...fresh, prompt: text, sessionRef: ref }, onRef, () => { lost = true })) yield chunk
    if (lost) {
      this.deps.log(`${runtime.name} no longer has conversation ${ref}; starting a new one for session ${sessionId}`)
      yield* this.run(runtime, options, fresh, onRef)
    }
  }

  /**
   * One CLI turn as stream chunks. `onLost` is called, and nothing is emitted, when a resumed conversation turned
   * out to be missing before the runtime produced anything.
   */
  private async *run(
    runtime: SessionRuntime,
    options: GenerateOptions,
    request: Parameters<RuntimeDriver['runTurn']>[0],
    onRef?: (ref: string) => void,
    onLost?: () => void,
  ): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted()
    const channel = new Channel()
    let lastKind: 'text' | 'reasoning' | undefined
    let needBreak = false
    const handle = runtime.driver.runTurn(request, {
      onSessionRef: (ref) => onRef?.(ref),
      onActivity: (line) => {
        channel.push({ kind: 'reasoning', text: `▸ ${line}\n` })
        lastKind = 'reasoning'
      },
      onThinking: (delta) => {
        channel.push({ kind: 'reasoning', text: delta })
        lastKind = 'reasoning'
      },
      onBreak: () => {
        needBreak = true
      },
      onText: (delta) => {
        // Two messages in a row with no tool call between them still read as two paragraphs.
        channel.push({ kind: 'text', text: needBreak && lastKind === 'text' ? `\n\n${delta}` : delta })
        needBreak = false
        lastKind = 'text'
      },
      onUsage: (usage) => channel.push({ kind: 'usage', usage }),
    })
    const abort = () => handle.stop()
    options.signal?.addEventListener('abort', abort, { once: true })
    void handle.done.then((outcome) => channel.push({ kind: 'end', outcome }))

    let index = -1
    let open: { kind: 'text' | 'reasoning'; text: string } | undefined
    let wroteText = false
    let usage: TurnUsage | undefined
    const close = function* (): Generator<StreamChunk> {
      if (open === undefined) return
      yield { type: 'block-end', index, block: { type: open.kind, text: open.text } } as StreamChunk
      open = undefined
    }
    const write = function* (kind: 'text' | 'reasoning', text: string): Generator<StreamChunk> {
      if (text === '') return
      if (open === undefined || open.kind !== kind) {
        yield* close()
        index += 1
        open = { kind, text: '' }
        yield { type: 'block-start', index, blockType: kind }
      }
      open.text += text
      yield kind === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text }
    }

    try {
      for await (const piece of channel) {
        if (piece.kind === 'usage') {
          usage = piece.usage
        } else if (piece.kind === 'end') {
          const outcome = piece.outcome
          options.signal?.throwIfAborted()
          if (onLost !== undefined && index === -1 && lostConversation(outcome)) {
            onLost()
            return
          }
          if (!wroteText && outcome.reply !== '') yield* write('text', outcome.reply)
          yield* close()
          if (!outcome.ok) throw new Error(`${runtime.name}: ${outcome.error ?? 'the turn failed'}`)
          if (usage !== undefined) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
              },
            }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } else {
          if (piece.kind === 'text') wroteText = true
          yield* write(piece.kind, piece.text)
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      // A consumer that stopped reading (an abort, an error upstream) must not leave the CLI running.
      handle.stop()
    }
  }
}
