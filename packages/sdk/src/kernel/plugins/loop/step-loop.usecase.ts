import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import { assistantDelta, assistantMessage, Core, firstStep, Memory, replyOf, requestSent, Sessions, Settings, userMessage, wantsTools } from "@xandreed/core/kernel"
import type { TurnInput } from "@xandreed/core/kernel"
import { callModel } from "./call-model.adapter.js"
import { toolsNotInThisCut } from "./step-loop.usecase.functions.js"

/**
 * The loop plugin's main function: one turn, from the user's message to
 * the reply. It composes the other plugins through their contracts and
 * nothing else, so another loop is another function like this one.
 */
export const makeStepLoop = Effect.gen(function* () {
  const core     = yield* Core
  const sessions = yield* Sessions
  const memory   = yield* Memory
  const model    = yield* LanguageModel.LanguageModel
  const settings = yield* Settings

  const run = (input: TurnInput) =>
    sessions.turn(input.session, (session) => Effect.gen(function* () {
      yield* session.append(userMessage(input.message))
      const context = yield* memory.open(session)

      let step = firstStep
      while (true) {
        const request = yield* context.build(step)
        yield* session.append(requestSent(step, settings.system, request))
        const message = yield* callModel(model, session, settings.system, request,
          (delta) => core.publish(assistantDelta(session, delta)))
        yield* session.append(assistantMessage(step, message))
        if (!wantsTools(message)) return replyOf(message)
        yield* toolsNotInThisCut(message)     // next cut: run the tools, append their results, next step
      }
    })).pipe(Effect.withSpan("kernel.loop.run"))

  return { run }
})
