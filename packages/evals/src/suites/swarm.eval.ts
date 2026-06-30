import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import type { EvalEnv } from "../env.js"

/**
 * **Swarm end-to-end** — does the multi-agent fleet actually complete a REAL
 * task, research and coding? Unlike `feature`/`whole-task` (which test the coding
 * loop but let the agent choose whether to delegate), these cases *force* the
 * fleet path and the root to BLOCK on it, then check the real deliverable:
 *
 * - **research** → spawn `research-coordinator`, gather, synthesize a sourced answer.
 * - **coding**   → spawn `coordinator`, which delegates to a specialist + the
 *   architect, and lands the file change. (The Opus deliverable gate is stubbed
 *   `UnavailableVerifierLive` in the eval env — no `claude` — so this also
 *   exercises the fail-soft fallback to the architect verdict; the real Opus gate
 *   is verified live, see `docs/self-improving-loop.md`.)
 *
 * Live + network-dependent (real web search for research) + slow (a full fleet
 * per case) → key-gated, run sequentially. Scored on STRUCTURE (did the fleet
 * engage) + OUTCOME (sourced synthesis / the code change), not flaky web content.
 */

interface SwarmInput {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly readback?: ReadonlyArray<string>
}
interface SwarmExpected {
  readonly minSpawns: number
  /** All must appear (case-insensitive) in the final synthesized answer. */
  readonly outputIncludes?: ReadonlyArray<string>
  /** A readback file that must contain `needle` after the run. */
  readonly fileIncludes?: { readonly path: string; readonly needle: string }
}

const RESEARCH_PROMPT =
  "Research question: name 2–3 notable open-source agent/AI frameworks in the TypeScript ecosystem and one differentiator each. " +
  "This is a ONE-SHOT run, so you must BLOCK and deliver the answer yourself: " +
  'spawn the research fleet — run_agent({ agent: "research-coordinator", folder: ".", task: "<the question + return a sourced summary>" }) — ' +
  "then call wait_for_agents and LOOP it until allDone is true; do NOT end your turn until the fleet has finished. " +
  "Synthesize its findings into your FINAL message with at least one source URL (http...). Use search_web/web_fetch for real, current info."

const CODING_PROMPT =
  "Add a `multiply(a, b)` function to src/calc.ts that returns a*b, matching the typed arrow-function style of the existing `add`. " +
  "This is a ONE-SHOT run: delegate to the coding fleet — run_agent({ agent: \"coordinator\", folder: \"src\", task: \"<brief: add multiply to calc.ts, verify it typechecks>\" }) — " +
  "then wait_for_agents in a loop until it's done, and report what changed. Do NOT end your turn until the coordinator has delivered the change."

const CASES: ReadonlyArray<{
  name: string
  input: SwarmInput
  expected: SwarmExpected
}> = [
  {
    name: "research-fleet",
    input: { files: { "NOTES.md": "# scratch\n" }, prompt: RESEARCH_PROMPT },
    expected: { minSpawns: 1, outputIncludes: ["http"] },
  },
  {
    name: "coding-fleet",
    input: {
      files: { "src/calc.ts": "export const add = (a: number, b: number): number => a + b\n" },
      prompt: CODING_PROMPT,
      readback: ["src/calc.ts"],
    },
    expected: { minSpawns: 1, fileIncludes: { path: "src/calc.ts", needle: "multiply" } },
  },
]

const outcomeMet = (output: ScenarioRun, expected: SwarmExpected): boolean => {
  if (expected.fileIncludes !== undefined) {
    const f = output.files[expected.fileIncludes.path] ?? ""
    return f.includes(expected.fileIncludes.needle)
  }
  if (expected.outputIncludes !== undefined) {
    const t = output.finalText.toLowerCase()
    return expected.outputIncludes.every((n) => t.includes(n.toLowerCase()))
  }
  return output.finalText.trim().length > 150
}

export const swarmEval = defineEval<SwarmInput, ScenarioRun, SwarmExpected, EvalEnv>({
  name: "swarm",
  description: "the multi-agent fleet completes a real research task and a real coding task end-to-end",
  threshold: 0.5,
  concurrency: 1, // a full fleet per case — don't fan out
  data: CASES,
  task: (input) =>
    runScenario(input.files, input.prompt, {
      // The prompts command run_agent({ agent: "coordinator"/"research-coordinator" }),
      // so the fleet roster MUST be loaded — else the lead is UnknownAgent, nothing
      // spawns, and the whole suite scores 0 (the bug this opt-in fixes).
      includeFleet: true,
      ...(input.readback !== undefined ? { readback: input.readback } : {}),
    }),
  scorers: [
    // The fleet actually engaged (the root delegated and sub-agents spawned).
    predicate(
      "fleet_engaged",
      ({ output, expected }) =>
        output.trajectory.delegated && output.trajectory.spawns.length >= expected.minSpawns,
    ),
    // The deliverable is real: a sourced synthesis (research) or the code change (coding).
    predicate("delivered", ({ output, expected }) => outcomeMet(output, expected)),
  ],
})
