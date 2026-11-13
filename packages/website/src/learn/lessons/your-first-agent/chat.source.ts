// Lesson 1's chat.ts: the chat as a module the program is given. The page
// shows this text read-only; program.test.ts compiles and runs it, and the
// page's own chat (learn/runtime.ts) is the same shape over its pane.

/** chat.ts, as the learner reads it. */
export const CHAT = `import { Context, Effect, Layer, Queue, Stream } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"

// The chat: how messages get into your program and answers get out.
export class Chat extends Context.Service<Chat, {
  // The conversation this chat shows. "Clear context" gives it a new one.
  readonly session: SessionId
  // Every message you send, in order. It waits while you send nothing, and never ends.
  readonly messages: Stream.Stream<string>
  // Every message waiting now, taken at once. A turn takes the ones sent while the turn before it ran.
  readonly drain: Effect.Effect<ReadonlyArray<string>>
  // Draw a piece of the answer as it arrives.
  readonly stream: (piece: string) => Effect.Effect<void>
  // Show the whole answer: the turn is done.
  readonly reply: (text: string) => Effect.Effect<void>
  // Show why a turn failed.
  readonly fail: (error: unknown) => Effect.Effect<void>
  // Set the line above the chat that says what the agent is doing.
  readonly status: (text: string) => Effect.Effect<void>
}>()("lesson/Chat") {}

// What a chat pane offers. This page has one; a terminal or a test would have another.
export interface ChatPane {
  readonly onSend: (send: (text: string) => void) => void
  readonly appendToAnswer: (piece: string) => void
  readonly finishAnswer: (text: string) => void
  readonly showError: (error: unknown) => void
  readonly showStatus: (text: string) => void
}

// The chat over a pane: it starts a conversation to show, and Send puts your message on a queue,
// where the program takes it from.
export const chatOn = (pane: ChatPane) =>
  Layer.effect(
    Chat,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const session = yield* sessions.create({ owner: "learner" })
      const waiting = yield* Queue.bounded<string>(100)
      pane.onSend((text) => Queue.offerUnsafe(waiting, text))
      return Chat.of({
        session,
        // One at a time: a message leaves the queue only when a turn is ready for it.
        messages: Stream.fromEffectRepeat(Queue.take(waiting)),
        drain: Effect.map(Queue.clear(waiting), (taken) => Array.from(taken)),
        stream: (piece) => Effect.sync(() => pane.appendToAnswer(piece)),
        reply: (text) => Effect.sync(() => pane.finishAnswer(text)),
        fail: (error) => Effect.sync(() => pane.showError(error)),
        status: (text) => Effect.sync(() => pane.showStatus(text)),
      })
    }),
  )
`
