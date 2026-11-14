// The one source of truth for lesson 7's chat.ts: lesson 1's chat, which
// made a new conversation every time, with one piece the learner edits,
// `resume`: which conversation to go on with. Derived from lesson 1's text
// by named pieces; program.test.ts checks that text still holds each.
import { CHAT as FIRST_CHAT } from "../your-first-agent/chat.source.ts"

/** What this lesson replaces in lesson 1's chat.ts, as `[from, to]`. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  ['import { Context, Effect, Layer, Queue, Stream } from "effect"', 'import { Context, Effect, Layer, Queue, Result, Stream } from "effect"'],
  ['import { Sessions } from "@xandreed/core/kernel"', 'import { currentFormat, Sessions } from "@xandreed/core/kernel"'],
  [
    '  // The conversation this chat shows. "Clear context" gives it a new one.\n',
    '  // The conversation this chat shows: the one `resume` gave. "Clear context" starts a new one.\n',
  ],
  [
    `// The chat over a pane: it starts a conversation to show, and Send puts your message on a queue,
// where the program takes it from.
`,
    `// The chat over a pane: it shows the conversation \`resume\` gives, and Send puts your message on a
// queue, where the program takes it from.
`,
  ],
  [
    `      const sessions = yield* Sessions
      const session = yield* sessions.create({ owner: "learner" })
`,
    `      const session = yield* resume
`,
  ],
]

const derived = REPLACED.reduce((text, [from, to]) => text.replace(from, to), FIRST_CHAT)
const CHAT_ON = "// The chat over a pane: it shows the conversation"

/** Read-only: lesson 1's chat down to its pane, then the comment and the declaration before the editable `resume`. */
export const CHAT_INTRO = `${derived.slice(0, derived.indexOf(CHAT_ON))}// Which conversation to go on with: the last one you started that this kernel reads, or a new
// one. This page is the store's one writer and it has just started, so a turn the journal still
// holds open is nobody's: recover closes it, and leaves a session that is free as it is.
export const resume = `

/** What the learner edits: the effect that names the conversation. */
export const DEFAULT_RESUME = `Effect.gen(function* () {
  const sessions = yield* Sessions
  const mine = (yield* sessions.list).filter(
    (header) =>
      header.owner === "learner" &&
      header.parent === undefined &&
      Result.isSuccess(currentFormat(header)),
  )
  const last = mine.at(-1)
  if (last === undefined) return yield* sessions.create({ owner: "learner" })
  yield* sessions.recover(last.id)
  return last.id
})`

/** Read-only: the chat over a pane, after `resume`. */
export const CHAT_OUTRO = `\n\n${derived.slice(derived.indexOf(CHAT_ON))}`

/** The whole file as the learner reads it. */
export const chatDocumentOf = (resume: string): string => `${CHAT_INTRO}${resume}${CHAT_OUTRO}`

/** The same file as a module a test can compile and run: the text as shown. */
export const chatModuleOf = chatDocumentOf
