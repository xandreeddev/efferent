import { defineEval } from "../framework/Eval.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import {
  orchestratorPurityScore,
  routingScore,
  type RoutingExpectation,
} from "../support/scenarioScorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Orchestration purity** — the root must be a pure top-level orchestrator:
 * for any real work it routes through a LEAD (coordinator / research-coordinator)
 * and does **nil coding/research itself**; only pure conversation stays at the
 * root. This is the "stop the root half-delegating" eval (the `bc1b8fef` run did
 * 18 edits + 65 reads itself AND flat-fanned-out 14 workers with no coordinator).
 *
 * Scored deterministically from the run trajectory (no judge):
 *   - `routingScore` — did it delegate / fan out / hit the right tier;
 *   - `orchestratorPurityScore` — did the root keep its hands off the work
 *     (`rootTools` orchestration-only) and route through the named lead.
 *
 * MUST run with a DISTINCT code model (so the `# Writing code` policy is emitted)
 * and `includeFleet: true` is set by the task so the coordinator/researcher roster
 * exists to delegate to:
 *   bun run eval orchestration --main opencode:kimi-k2.6 --code opencode:glm-5.1 --samples 3
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly readback: ReadonlyArray<string>
}
interface Expected {
  readonly routing: RoutingExpectation
}

// Three INDEPENDENT areas — the breadth shape that should route to a coordinator
// which fans out one coder per area (not the root editing all three itself).
const MULTI_AREA: Record<string, string> = {
  "src/auth.ts":
    "export const login = (u: string): string => {\n  // TODO: validate the username\n  return `token-${u}`\n}\n",
  "src/format.ts":
    "export const money = (n: number): string => `$${n}`\n  // TODO: handle cents + thousands separators\n",
  "src/log.ts":
    "export const log = (m: string): void => {\n  console.log(m) // TODO: add a timestamp + level\n}\n",
}

const CASES: ReadonlyArray<{ name: string; input: Input; expected: Expected }> = [
  {
    // Multi-area code → route through the coordinator, which fans out coders.
    // The root must not edit anything itself.
    name: "multi-area-code",
    input: {
      files: MULTI_AREA,
      prompt:
        "Three independent improvements, one per file: in src/auth.ts validate the username (non-empty, no spaces); in src/format.ts format cents and thousands separators; in src/log.ts prefix each line with an ISO timestamp and a level. These are independent — get them all done.",
      readback: ["src/auth.ts", "src/format.ts", "src/log.ts"],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        expectLead: "coordinator",
        rootMustNotCode: true,
        minSpawns: 3,
        codingTier: "code",
      },
    },
  },
  {
    // Broad investigation → research-coordinator + ≥2 researchers; root does no
    // search/read itself.
    name: "broad-research",
    input: {
      files: {
        "src/a.ts": "export const a = 1\n",
        "src/b.ts": "export const b = 2\n",
        "docs/notes.md": "# notes\n\nthe widths come from the config layer.\n",
      },
      prompt:
        "Investigate how configuration flows through this project and where the defaults come from — look across the source and the docs, and give me a sourced summary of the config story. Don't change any files.",
      readback: [],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        expectLead: "research-coordinator",
        rootMustNotCode: true,
        minSpawns: 2,
      },
    },
  },
  {
    // Even a one-line code fix → still routes through a coordinator (always
    // orchestrate); the root does no edit_file itself.
    name: "one-line-fix",
    input: {
      files: { "src/util.ts": "export const greet = (n: string): string => `hi ${n}`\n" },
      prompt:
        "Rename the `greet` function to `hello` in src/util.ts (keep the body and the export).",
      readback: ["src/util.ts"],
    },
    expected: {
      routing: { shouldDelegate: true, expectLead: "coordinator", rootMustNotCode: true },
    },
  },
  {
    // Pure conversation (no real work) → the root answers directly, no spawn.
    // The over-spawn guard: it must NOT fire a coordinator for a non-task.
    name: "conversational",
    input: {
      files: { "src/util.ts": "export const greet = (n: string): string => `hi ${n}`\n" },
      prompt: "Hey — in one sentence, what would you do to add a test runner to a project like this? Don't make any changes.",
      readback: [],
    },
    expected: { routing: { shouldDelegate: false } },
  },
]

export const orchestrationEval = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "orchestration",
  description:
    "the root orchestrates: real work routes through a coordinator/research-coordinator and the root does nil coding/research itself; pure conversation stays direct",
  threshold: 0.6,
  // Full real runs with a fleet per case → don't fan out cases.
  concurrency: 1,
  data: CASES,
  task: (input) =>
    runScenario(input.files, input.prompt, { includeFleet: true, readback: input.readback }),
  scorers: [routingScore("routing"), orchestratorPurityScore("orchestrator_purity")],
})
