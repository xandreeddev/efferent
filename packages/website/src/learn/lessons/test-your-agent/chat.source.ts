// Lesson 12's chat.ts is lesson 1's, shown read-only as in every lesson. This
// is the lesson where the page also runs it: a check's chat is this file's
// `chatOn`, over a pane the check makes, where the chat pane's own program is
// handed the page's chat. The text is TypeScript and the page runs
// JavaScript, with no compiler in between, so the text the page runs is this
// one with its types taken out, by named pieces. program.test.ts checks that
// lesson 1's text holds each piece once and that nothing else differs.
import { replaced } from "../base/agent.source.ts"
import { CHAT } from "../tools/chat.source.ts"

export { CHAT }

/** chat.ts's imports: the page gives the names they list. */
const IMPORTS = `import { Context, Effect, Layer, Queue, Stream } from "effect"
import { Sessions } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"

`

/** The type arguments of the service's class: what the chat offers, as types. */
const SHAPE = `<Chat, {
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
}>`

/** The pane's interface, with its comment: a type alone. */
const PANE = `// What a chat pane offers. This page has one; a terminal or a test would have another.
export interface ChatPane {
  readonly onSend: (send: (text: string) => void) => void
  readonly appendToAnswer: (piece: string) => void
  readonly finishAnswer: (text: string) => void
  readonly showError: (error: unknown) => void
  readonly showStatus: (text: string) => void
}

`

/** What is taken out of chat.ts for the page to run it, as `[from, to]`: its imports and every type. Each `from` is in the text once. */
export const TYPES: ReadonlyArray<readonly [string, string]> = [
  [IMPORTS, ""],
  [SHAPE, ""],
  [PANE, ""],
  ["(pane: ChatPane)", "(pane)"],
  ["Queue.bounded<string>(100)", "Queue.bounded(100)"],
]

/** chat.ts as the page runs it: statements, without its imports, its types and `export`. */
export const chatBodyOf = (chat: string): string => replaced(chat, TYPES).replace(/^export /gm, "")
