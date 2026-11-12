import { Effect, Layer, Option } from "effect"
import { Core, readJournal } from "@xandreed/core/kernel"
import { requestSentEvent } from "../../contracts/loop/conversation.entity.js"
import { Settings } from "../../contracts/loop/settings.port.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import type { OpenSession } from "@xandreed/core/kernel"
import { budgetOf, fitToBudget, nearlyFull, WINDOW_READER, windowDropped, windowPressure } from "./window.entity.functions.js"
import type { InvalidBudget, WindowOptions } from "./window.entity.js"

/**
 * The window memory: every message of the journal, whole turns leaving
 * oldest first once the estimate is over the budget. It owns the budget,
 * and its estimate covers the system text the settings hold, so it counts
 * what is really sent. What it drops it records as `plugin.window.dropped`;
 * a request sent close to the budget it announces as `plugin.window.pressure`.
 * A budget that is no finite number of at least one token fails the layer
 * with `InvalidBudget`.
 *
 * @public
 */
export const windowMemory = (options: WindowOptions): Layer.Layer<Memory, InvalidBudget, Core | Settings> => Layer.effect(Memory, Effect.gen(function* () {
  const core     = yield* Core
  const settings = yield* Settings
  const budget   = yield* Effect.fromResult(budgetOf(options.budgetTokens))   // InvalidBudget fails the layer

  // React: announce pressure, so any plugin can act on it.
  yield* core.on(requestSentEvent, (sent) =>
    nearlyFull(sent.data, options.pressureAt) ? core.publish(windowPressure(sent)) : Effect.void,
    { name: "window" })

  return Memory.of({
    // Nothing is kept between requests: each is built from the journal as it stands.
    build: Effect.fn("kernel.window.build")(function* (session: OpenSession) {
      const journal = yield* Effect.fromResult(readJournal(WINDOW_READER)(yield* session.journal))
      const fitted  = yield* Effect.fromResult(fitToBudget(settings.system, journal, budget))   // whole turns, oldest dropped first
      if (Option.isSome(fitted.dropped)) yield* session.append(windowDropped(fitted.dropped.value))
      return fitted.request                                                      // pointers into the journal
    }),
  })
}))
