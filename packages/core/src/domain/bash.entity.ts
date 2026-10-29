import { Schema } from "effect"

/**
 * The parent environment a command inherits by default: these names, and
 * every name a trailing `*` prefixes. Provider keys and other host secrets
 * stay out unless a host passes them in `env` or widens `inheritEnv`.
 */
export const BASH_ENV_ALLOWLIST: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_*", "TERM", "SHELL", "TMPDIR", "TZ"]

/**
 * How a command runs. `cwd` is an absolute directory that must exist.
 * `env` is set over what is inherited; `inheritEnv` says what is inherited
 * from the parent environment: `true` everything, `false` nothing, or an
 * allowlist of names where a trailing `*` matches a prefix (default
 * `BASH_ENV_ALLOWLIST`). `stdin` (text, written as UTF-8, or bytes) is
 * written to the command's standard input, which is then closed (without it, the command reads end-of-file at
 * once). After `timeoutMs` the command's whole process group is killed.
 */
export const BashOptions = Schema.Struct({
  cwd: Schema.String,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  inheritEnv: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Array(Schema.String)])),
  stdin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Uint8Array])),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type BashOptions = typeof BashOptions.Type

/**
 * How a command ended: it exited (`exit`), a signal killed it (`signal`),
 * it ran past `timeoutMs` and was killed (`timeout`), or its caller stopped
 * the stream before it ended and it was killed (`interrupted`, which only
 * `collectBashResult` can see).
 */
export const BashTermination = Schema.Literals(["exit", "signal", "timeout", "interrupted"])
export type BashTermination = typeof BashTermination.Type

/**
 * Why a command could not run: the shell could not be spawned
 * (`SpawnFailed`), `cwd` does not exist or is not a directory
 * (`CwdMissing`), or the shell is not installed (`ShellMissing`). A command
 * that runs and fails is a result, never a `BashError`.
 */
export const BashErrorReason = Schema.Literals(["SpawnFailed", "CwdMissing", "ShellMissing"])
export type BashErrorReason = typeof BashErrorReason.Type

export class BashError extends Schema.TaggedError<BashError>()("BashError", {
  reason: BashErrorReason,
  message: Schema.String,
}) {}

/** Output as it arrives, decoded as UTF-8 per stream (a character split between reads arrives whole). */
export const BashChunk = Schema.TaggedStruct("BashChunk", {
  stream: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})
export type BashChunk = typeof BashChunk.Type

/** The end of a command: its exit code when it exited, the signal when one killed it, how long it ran. */
export const BashExit = Schema.TaggedStruct("BashExit", {
  termination: BashTermination,
  exitCode: Schema.OptionFromNullOr(Schema.Int),
  signal: Schema.OptionFromNullOr(Schema.String),
  durationMs: Schema.Number,
})
export type BashExit = typeof BashExit.Type

/** What `Bash.stream` emits: chunks as they come, then exactly one `BashExit`, last. */
export const BashEvent = Schema.Union([BashChunk, BashExit])
export type BashEvent = typeof BashEvent.Type

/** A whole command's output and end (`Bash.exec`). A non-zero exit is a result like any other. */
export const BashResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.OptionFromNullOr(Schema.Int),
  signal: Schema.OptionFromNullOr(Schema.String),
  termination: BashTermination,
  durationMs: Schema.Number,
})
export type BashResult = typeof BashResult.Type
