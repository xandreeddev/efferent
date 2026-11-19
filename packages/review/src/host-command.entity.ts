import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** How a host command failed: it exited with a code it may not, ran out of time, was killed, or could not run. */
export const CommandFailure = Schema.Literals(["exited", "timed-out", "killed", "refused", "unavailable"])
export type CommandFailure = typeof CommandFailure.Type

/** A command the reviewer runs on the host (`gh`, `git`) failed: which, how, and the end of what it said. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  reason: CommandFailure,
  command: Schema.String,
  message: Schema.String,
}) {}

/**
 * A command's output was longer than the shell keeps, so it was cut: the reviewer never parses a cut output. `cut`
 * counts the bytes left out.
 */
export class OutputCut extends Schema.TaggedError<OutputCut>()("OutputCut", {
  command: Schema.String,
  cut: Count,
  message: Schema.String,
}) {}

/** A host command's whole output and the code it exited with (one the caller allowed). */
export const Whole = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Int,
})
export type Whole = typeof Whole.Type
