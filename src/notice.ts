/** The message a thread's owner gets when a turn ends. */
import type { Thread, Turn } from './types.ts'

const NOTICE_REPLY_MAX = 4000

/** Text for the model plus a one-line summary for the transcript. */
export function turnNotice(thread: Pick<Thread, 'id' | 'runtime' | 'title'>, turn: Turn): { text: string; summary: string } {
  const head = `Thread ${thread.id} (${thread.runtime}, "${thread.title}")`
  if (turn.error !== undefined) {
    const partial = turn.reply ? `\n\nWhat it said before stopping:\n${turn.reply.slice(0, NOTICE_REPLY_MAX)}` : ''
    return {
      text: `${head} did not finish its turn: ${turn.error}.${partial}\n\nthread_read ${thread.id} shows what it did; thread_send ${thread.id} tries again or redirects it.`,
      summary: `Thread ${thread.id} failed: ${turn.error}`,
    }
  }
  const reply = turn.reply ?? ''
  const body = reply === '' ? '(It finished without a text reply.)' : reply.slice(0, NOTICE_REPLY_MAX)
  const more = reply.length > NOTICE_REPLY_MAX ? `\n\n[Reply cut at ${NOTICE_REPLY_MAX} characters; thread_read ${thread.id} has all of it.]` : ''
  return {
    text: `${head} finished its turn. Its reply:\n\n${body}${more}\n\nthread_send ${thread.id} continues the same conversation.`,
    summary: `Thread ${thread.id} "${thread.title}" finished`,
  }
}
