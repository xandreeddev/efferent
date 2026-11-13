import { Effect, Layer, Option } from "effect"
import { Core, readJournal } from "@xandreed/core/kernel"
import { promptMessage } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import type { OpenSession } from "@xandreed/core/kernel"
import { budgetOf, fitToBudget, nearlyFull, WINDOW_READER, windowDropped, windowPressure } from "./window.entity.functions.js"
import type { InvalidBudget, WindowOptions } from "./window.entity.js"

/**
 * The window memory: every message of the conversation, whole turns
 * leaving oldest first once the estimate is over the budget. It owns the
 * budget, which is the history's: the system text is the caller's. What it
 * drops it records as `plugin.window.dropped`, tagged `memory`, so a turn
 * once dropped stays dropped and the start of every later context holds; a
 * context built close to the budget it announces as `plugin.window.pressure`.
 * A budget that is no finite number of at least one token fails the layer
 * with `InvalidBudget`.
 *
 * @public
 */
export const windowMemory = (options: WindowOptions): Layer.Layer<Memory, InvalidBudget, Core> => Layer.effect(Memory, Effect.gen(function* () {
  const core   = yield* Core
  const budget = yield* Effect.fromResult(budgetOf(options.budgetTokens))   // InvalidBudget fails the layer

  return Memory.of({
    // Nothing is kept between turns: each context is built from the journal as it stands.
    context: Effect.fn("kernel.window.context")(function* (session: OpenSession) {
      const journal = yield* Effect.fromResult(readJournal(WINDOW_READER)(yield* session.journal))
      const fitted  = yield* Effect.fromResult(fitToBudget(journal, budget))   // whole turns, oldest dropped first
      if (Option.isSome(fitted.dropped)) yield* session.append(windowDropped(fitted.dropped.value))
      // React: announce pressure, so any plugin can act on it.
      if (nearlyFull(fitted, options.pressureAt)) yield* core.publish(windowPressure(session, fitted))
      return fitted.messages.map(promptMessage)
    }),
  })
}))
