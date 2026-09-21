import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Cause, Duration, Effect, Option } from "effect"

/**
 * The CAMPAIGN chassis — the one machinery every live matrix rides: the
 * argv vocabulary, the candidate × task × sample grid, the hard wall-clock
 * cap, failure containment (a provider error or a runtime defect settles as
 * a failed TRIAL, never an aborted campaign), immediate per-trial
 * persistence (evidence survives a dead process), and the entry guard that
 * runs a matrix only when it is the script invoked (never at import). Each
 * matrix keeps what is its own: the trial shape, how one trial runs, how a
 * candidate ranks, what its table says. The UI, math, and social matrices
 * carried three copies of everything here; two of them ran at import and
 * none of them tested their copy.
 */

/* ---------------------------------- argv --------------------------------- */

export const argValue = (name: string): Option.Option<string> => {
  const at = process.argv.indexOf(name)
  return Option.fromNullable(at < 0 ? undefined : process.argv[at + 1])
}

export const hasFlag = (name: string): boolean => process.argv.includes(name)

export const csv = (name: string, fallback: ReadonlyArray<string>): ReadonlyArray<string> =>
  Option.match(argValue(name), {
    onNone: () => fallback,
    onSome: (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean),
  })

export const positiveInt = (name: string, fallback: number): number =>
  Option.match(argValue(name), {
    onNone: () => fallback,
    onSome: (value) => {
      const parsed = Math.floor(Number(value))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    },
  })

/** `2026-09-05T12-00-00-000Z` — a filename-safe timestamp. */
export const fileStamp = (now: Date = new Date()): string =>
  now.toISOString().replaceAll(/[:.]/g, "-")

/* ---------------------------------- grid --------------------------------- */

export interface Cell<C, T> {
  readonly candidate: C
  readonly task: T
  /** 1-based, as the evidence names it. */
  readonly sample: number
}

export const grid = <C, T>(
  candidates: ReadonlyArray<C>,
  tasks: ReadonlyArray<T>,
  samples: number,
): ReadonlyArray<Cell<C, T>> =>
  candidates.flatMap((candidate) =>
    tasks.flatMap((task) =>
      Array.from({ length: samples }, (_, sample): Cell<C, T> => ({ candidate, task, sample: sample + 1 })),
    ),
  )

/* --------------------------------- trials -------------------------------- */

/** Interrupt the trial at its deadline and await scoped cleanup. Drivers must
 * bound browser/process shutdown themselves; abandoning a paid provider call
 * in a disconnected fiber would violate experiment cost and isolation bounds. */
export const cappedTrial = <A>(capMs: number, trial: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> =>
  trial.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(capMs),
      onTimeout: () =>
        `trial exceeded the ${capMs}ms execution deadline`,
    }),
  )

/** Every way a trial can die — a typed failure, a defect, an interruption —
 *  settles as the FAILED trial the caller shapes from the pretty cause. */
export const containTrialFailure = <A>(
  failed: (cause: string) => A,
  trial: Effect.Effect<A, unknown>,
): Effect.Effect<A> =>
  trial.pipe(Effect.catchAllCause((cause) => Effect.succeed(failed(Cause.pretty(cause)))))

export const persistJson = (path: string, value: unknown): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    },
    catch: (cause) => new Error(`failed to persist ${path}: ${String(cause)}`),
  })

/** `opencode-kimi-k2.6-medium-recipe-finder-1` — the parts, filename-safe. */
export const trialFileName = (parts: ReadonlyArray<string | number>): string =>
  parts.map(String).join("-").replaceAll(/[^a-z0-9.-]+/gi, "-").toLowerCase()

/** One settled trial to `<evidenceDir>/trials/<name>.json`, IMMEDIATELY —
 *  a campaign that dies later keeps every trial it finished. Best-effort
 *  and logged: a full disk must not turn evidence into an abort. */
export const persistTrial = (
  evidenceDir: string,
  name: string,
  version: string,
  trial: unknown,
): Effect.Effect<void> =>
  persistJson(join(evidenceDir, "trials", `${name}.json`), {
    version,
    recordedAt: new Date().toISOString(),
    trial,
  }).pipe(Effect.catchAll((error) => Effect.logWarning(String(error))))

/* -------------------------------- campaign ------------------------------- */

export interface CampaignOptions<C, T, Trial> {
  /** The log prefix: `ui-matrix`, `math-matrix`, `social-matrix`. */
  readonly name: string
  readonly cells: ReadonlyArray<Cell<C, T>>
  readonly concurrency: number
  /** The hard wall-clock cap for one cell. */
  readonly capMs: (cell: Cell<C, T>) => number
  /** One trial; its failures and defects are contained by the chassis. */
  readonly run: (cell: Cell<C, T>) => Effect.Effect<Trial, unknown>
  /** The failed-trial row for a cell whose run died, from the pretty cause. */
  readonly failed: (cell: Cell<C, T>, cause: string) => Trial
  readonly evidenceDir: string
  readonly trialVersion: string
  readonly trialName: (cell: Cell<C, T>) => string
  /** The one-line description logged before a cell runs. */
  readonly describe: (cell: Cell<C, T>) => string
  /** The one-line readout printed after a cell settles. */
  readonly summarize: (trial: Trial) => string
}

/**
 * Run every cell — log · cap · contain · persist · print — and hand back the
 * settled trials in cell order. Error channel `never`: a campaign always
 * yields a full set of rows, some of them failures.
 */
export const runCampaign = <C, T, Trial>(
  options: CampaignOptions<C, T, Trial>,
): Effect.Effect<ReadonlyArray<Trial>> =>
  Effect.forEach(
    options.cells,
    (cell) =>
      Effect.logInfo(`${options.name} ${options.describe(cell)}`).pipe(
        Effect.zipRight(
          containTrialFailure(
            (cause) => options.failed(cell, cause),
            cappedTrial(options.capMs(cell), options.run(cell)),
          ),
        ),
        Effect.tap((trial) =>
          persistTrial(options.evidenceDir, options.trialName(cell), options.trialVersion, trial),
        ),
        Effect.tap((trial) => Effect.sync(() => console.log(`  ${options.summarize(trial)}`))),
      ),
    { concurrency: options.concurrency },
  )

/** Runs the matrix ONLY when its file is the script invoked — importing a
 *  matrix (a test, a re-export) must never launch a live campaign. The
 *  program's number is the exit code; a failure prints and exits 1. */
export const runMatrixMain = (scriptName: string, program: Effect.Effect<number, unknown>): void => {
  if (process.argv[1]?.endsWith(scriptName) !== true) return
  Effect.runPromise(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(`${scriptName.replace(/\.ts$/, "")} failed: ${String(error)}`)
          return 1
        }),
      ),
    ),
  ).then(
    (code) => process.exit(code),
    (cause) => {
      console.error(`${scriptName.replace(/\.ts$/, "")} crashed: ${String(cause)}`)
      process.exit(2)
    },
  )
}
