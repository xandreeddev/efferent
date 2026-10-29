import { Effect } from "effect"

const read = (id: string) => Effect.succeed(id)
export const serial = Effect.forEach(["a", "b"], read)
export const both = Effect.all([read("a"), read("b")])
export const piped = Effect.succeed(["a", "b"]).pipe(Effect.flatMap(Effect.forEach(read, { discard: true })))
export const bounded = Effect.forEach(["a", "b"], read, { concurrency: 4 })
export const ordered = Effect.all({ a: read("a"), b: read("b") }, { concurrency: 1 })
export const pipedBounded = Effect.succeed(["a"]).pipe(Effect.flatMap(Effect.forEach(read, { concurrency: "unbounded" })))
export const single = Effect.all([read("a")])
