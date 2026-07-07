import type { Tool, Toolkit } from "@effect/ai"
import { Effect, Option } from "effect"
import type { LoopEvent } from "../domain/LoopEvent.js"
import type { ConversationId } from "../domain/Message.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { handoffToMessage } from "./mapping.js"
import { runLoop } from "./loop.js"

/**
 * An agent is a system prompt + a toolkit (+ its loop bounds). The driver
 * decides which config runs; the engine stays agent-agnostic.
 */
export interface AgentConfig<Tools extends Record<string, Tool.Any>> {
  readonly system: string
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly maxSteps?: number
  readonly pollableTools?: ReadonlyArray<string>
}

/**
 * One user turn over a persisted conversation: append the prompt, load the
 * active window (prepending the latest fold's summary when one exists), run
 * the loop with incremental tail persistence, return the result. Store
 * failures are defects (`orDie`) — persistence breaking mid-run is
 * infrastructure death, not a condition the model can correct.
 */
export const runAgent = <Tools extends Record<string, Tool.Any>, R = never>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  prompt: string,
  options?: {
    readonly onEvent?: (event: LoopEvent) => Effect.Effect<void, never, R>
  },
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    yield* store.append(conversationId, { role: "user", content: prompt }).pipe(Effect.orDie)
    const fold = yield* store.latestCheckpoint(conversationId).pipe(Effect.orDie)
    const active = yield* store.listActive(conversationId).pipe(Effect.orDie)
    const messages = Option.match(fold, {
      onNone: () => active,
      onSome: (checkpoint) => [handoffToMessage(checkpoint.summary), ...active],
    })
    return yield* runLoop({
      system: config.system,
      messages,
      toolkit: config.toolkit,
      ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
      ...(config.pollableTools !== undefined ? { pollableTools: config.pollableTools } : {}),
      ...(options?.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      onTail: (tail) =>
        Effect.forEach(tail, (message) => store.append(conversationId, message)).pipe(
          Effect.orDie,
        ),
    })
  })
