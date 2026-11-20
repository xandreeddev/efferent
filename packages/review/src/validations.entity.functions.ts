import { Effect, Match, Option } from "effect"
import { Shell, ShellRefused } from "@xandreed/sdk"
import type { Ran } from "@xandreed/sdk"

/**
 * A `Shell` that runs only `commands`, each exactly as written, over the one it is given; any other command is
 * refused with `ShellRefused` and not run. A guard on which commands run, never isolation: what a listed command can
 * reach is the inner shell's to bound, a sandbox's.
 */
export const allowOnly = (commands: ReadonlyArray<string>, inner: Shell["Service"]): Shell["Service"] => Shell.of({
  run: (request) => commands.includes(request.command)
    ? inner.run(request)
    : Effect.fail(new ShellRefused({ reason: "only the review's own commands run here", message: `declined ${request.command.slice(0, 200)}` })),
})

/** How a command ended, in words, and its exit code when it exited. */
export const endedOf = (ran: Ran): { readonly ended: string; readonly exit: Option.Option<number> } => Match.valueTags(ran.ended, {
  Exited: ({ code }) => ({ ended: `exited with ${code}`, exit: Option.some(code) }),
  TimedOut: ({ afterMs }) => ({ ended: `timed out after ${afterMs} ms`, exit: Option.none() }),
  Killed: ({ signal }) => ({ ended: `killed by ${signal}`, exit: Option.none() }),
})

/** Whether a command exited with 0. */
export const passed = (ran: Ran): boolean => Option.contains(endedOf(ran).exit, 0)

/** A command's log as it is kept: its stdout, then its stderr, each with what the shell cut said first. */
export const logText = (ran: Ran): string => [
  ...(ran.stdoutCut > 0 ? [`[${ran.stdoutCut} bytes of stdout cut before this]`] : []),
  ran.stdout,
  ...(ran.stderr.length > 0 || ran.stderrCut > 0 ? ["--- stderr ---", ...(ran.stderrCut > 0 ? [`[${ran.stderrCut} bytes of stderr cut before this]`] : []), ran.stderr] : []),
].join("\n")

/** What restores a saved `node_modules` into a clone, inside the sandbox: the snapshot is bound read-only at `/snapshot`. */
export const RESTORE_SNAPSHOT = "/usr/bin/cp -a /snapshot/. /work/"

/**
 * What saves every `node_modules` folder of a clone (its `.git` passed over), inside the sandbox, into the folder bound
 * writable at `/snapshot`, each at its place.
 */
export const SAVE_SNAPSHOT = `/usr/bin/find . -path ./.git -prune -o -type d -name node_modules -print -prune | while IFS= read -r d; do /usr/bin/mkdir -p "/snapshot/$d" && /usr/bin/cp -a "$d/." "/snapshot/$d/" || exit 1; done`
