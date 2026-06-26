import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"

/**
 * `efferent eval` — a thin pass-through to the evals runner
 * (`packages/evals/src/run.ts`). Evals are a dev/CI artifact, not part of the
 * published bundle, so this only works from a source checkout; elsewhere it says
 * so and exits cleanly. Output streams straight through (stdio inherited).
 */

export interface EvalForwardOptions {
  readonly suites: ReadonlyArray<string>
  readonly main?: string | undefined
  readonly fast?: string | undefined
  readonly judge?: string | undefined
  readonly samples?: string | undefined
  readonly config?: string | undefined
  readonly json?: boolean | undefined
}

const evalsEntry = (): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url)) // …/packages/cli/src/verify
  const entry = join(here, "..", "..", "..", "..", "packages/evals/src/run.ts")
  return existsSync(entry) ? entry : undefined
}

export const runEvalForward = (opts: EvalForwardOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entry = evalsEntry()
    if (entry === undefined) {
      yield* Effect.sync(() => {
        process.stdout.write(
          "efferent eval runs the suites from a source checkout — packages/evals " +
            "was not found next to this binary.\n",
        )
        process.exitCode = 1
      })
      return
    }

    const args: string[] = [...opts.suites]
    if (opts.config) args.push("--config", opts.config)
    if (opts.main) args.push("--main", opts.main)
    if (opts.fast) args.push("--fast", opts.fast)
    if (opts.judge) args.push("--judge", opts.judge)
    if (opts.samples) args.push("--samples", opts.samples)
    if (opts.json) args.push("--json")

    const code = yield* Effect.tryPromise(async () => {
      const proc = Bun.spawn([process.execPath, entry, ...args], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        env: process.env,
      })
      return await proc.exited
    }).pipe(Effect.orElseSucceed(() => 1))

    yield* Effect.sync(() => {
      process.exitCode = code
    })
  })
