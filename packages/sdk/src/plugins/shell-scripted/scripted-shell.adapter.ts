import { Effect, Layer, Predicate, Ref } from "effect"
import { ShellUnavailable } from "../../contracts/shell/shell.entity.js"
import type { Ran, RunRequest, ShellRefused } from "../../contracts/shell/shell.entity.js"
import { Shell } from "../../contracts/shell/shell.port.js"

/**
 * What a scripted shell answers to one run, in order: how a command ran (`Ran`), or a refusal (`ShellRefused`), as a
 * host's rule would give it.
 *
 * @public
 */
export type ScriptedRun = Ran | ShellRefused

/**
 * A shell that follows a script and runs nothing (ADR 0028): run `n` answers the script's `n`th entry, and a run past
 * the script's end fails with `ShellUnavailable`, so a test that runs more than it meant to fails. `runs` is what it
 * was asked so far. It is what a tool's test, or an example, gives `runCommand`, so neither spawns a process.
 *
 * @public
 */
export const scriptedShell = Effect.fn("scripted_shell.make")(function* (script: ReadonlyArray<ScriptedRun>) {
  const asked = yield* Ref.make<ReadonlyArray<RunRequest>>([])
  const shell: Layer.Layer<Shell> = Layer.succeed(Shell, Shell.of({
    run: (request) => Effect.flatten(Ref.modify(asked, (all): readonly [Effect.Effect<Ran, ShellRefused | ShellUnavailable>, ReadonlyArray<RunRequest>] => {
      const step = script[all.length]
      const answer = step === undefined
        ? Effect.fail(new ShellUnavailable({ message: `the scripted shell has ${script.length} runs, and was asked for run ${all.length + 1}` }))
        : Predicate.isTagged(step, "ShellRefused") ? Effect.fail(step) : Effect.succeed(step)
      return [answer, [...all, request]]
    })),
  }))
  return { shell, runs: Ref.get(asked) }
})
