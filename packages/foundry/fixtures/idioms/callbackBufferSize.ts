import { Effect, Stream } from "effect"

const options = { bufferSize: 16 }
export const unbounded = Stream.callback<number>(() => Effect.void)
export const noSize = Stream.callback<number>(() => Effect.void, { strategy: "sliding" })
export const sized = Stream.callback<number>(() => Effect.void, { bufferSize: 16 })
export const named = Stream.callback<number>(() => Effect.void, options)
