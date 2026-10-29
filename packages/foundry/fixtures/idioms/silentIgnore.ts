import { Effect } from "effect"

const work = Effect.fail("no")
export const bare = work.pipe(Effect.ignore)
export const swallowed = work.pipe(Effect.catch(() => Effect.void))
export const causeSwallowed = work.pipe(Effect.catchCause(() => Effect.void))
export const replaced = work.pipe(Effect.orElseSucceed(() => 0))
export const quiet = work.pipe(Effect.ignore({ log: false }))
export const logged = work.pipe(Effect.ignore({ log: "Warn", message: "the work was dropped" }))
export const tapped = work.pipe(Effect.tapError((error) => Effect.logDebug("no work", error)), Effect.orElseSucceed(() => 0))
export const handled = work.pipe(Effect.catch((error) => Effect.logWarning("the work failed", error)))
export const expected = Effect.fail({ _tag: "Gone" as const }).pipe(Effect.catchTag("Gone", () => Effect.void))
