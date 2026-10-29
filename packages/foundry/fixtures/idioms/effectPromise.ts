import { Effect } from "effect"

export const unchecked = Effect.promise(() => Promise.resolve(1))
export const checked = Effect.tryPromise({ try: () => Promise.resolve(1), catch: () => "failed" as const })
