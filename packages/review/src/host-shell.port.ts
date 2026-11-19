import { Context } from "effect"
import type { Effect } from "effect"
import type { Ran, RunRequest, ShellRefused, ShellUnavailable } from "@xandreed/sdk"
import type { OutputBound } from "./host-command.entity.js"

/**
 * The host's own shell, for the commands the reviewer runs itself (`gh`, `git`): it keeps the host's environment,
 * since `gh` reads its login and `git` its credentials there, and it keeps far more output than a model's shell, since
 * that output is parsed whole; a command of a model's tool runs under a small bound (`bound` `tool`). Never given to
 * a command of the pull request's: those run in `Validations`, with an environment of their own.
 */
export class HostShell extends Context.Service<HostShell, {
  readonly run: (request: RunRequest, bound?: OutputBound) => Effect.Effect<Ran, ShellRefused | ShellUnavailable>
}>()("@xandreed/review/HostShell") {}
