import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import { Core, Sessions } from "@xandreed/core/kernel"
import { assistantDelta, assistantMessage, requestSent, userMessage } from "../../contracts/loop/conversation.entity.functions.js"
import { replyOf, wantsTools } from "../../contracts/loop/loop.entity.functions.js"
import { Loop } from "../../contracts/loop/loop.port.js"
import { firstStep } from "../../contracts/loop/request.entity.functions.js"
import { Settings } from "../../contracts/loop/settings.port.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import type { TurnInput } from "../../contracts/loop/loop.entity.js"
import { callModel } from "./call-model.adapter.js"
import { emptyMessage, isEmpty, resolve, toolsNotInThisCut } from "./step-loop.usecase.functions.js"

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

  const run = (input: TurnInput) => isEmpty(input.message) ? emptyMessage :   // refused before the turn opens: nothing is stored
    sessions.turn(input.session, (session) => Effect.gen(function* () {
      yield* session.append(userMessage(input.message))

      let step = firstStep
      while (true) {
        const request  = yield* memory.build(session, step)
        const messages = yield* resolve(session, request)                      // pointers → the exact messages; refused if one points nowhere
        yield* session.append(requestSent(step, settings.system, request))
        const message  = yield* callModel(model, settings.system, messages,
          (delta) => core.publish(assistantDelta(session, delta)))
        yield* session.append(assistantMessage(step, message))
        if (!wantsTools(message)) return replyOf(message)
        yield* toolsNotInThisCut(message)     // next cut: run the tools, append their results, next step
      }
    })).pipe(Effect.withSpan("kernel.loop.run"))

  return Loop.of({ run })
})
