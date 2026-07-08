import type { LanguageModel } from "@effect/ai"
import { Effect, Ref } from "effect"
import { makeSession, runAgent } from "@xandreed/engine"
import type { ConversationId, ConversationStore, LoopEvent, Session } from "@xandreed/engine"
import type { MathItem } from "./domain/MathContent.js"
import { mathAgentBundle } from "./toolkit.js"

/**
 * The math session on the engine chassis (one persisted conversation, an
 * append-only seq'd event ledger, serialized sends, interrupt) — the
 * hand-rolled copy this file used to carry was PROMOTED into
 * `@xandreed/engine` (`makeSession`); math keeps only its vocabulary and
 * its turn: the loop events plus the ONE product event, `math_render`,
 * published by the `render_math` handler the moment a batch is accepted
 * (the UI never parses tool-call args).
 */
export type MathSessionEvent =
  | LoopEvent
  | { readonly type: "math_render"; readonly items: ReadonlyArray<MathItem> }

/** One ledger entry: a session event with its absolute position. */
export interface MathSeqEvent {
  readonly seq: number
  readonly event: MathSessionEvent
}

export type MathSession = Session<MathSessionEvent>

/** Everything one math turn runs on (providers at the edge). */
export type MathRunServices = LanguageModel.LanguageModel | ConversationStore

export const makeMathSession = (args: {
  readonly conversationId: ConversationId
  readonly cwd: string
}): Effect.Effect<MathSession, never, MathRunServices> =>
  // The served-id set lives at SESSION scope (outlives turns): an exercise id
  // accepted in any earlier batch is rejected on re-send with a fix-it reason.
  Effect.flatMap(Ref.make<ReadonlySet<string>>(new Set()), (served) =>
    makeSession<MathSessionEvent, MathRunServices>({
      conversationId: args.conversationId,
      onError: (message) => ({ type: "error", message }),
      runTurn: (text, publish) => {
        const bundle = mathAgentBundle(
          (items) => publish({ type: "math_render", items }),
          served,
        )
        return runAgent(bundle.agentConfig, args.conversationId, text, {
          onEvent: publish,
        }).pipe(Effect.provide(bundle.handlerLayer), Effect.asVoid)
      },
    }),
  )
