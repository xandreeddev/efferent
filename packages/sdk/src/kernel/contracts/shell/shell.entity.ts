import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One command for a `Shell` (ADR 0028): the command's text, run as `sh -c <command>`; the folder it starts in, against
 * the shell's own (`cwd`, an absolute path or one relative to the shell's folder: a starting folder, never a bound on
 * what the command reaches); and how long it may run (`timeoutMs`, the shell's default when left out).
 *
 * @public
 */
export const RunRequest = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type RunRequest = typeof RunRequest.Type

/**
 * How a command ended: it exited with a code (`Exited`); it ran past its time and was stopped, with every process it
 * started (`TimedOut`); or a signal the shell did not send ended it (`Killed`).
 *
 * @public
 */
export const RunEnded = Schema.Union([
  Schema.TaggedStruct("Exited", { code: Schema.Int }),
  Schema.TaggedStruct("TimedOut", { afterMs: Count }),
  Schema.TaggedStruct("Killed", { signal: Schema.String }),
])
export type RunEnded = typeof RunEnded.Type

/**
 * A command's output and how it ended. Each of `stdout` and `stderr` is the end of what the command wrote there, as
 * UTF-8 (a byte that is none read as U+FFFD): a shell keeps at most a bound of its own of each, the last bytes, and
 * `stdoutCut` and `stderrCut` count the bytes it left out before them. The end is kept because it says how a command
 * ended: an error, a summary, the last line of a test run.
 *
 * @public
 */
export const Ran = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutCut: Count,
  stderrCut: Count,
  ended: RunEnded,
})
export type Ran = typeof Ran.Type

/**
 * This `Shell` declines the command, by a rule of the host's (a command kept from the agent, a shell that runs
 * nothing while a person is away), and says why in `reason`. Nothing was run. The kernel's `runCommand` hands the
 * reason to the model as the call's failed result.
 *
 * @public
 */
export class ShellRefused extends Schema.TaggedError<ShellRefused>()("ShellRefused", {
  reason: Schema.String,
  message: Schema.String,
}) {}

/**
 * The shell could not run the command at all: no shell where it was looked for, a starting folder that is not one, a
 * process the system would not start. A tool's call that meets it is a defect, as `FilesUnavailable` is.
 *
 * @public
 */
export class ShellUnavailable extends Schema.TaggedError<ShellUnavailable>()("ShellUnavailable", {
  message: Schema.String,
}) {}

/**
 * The name of the tool that runs a command.
 *
 * @public
 */
export const RUN_COMMAND = "runCommand"

/**
 * The longest a model may ask `runCommand` to run a command for, in seconds: ten minutes.
 *
 * @public
 */
export const COMMAND_TIMEOUT_LIMIT = 600

/**
 * What `runCommand` answers: how the command ended in words (`exited`, `timed out`, `killed`), its exit code when it
 * exited, and the end of its output with the bytes left out before it (`Ran`).
 *
 * @public
 */
export const CommandRun = Schema.Struct({
  ended: Schema.Literals(["exited", "timed out", "killed"]),
  exitCode: Schema.optionalKey(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutCut: Count,
  stderrCut: Count,
})
export type CommandRun = typeof CommandRun.Type
