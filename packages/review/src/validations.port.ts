import { Context } from "effect"
import type { Effect } from "effect"
import type { ShellRefused, ShellUnavailable } from "@xandreed/sdk"
import type { CheckoutError } from "./checkout.port.js"
import type { ForgeError } from "./forge.port.js"
import type { CacheUnavailable } from "./review-cache.entity.js"
import type { LogsUnavailable } from "./review-logs.entity.js"
import type { ValidationRequest, ValidationRun } from "./validations.entity.js"

/**
 * Runs a pull request's own commands (its base's install, its tests, its type check), only from a base on the
 * repository's default branch, each in a sandbox over a throwaway
 * clone, and answers the profile, a digest of each command's log, the whole log kept, and the commands that did not
 * run with why; or why nothing ran (`Refused`). A command that fails, times out or is killed is a digest, never a
 * failure; a sandbox that cannot run one, a clone, a log or the cache that cannot be written fails the run.
 */
export class Validations extends Context.Service<Validations, {
  readonly run: (request: ValidationRequest) => Effect.Effect<ValidationRun, ShellRefused | ShellUnavailable | LogsUnavailable | CheckoutError | CacheUnavailable | ForgeError>
}>()("@xandreed/review/Validations") {}
