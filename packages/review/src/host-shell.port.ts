import { Context } from "effect"
import type { Effect } from "effect"
import type { Ran, RunRequest, ShellRefused, ShellUnavailable } from "@xandreed/sdk"

/**
 * The host's own shell, for the commands the reviewer runs itself (`gh`, `git`): it keeps the host's environment,
 * since `gh` reads its login and `git` its credentials there, and it keeps far more output than a model's shell, since
 * that output is parsed whole. Never given to a command of the pull request's: those run in `Validations`, with an
 * environment of their own.
 */
export class HostShell extends Context.Service<HostShell, {
  readonly run: (request: RunRequest) => Effect.Effect<Ran, ShellRefused | ShellUnavailable>
}>()("@xandreed/review/HostShell") {}
