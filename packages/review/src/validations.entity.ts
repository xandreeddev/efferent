import { Schema } from "effect"
import { DigestLimits } from "./log-digest.entity.js"

/**
 * Commands to run in a pull request's worktree: the commands, in order, the only ones its shell runs; the worktree;
 * the folder name its logs are kept under; the changed paths a digest puts first; the digest's limits; and how long
 * each command may run.
 */
export const ValidationRequest = Schema.Struct({
  commands: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  cwd: Schema.String,
  logFolder: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  limits: DigestLimits,
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ValidationRequest = typeof ValidationRequest.Type
