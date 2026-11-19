// A background task's report as the page reads it back from its words (lesson
// 17, ADR 0018). The kernel's `reportText` writes them, and is the one source
// of them here: the words are taken from a report it builds, so a change of
// the kernel's words changes what is read, and Echo and the chat know a report
// only by those exact words. Echo reads past every host note, and a report
// starts with one, so it must know a report before it reads anything else.
import { SessionId } from "@xandreed/core"
import { reportText, TaskId } from "@xandreed/sdk"
import type { TaskOutcome } from "@xandreed/sdk"

/** What a report's words say: the task, how it ended, and its answer or why it failed, as the task gave it. */
export interface ReportRead {
  readonly task: string
  readonly outcome: TaskOutcome
  readonly text: string
}

/** A text no answer holds, to cut the kernel's words around. */
const MARK = "\u0000answer\u0000"

/** The kernel's words for a report of `outcome`, cut where the task's id and its answer go. */
const wordsOf = (outcome: TaskOutcome) => {
  const whole = reportText({ task: TaskId.make("t1"), parent: SessionId.make("parent"), session: SessionId.make("session"), outcome, text: MARK })
  const id = whole.indexOf("t1")
  const answer = whole.indexOf(MARK)
  return { head: whole.slice(0, id), middle: whole.slice(id + 2, answer), tail: whole.slice(answer + MARK.length) }
}

const WORDS = (["Finished", "Failed"] as const).map((outcome) => ({ outcome, ...wordsOf(outcome) }))

/** A report read from its words, or none when the text is no report the kernel wrote. */
export const reportIn = (text: string): ReportRead | undefined => {
  for (const { outcome, head, middle, tail } of WORDS) {
    if (!text.startsWith(head) || !text.endsWith(tail)) continue
    const task = /^t[1-9][0-9]*/.exec(text.slice(head.length))?.[0]
    if (task === undefined) continue
    const rest = text.slice(head.length + task.length)
    if (rest.startsWith(middle) && rest.length >= middle.length + tail.length) return { task, outcome, text: rest.slice(middle.length, rest.length - tail.length) }
  }
  return undefined
}
