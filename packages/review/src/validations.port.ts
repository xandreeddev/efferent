import { Context } from "effect"
import type { Effect } from "effect"
import type { ShellRefused, ShellUnavailable } from "@xandreed/sdk"
import type { LogDigest } from "./log-digest.entity.js"
import type { LogsUnavailable } from "./review-logs.entity.js"
import type { ValidationRequest } from "./validations.entity.js"

/**
 * Runs a pull request's own commands (its tests, its type check) in its worktree, one after another, and answers a
 * digest of each command's log, the whole log kept. A command that fails, times out or is killed is a digest, never
 * a failure; a shell that cannot run one, or a log that cannot be kept, fails the run.
 */
export class Validations extends Context.Service<Validations, {
  readonly run: (request: ValidationRequest) => Effect.Effect<ReadonlyArray<LogDigest>, ShellRefused | ShellUnavailable | LogsUnavailable>
}>()("@xandreed/review/Validations") {}
