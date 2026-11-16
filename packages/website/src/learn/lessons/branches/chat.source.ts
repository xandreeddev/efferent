// The one source of truth for lesson 15's chat.ts: lesson 7's chat, whose
// editable `resume` now shows the chat the page asks for, `chosen`, when it
// is one of the learner's own; otherwise lesson 7's rule. Derived from
// lesson 7's text by named pieces; program.test.ts checks that text still
// holds each. `chosen` is the page's, named by no import: the typed module
// takes it as a parameter, of `resumeOf` and of `chatOn`.
import { CHAT_INTRO as KEEP_INTRO, CHAT_OUTRO, DEFAULT_RESUME as KEEP_RESUME } from "../keep-the-conversation/chat.source.ts"
import { replaced } from "../base/agent.source.ts"

/** What this lesson replaces in lesson 7's read-only part of chat.ts, as `[from, to]`. */
export const REPLACED_INTRO: ReadonlyArray<readonly [string, string]> = [
  ['import { Context, Effect, Layer, Queue, Result, Stream } from "effect"', 'import { Context, Effect, Layer, Option, Queue, Result, Stream } from "effect"'],
  [
    `// Which conversation to go on with: the last one you started that this kernel reads, or a new
// one. This page is the store's one writer and it has just started, so a turn the journal still
// holds open is nobody's: recover closes it, and leaves a session that is free as it is.
`,
    `// Which conversation to go on with: the chat the page asks for, \`chosen\`, when it is one of yours
// that this kernel reads; else the last one you started, or a new one. \`chosen\` is not imported:
// the page gives it, an Option of a session's id. It is the chat you picked in the row of chats,
// or the one shown when you made a branch, and none after Clear context.
// This page is the store's one writer and it is starting, so a turn the journal still holds open
// is nobody's: recover closes it, and leaves a session that is free as it is.
`,
  ],
]

/** Lesson 7's choice: the last of the learner's conversations. */
const LAST = `  const last = mine.at(-1)
  if (last === undefined) return yield* sessions.create({ owner: "learner" })
  yield* sessions.recover(last.id)
  return last.id`

/** This lesson's: the chat asked for, when it is one of them. */
export const ASKED = `  // The chat the page asks for, when it is one of these; else the last one.
  const shown = mine.find((header) => Option.contains(chosen, header.id)) ?? mine.at(-1)
`

/** What this lesson replaces in lesson 7's `resume`, as `[from, to]`. */
export const REPLACED_RESUME: ReadonlyArray<readonly [string, string]> = [
  [
    LAST,
    `${ASKED}  if (shown === undefined) return yield* sessions.create({ owner: "learner" })
  yield* sessions.recover(shown.id)
  return shown.id`,
  ],
]

/** Read-only: lesson 7's chat down to its pane, then the comment and the declaration before the editable `resume`. */
export const CHAT_INTRO = replaced(KEEP_INTRO, REPLACED_INTRO)

/** What the learner edits: the effect that names the conversation. */
export const DEFAULT_RESUME = replaced(KEEP_RESUME, REPLACED_RESUME)

export { CHAT_OUTRO }

/** The whole file as the learner reads it. */
export const chatDocumentOf = (resume: string): string => `${CHAT_INTRO}${resume}${CHAT_OUTRO}`

/** What the typed module replaces, as `[from, to]`: `chosen` becomes a parameter, of `resume` and of `chatOn`. */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ["export const resume = ", "export const resumeOf = (chosen: Option.Option<SessionId>) => "],
  ["export const chatOn = (pane: ChatPane) =>", "export const chatOn = (pane: ChatPane, chosen: Option.Option<SessionId>) =>"],
  ["      const session = yield* resume\n", "      const session = yield* resumeOf(chosen)\n"],
]

/** The same file as a module a test can compile and run: the text as shown, with `chosen` a parameter. */
export const chatModuleOf = (resume: string): string => replaced(chatDocumentOf(resume), TYPED)
