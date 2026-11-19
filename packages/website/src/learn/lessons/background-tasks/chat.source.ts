// Lesson 17's chat.ts: lesson 1's chat, with one queue for what comes into
// the conversation (ADR 0018). A message you send and a task's report wait in
// it together, in the order they came: the program takes one at a time
// (`inputs`), and `drain` takes the messages waiting and leaves the reports,
// so a report gets a turn of its own and never joins a turn that runs. The
// page hands the chat a report through the pane, as it hands it a message:
// main's `reportsOn(pane)`. The text is derived from lesson 1's by named
// pieces; program.test.ts checks that lesson 1's text holds each, and
// compiles and runs this one. The page shows it read-only: its own chat
// (learn/runtime.ts) is the same queue over its pane.
import { replaced } from "../base/agent.source.ts"
import { CHAT as LESSON_1_CHAT } from "../tools/chat.source.ts"

/** What this lesson replaces in lesson 1's chat.ts, as `[from, to]`. Each `from` is in lesson 1's text once. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  ['import { Context, Effect, Layer, Queue, Stream } from "effect"', 'import { Context, Effect, Exit, Layer, Queue, Stream } from "effect"'],
  [
    'import type { SessionId } from "@xandreed/core"\n',
    `import type { SessionId } from "@xandreed/core"
import type { TaskReport } from "@xandreed/sdk"

// What comes into the conversation: a message you sent, or a task's report. One queue holds both,
// in the order they came.
export type Input =
  | { readonly _tag: "Message"; readonly text: string }
  | { readonly _tag: "Report"; readonly report: TaskReport }
`,
  ],
  [
    `  // Every message you send, in order. It waits while you send nothing, and never ends.
  readonly messages: Stream.Stream<string>
  // Every message waiting now, taken at once. A turn takes the ones sent while the turn before it ran.
  readonly drain: Effect.Effect<ReadonlyArray<string>>`,
    `  // Every message you send and every task's report, one at a time, in the order they came. It
  // waits while nothing comes, and never ends.
  readonly inputs: Stream.Stream<Input>
  // Every message waiting now, taken at once. A turn takes the ones sent while the turn before it
  // ran. The reports waiting stay in the queue: each gets a turn of its own.
  readonly drain: Effect.Effect<ReadonlyArray<string>>`,
  ],
  [
    "  readonly onSend: (send: (text: string) => void) => void\n",
    `  readonly onSend: (send: (text: string) => void) => void
  // Where a task's report is handed to the chat: main's reportsOn(pane) hands each one here.
  readonly onReport: (report: (report: TaskReport) => void) => void
`,
  ],
  [
    `// The chat over a pane: it starts a conversation to show, and Send puts your message on a queue,
// where the program takes it from.`,
    `// The chat over a pane: it starts a conversation to show, and Send puts your message on a queue.
// A task's report goes on the same queue, behind what came before it. The program takes them from
// there, one at a time.`,
  ],
  [
    `      const waiting = yield* Queue.bounded<string>(100)
      pane.onSend((text) => Queue.offerUnsafe(waiting, text))
      return Chat.of({
        session,
        // One at a time: a message leaves the queue only when a turn is ready for it.
        messages: Stream.fromEffectRepeat(Queue.take(waiting)),
        drain: Effect.map(Queue.clear(waiting), (taken) => Array.from(taken)),`,
    `      const waiting = yield* Queue.bounded<Input>(100)
      pane.onSend((text) => Queue.offerUnsafe(waiting, { _tag: "Message", text }))
      pane.onReport((report) => Queue.offerUnsafe(waiting, { _tag: "Report", report }))
      return Chat.of({
        session,
        // One at a time: a message or a report leaves the queue only when a turn is ready for it.
        inputs: Stream.fromEffectRepeat(Queue.take(waiting)),
        // In one step that does not wait, so nothing is sent in between: take everything waiting,
        // put the reports back in their order, and give the messages.
        drain: Effect.sync(() => {
          const taken: Array<Input> = []
          let next = Queue.takeUnsafe(waiting)
          while (next !== undefined) {
            if (Exit.isSuccess(next)) taken.push(next.value)
            next = Queue.takeUnsafe(waiting)
          }
          Queue.offerAllUnsafe(
            waiting,
            taken.filter((input) => input._tag === "Report"),
          )
          return taken.flatMap((input) => (input._tag === "Message" ? [input.text] : []))
        }),`,
  ],
]

/** chat.ts, as the learner reads it. */
export const CHAT = replaced(LESSON_1_CHAT, REPLACED)
