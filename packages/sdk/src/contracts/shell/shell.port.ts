import { Context } from "effect"
import type { Effect } from "effect"
import type { Ran, RunRequest, ShellRefused, ShellUnavailable } from "./shell.entity.js"

/**
 * A shell the host provides (ADR 0028): `run(request)` runs one command as `sh -c <command>` and answers how it ended
 * and the end of its output (`Ran`). An exit code that is not 0, a timeout and a signal are results, never failures;
 * a command that could not run at all fails with `ShellUnavailable`, and one the host's rule declines with
 * `ShellRefused`.
 *
 * Every process a command started is gone when its run ends, however it ends: it returned, it timed out, the fiber
 * that ran it was interrupted, or the shell's scope closed. A shell is not confined: a command runs with the host's
 * rights, wherever its paths lead, and its folder is a starting place only. It is not the `Files` workspace. It may be
 * given, as the tool `runCommand`, only where the app means a model to act on the machine; permission is the app's
 * (a `Shell` that declines, or a loop that asks before the call), never the tool's.
 *
 * @public
 */
export class Shell extends Context.Service<Shell, {
  readonly run: (request: RunRequest) => Effect.Effect<Ran, ShellRefused | ShellUnavailable>
}>()("@xandreed/sdk/Shell") {}
