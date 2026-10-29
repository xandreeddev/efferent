import { Effect } from "effect"

export const all = () => Promise.all([Promise.resolve(1)])
export const settled = () => Promise.allSettled([Promise.resolve(1)])
export const bounded = Effect.forEach([1, 2], (n) => Effect.succeed(n), { concurrency: 2 })
export const raced = () => Promise.race([Promise.resolve(1)])
