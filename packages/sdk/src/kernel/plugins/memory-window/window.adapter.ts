import { Effect, Option } from "effect"
import { Core, definePlugin, Memory, readJournal, requestSentEvent, Settings, Tokens } from "@xandreed/core/kernel"
import { fitToBudget, nearlyFull, WINDOW_READER, windowDropped, windowPressure } from "./window.entity.functions.js"
import type { WindowOptions } from "./window.entity.js"

/**
 * The window memory: every message of the journal, whole turns leaving
 * oldest first once the estimate is over the budget. It owns the budget,
 * and its estimate covers the system text the settings hold, so it counts
 * what is really sent. What it drops it records as `plugin.window.dropped`;
 * a request sent close to the budget it announces as `plugin.window.pressure`.
 *
 * @public
 */
export const windowMemory = (options: WindowOptions) => definePlugin({
  name: "window",
  version: "0.22.0",
  provides: Memory,
  make: Effect.gen(function* () {
    const core = yield* Core
    const settings = yield* Settings
    const budgetTokens = Tokens.make(Math.max(0, Math.floor(options.budgetTokens)))

    // react: announce pressure so any plugin can act on it
    yield* core.on(requestSentEvent, (sent) =>
      nearlyFull(sent.data, options.pressureAt) ? core.publish(windowPressure(sent)) : Effect.void)

    return Memory.of({
      open: (session) => Effect.succeed({
        build: Effect.fn("kernel.window.build")(function* () {
          const known = yield* Effect.fromResult(readJournal(WINDOW_READER)(yield* session.journal))
          const fitted = yield* Effect.fromResult(fitToBudget(settings.system, known, budgetTokens))
          yield* Option.match(fitted.dropped, {
            onNone: () => Effect.void,
            onSome: (through) => session.append(windowDropped(through)),    // its own record, stored before the request that leaves the turns out
          })
          return fitted.request
        }),
      }),
    })
  }),
})
