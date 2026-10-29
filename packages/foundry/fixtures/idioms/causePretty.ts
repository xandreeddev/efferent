import { Cause, Effect } from "effect"

const cause = Cause.fail("boom")
export const kept = { detail: Cause.pretty(cause) }
export const logged = Effect.logError("failed", Cause.pretty(cause))
export const templated = Effect.logWarning(`failed: ${Cause.pretty(cause)}`)
export const messages = Cause.prettyErrors(cause).map((error) => error.message)
export const deferred = Effect.logError(() => Cause.pretty(cause))
