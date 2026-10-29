import { Data, Effect, Schema } from "effect"

class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { message: Schema.String }) {}
class Gone extends Data.TaggedError("Gone")<{ readonly reason: string }> {}

export const wrapped = (cause: unknown) => new StoreError({ message: String(cause) })
export const templated = (cause: Error) => new StoreError({ message: `the write failed: ${cause}` })
export const joined = (cause: unknown) => new Gone({ reason: "gone: " + cause })
export const caught = Effect.tryPromise({ try: () => Promise.resolve(1), catch: (cause) => new StoreError({ message: String(cause) }) })
export const said = () => new StoreError({ message: "the write failed" })
export const counted = (attempts: number) => new StoreError({ message: `failed ${attempts} times (${String(attempts)})` })
export const plain = (cause: unknown) => ({ message: String(cause) })
