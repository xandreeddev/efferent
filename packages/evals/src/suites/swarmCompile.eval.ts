import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { fromEffect, predicate } from "../framework/scorers.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import type { EvalEnv } from "../env.js"

/**
 * **Swarm-compile** — when the fleet WRITES code, does it actually COMPILE?
 *
 * This is the regression guard for the exact failure that motivated the
 * self-verifying-swarm work: a fleet that shipped non-compiling TypeScript
 * (a hallucinated `import { Semaphore } from "effect"`, a `yield*` outside a
 * generator) and still reported "done", because nothing in the swarm ran the
 * project's typecheck as a definition of done. The sibling `swarm` suite only
 * asserts a *substring* is present in the file, and `bun test` can't catch a
 * type error (Bun strips types at load) — so neither would have caught it.
 *
 * Here the fleet is forced (as in `swarm`), the change requires real type
 * work (narrowing a discriminated union under `strict`), and the objective
 * `compiles` scorer type-checks the produced files in-process (`runScenario`'s
 * `typecheck`). `gate: { scorer: "compiles" }` makes pass^k gate on compilation,
 * not on the blended mean — a run that ships broken code scores 0 no matter how
 * confident its summary. With the self-verifying prompts (the fleet runs the
 * project's checks and fixes failures before returning), the change compiles.
 *
 * Live + slow (a full fleet per case) → key-gated, run sequentially.
 */

interface SwarmCompileInput {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly readback: ReadonlyArray<string>
}
interface SwarmCompileExpected {
  readonly minSpawns: number
  /** The change must land: this needle must appear in the readback file. */
  readonly fileIncludes: { readonly path: string; readonly needle: string }
}

// A self-contained TS module (no external imports, so a compile failure means the
// swarm's code is genuinely broken, never a missing dependency) with a
// discriminated union — the kind of type that a coder who doesn't run typecheck
// gets wrong (accessing `.value` on the un-narrowed union is a type error).
const RESULT_TS =
  `export type Result<T> =\n` +
  `  | { readonly ok: true; readonly value: T }\n` +
  `  | { readonly ok: false; readonly error: string }\n\n` +
  `export const ok = <T>(value: T): Result<T> => ({ ok: true, value })\n` +
  `export const err = <T>(error: string): Result<T> => ({ ok: false, error })\n`

const CODING_PROMPT =
  "Add a strictly-typed `mapResult<T, U>(r: Result<T>, f: (value: T) => U): Result<U>` to src/result.ts. " +
  "When `r.ok` is true, return a new ok Result holding `f(r.value)`; otherwise pass the error Result through unchanged. " +
  "Match the existing typed style, and the file MUST typecheck under strict TypeScript. " +
  'This is a ONE-SHOT run: delegate to the coding fleet — run_agent({ agent: "coordinator", folder: "src", ' +
  'task: "<brief: add a strictly-typed mapResult to src/result.ts, run the project\'s typecheck, and fix any error before returning>" }) — ' +
  "then wait_for_agents in a loop until it's done, and report what changed. Do NOT end your turn until the coordinator has delivered a change that typechecks."

const CASES: ReadonlyArray<{
  name: string
  input: SwarmCompileInput
  expected: SwarmCompileExpected
}> = [
  {
    name: "coding-fleet-compiles",
    input: {
      files: { "src/result.ts": RESULT_TS },
      prompt: CODING_PROMPT,
      readback: ["src/result.ts"],
    },
    expected: {
      minSpawns: 1,
      fileIncludes: { path: "src/result.ts", needle: "mapResult" },
    },
  },
]

export const swarmCompileEval = defineEval<
  SwarmCompileInput,
  ScenarioRun,
  SwarmCompileExpected,
  EvalEnv
>({
  name: "swarm-compile",
  description:
    "when the multi-agent fleet writes code, the deliverable actually type-checks (regression guard for shipping non-compiling code)",
  threshold: 0.5,
  // pass^k gates on the OBJECTIVE compile, not the blended mean — a run whose
  // code doesn't typecheck scores 0 regardless of the substring/engagement checks.
  gate: { scorer: "compiles", min: 1 },
  concurrency: 1, // a full fleet per case — don't fan out
  data: CASES,
  task: (input) =>
    runScenario(input.files, input.prompt, {
      includeFleet: true,
      readback: input.readback,
      // The objective discriminator: type-check the produced files (in-process).
      typecheck: true,
    }),
  scorers: [
    // The objective compile discriminator — the gate scorer.
    fromEffect<SwarmCompileInput, ScenarioRun, SwarmCompileExpected, never, never>(
      "compiles",
      ({ output }) =>
        Effect.sync(() => {
          const r = output.typecheckResult
          if (r === undefined) return { score: 0, detail: "no typecheck result" }
          return r.ok
            ? { score: 1, detail: "typechecks" }
            : { score: 0, detail: `${r.errors} error(s): ${r.output.slice(0, 300)}` }
        }),
    ),
    // The fleet actually engaged (the root delegated and sub-agents spawned).
    predicate(
      "fleet_engaged",
      ({ output, expected }) =>
        output.trajectory.delegated &&
        output.trajectory.spawns.length >= expected.minSpawns,
    ),
    // The change actually landed (not just an empty "done").
    predicate("delivered", ({ output, expected }) =>
      (output.files[expected.fileIncludes.path] ?? "").includes(
        expected.fileIncludes.needle,
      ),
    ),
  ],
})
