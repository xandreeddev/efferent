import type { LanguageModel } from "@effect/ai"
import { Effect } from "effect"
import { makeSession, runAgent } from "@xandreed/engine"
import type { ConversationId, ConversationStore, LoopEvent, Session } from "@xandreed/engine"
import { canvasAgentPrompt } from "./prompt.js"
import { canvasToolkit, makeCanvasHandlers } from "./toolkit.js"
import type { CanvasEntry } from "./toolkit.js"

/** The session's event vocabulary: loop events + the ONE product event. */
export type CanvasEvent =
  | LoopEvent
  | { readonly type: "ui_render"; readonly entry: CanvasEntry }

export type CanvasSession = Session<CanvasEvent>

export type CanvasRunServices = LanguageModel.LanguageModel | ConversationStore

/**
 * The canvas session on the engine chassis: one persisted conversation,
 * serialized sends, the ledger the WS pump replays. The render sink IS the
 * chassis publish — an accepted render lands on the same seq'd stream as
 * the loop events.
 */
/** Chat text is a CAPTION channel. A reply that pastes markup instead of
 *  calling render_ui is a harness violation (live-caught: a pomodoro page
 *  arrived as an HTML snippet in chat) — detected deterministically and
 *  corrected with ONE bounded follow-up turn. */
export const looksLikeHtmlDump = (text: string): boolean =>
  /```\s*html/i.test(text) ||
  (text.match(/<[a-z][a-z0-9-]*[\s/>]/gi) ?? []).length >= 4

const HTML_DUMP_CORRECTIVE =
  "[system] Your last reply pasted HTML into the chat text. The user NEVER sees chat markup — pages exist only through render_ui. Re-issue that content now as a render_ui call (re-use the page id if it updates an existing page), then reply with one plain sentence."

export const makeCanvasSession = (args: {
  readonly conversationId: ConversationId
}): Effect.Effect<CanvasSession, never, CanvasRunServices> =>
  makeSession<CanvasEvent, CanvasRunServices>({
    conversationId: args.conversationId,
    onError: (message) => ({ type: "error", message }),
    runTurn: (text, publish) => {
      const config = { system: canvasAgentPrompt, toolkit: canvasToolkit, maxSteps: 24 }
      const turn = (message: string) =>
        runAgent(config, args.conversationId, message, { onEvent: publish })
      return turn(text).pipe(
        Effect.flatMap((result) =>
          looksLikeHtmlDump(result.finalText) ? turn(HTML_DUMP_CORRECTIVE) : Effect.succeed(result),
        ),
        Effect.provide(makeCanvasHandlers((entry) => publish({ type: "ui_render", entry }))),
        Effect.asVoid,
      )
    },
  })
