import { Schema } from "effect"

/**
 * How `BashLive` (and `localSystemPlugin`) runs commands. `shell` is the
 * program commands run with (`<shell> -c <command>`): a name looked up once,
 * when the layer is built, on the parent environment's `PATH` (its absolute
 * entries), or an absolute path; there is no fallback, so a host without
 * bash sets `shell: "sh"` (or another path) itself. With `killBackground`, a
 * command's whole process group is killed when the command returns, so
 * nothing it started in the background outlives it (a timeout or an
 * interrupted caller always kills the group). `exitGraceMs` is how long,
 * after the command exits, its output may take to close (a background
 * process that kept it open) before the stream ends without the rest. The
 * output pipes close then, so a background process kept with
 * `killBackground: false` must have its own output (`cmd > log 2>&1 &`):
 * one still writing to the command's dies of `SIGPIPE` or gets `EPIPE`.
 */
export const LocalSystemConfig = Schema.Struct({
  shell: Schema.NonEmptyString,
  killBackground: Schema.Boolean,
  exitGraceMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
})
export type LocalSystemConfig = typeof LocalSystemConfig.Type

export const localSystemDefaults: LocalSystemConfig = { shell: "bash", killBackground: true, exitGraceMs: 500 }

/**
 * `BashLive`'s options: the plugin's configuration, each part optional, and
 * `parentEnv`, the environment commands inherit from (filtered by
 * `resolveBashEnv`) and the shell is looked up on; `process.env` when not
 * given.
 */
export type BashLiveOptions = Partial<LocalSystemConfig> & {
  readonly parentEnv?: Readonly<Record<string, string | undefined>>
}

/** How a spawned process ended, as Node reports it, and whether the adapter killed it for running past its timeout. */
export const ProcessEnd = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Number,
})
export type ProcessEnd = typeof ProcessEnd.Type
