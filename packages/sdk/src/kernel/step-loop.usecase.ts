import { Effect } from "effect"
import { assistantDelta, assistantMessage, checkRequest, firstStep, replyOf, requestSent, wantsTools, writtenBy } from "@xandreed/core/kernel"
import type { Agent, OpenContext, OpenSession, StepNumber } from "@xandreed/core/kernel"
import { callModel } from "./call-model.adapter.js"
import { emit, record, recordEach, toolsNotInThisCut } from "./run-turn.usecase.functions.js"

/**
 * The default step loop: steps until the model asks for no tool, then the
 * reply. Another strategy is another function with this signature.
 *
 * @public
 */
export const runSteps = Effect.fn("kernel.run_steps")(function* (agent: Agent, session: OpenSession, context: OpenContext) {
  let step = firstStep
  while (true) {
    const message = yield* runStep(agent, session, context, step)
    if (!wantsTools(message)) return replyOf(message)
    yield* toolsNotInThisCut(message)   // next cut: runTools, record(toolResult), step = nextStep(step)
  }
})

const runStep = Effect.fn("kernel.run_step")(function* (agent: Agent, session: OpenSession, context: OpenContext, step: StepNumber) {
  const built   = yield* context.build({ step, limits: agent.limits })  // the manager decides what is sent
  yield* recordEach(agent, session, writtenBy(built))     // what the manager wrote while it built, as its own records
  const request = yield* checkRequest(agent, session, built)  // the turn's message is there, the estimate fits the budget
  yield* record(agent, session, requestSent(step, request))   // what the model is sent, as pointers into the journal
  const message = yield* callModel(agent, request, (delta) => emit(agent, session, assistantDelta(delta)))
  yield* record(agent, session, assistantMessage(step, message))
  return message
})
