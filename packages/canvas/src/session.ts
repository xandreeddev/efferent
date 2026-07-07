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
export const makeCanvasSession = (args: {
  readonly conversationId: ConversationId
}): Effect.Effect<CanvasSession, never, CanvasRunServices> =>
  makeSession<CanvasEvent, CanvasRunServices>({
    conversationId: args.conversationId,
    onError: (message) => ({ type: "error", message }),
    runTurn: (text, publish) =>
      runAgent(
        { system: canvasAgentPrompt, toolkit: canvasToolkit, maxSteps: 24 },
        args.conversationId,
        text,
        { onEvent: publish },
      ).pipe(
        Effect.provide(makeCanvasHandlers((entry) => publish({ type: "ui_render", entry }))),
        Effect.asVoid,
      ),
  })
