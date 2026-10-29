import { Data, Schema } from "effect"

class NotFoundError extends Data.TaggedError("NotFoundError")<{ readonly id: string }> {}
class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

export const isNotFound = (error: unknown) => error instanceof NotFoundError
export const isRefused = (error: unknown) => error instanceof Refused
export const isError = (error: unknown) => error instanceof Error
export const isTagged = Schema.is(Refused)
export const isDate = (value: unknown) => value instanceof Date
