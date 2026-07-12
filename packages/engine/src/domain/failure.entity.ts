import { Schema } from "effect"

/**
 * The shared tool-failure shape every engine toolkit uses with
 * `failureMode: "return"`: a handler failure is returned to the model as
 * data — `{ error, message }` — never thrown, never a dead turn. The
 * `message` says exactly what to fix; the model corrects in the same run.
 */
export const Failure = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})
export type Failure = typeof Failure.Type
