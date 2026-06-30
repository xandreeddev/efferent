import { defineEval } from "../framework/Eval.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import {
  orchestratorPurityScore,
  routingScore,
  type RoutingExpectation,
} from "../support/scenarioScorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Delegation decision** — the eval the recurring "the fleet never fired / the
 * root looped instead of delegating" complaint actually needs.
 *
 * Under the orchestrator design the root has NO work tools, so the rule is: any
 * task that touches the codebase is ROUTED to the right lead, and only pure
 * interaction stays direct. These prompts are NATURAL (no "delegate"/"spawn"
 * hint) — we measure the ROOT's own routing decision, captured deterministically
 * from the trajectory (`routingScore` + `orchestratorPurityScore`, no judge):
 *   - a coding task        → delegate to the `coordinator`        (`expectLead: "coordinator"`)
 *   - an investigation/Q&A → delegate to the `research-coordinator` (`expectLead: "research-coordinator"`)
 *   - pure interaction     → stay direct, no spawn                (`shouldDelegate: false`)
 *
 * `rootMustNotCode` is the regression guard for the live bug: a root that loops
 * on housekeeping (`update_plan`/`blackboard_read`/`list_scheduled_jobs`) and
 * never spawns a lead scores 0 (it can't touch a work tool, so "didn't code" is
 * meaningless on its own — the scorer also requires a delegation).
 *
 * Run with a DISTINCT code model so the coordinator's coders hit the code tier:
 *   bun run eval delegationDecision --main opencode:kimi-k2.6 --code opencode:glm-5.1 --samples 3
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly readback: ReadonlyArray<string>
}
interface Expected {
  readonly routing: RoutingExpectation
}

const UTIL = "export const greet = (name: string): string => `hi ${name}`\n"

// A small multi-file "app" with rough edges — the shape of the REAL failure: an
// OPEN-ENDED "improve this" task that requires reading several files and then
// editing a couple. This is what actually didn't delegate in practice.
const APP_FILES: Record<string, string> = {
  "src/app.ts":
    'import { runCommand } from "./commands"\n\nconst [name, ...rest] = process.argv.slice(2)\nrunCommand(name ?? "help", rest)\n',
  "src/commands.ts":
    'export const runCommand = (name: string, rest: ReadonlyArray<string>): void => {\n' +
    '  if (name === "help") return console.log(HELP)\n' +
    '  if (name === "greet") return console.log(`hello ${rest[0] ?? "world"}`)\n' +
    '  if (name === "status") {\n    // TODO: not implemented — prints nothing today\n  }\n' +
    '  console.log(`unknown command: ${name}`)\n}\n\n' +
    'const HELP = "commands: help, greet, status"\n',
}

const CASES: ReadonlyArray<{ name: string; input: Input; expected: Expected }> = [
  {
    // CODING → must route to the coordinator. A clear code edit, phrased as plain
    // work (no hint to delegate). The coordinator's coders hit the code tier.
    name: "coding-single-file",
    input: {
      files: { "src/util.ts": UTIL },
      prompt:
        "Add a new exported function `slugify(input: string): string` to src/util.ts that lowercases the input and replaces runs of whitespace with single hyphens. Keep the existing code.",
      readback: ["src/util.ts"],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        codingTier: "code",
        expectLead: "coordinator",
        rootMustNotCode: true,
      },
    },
  },
  {
    // CODING across two files → still the coordinator. "Small" is never an excuse.
    name: "coding-multi-file",
    input: {
      files: {
        "src/math.ts": "export const add = (a: number, b: number): number => a + b\n",
        "src/index.ts": "export { add } from './math'\n",
      },
      prompt:
        "Add a `multiply(a: number, b: number): number` function to src/math.ts and re-export it from src/index.ts alongside add.",
      readback: ["src/math.ts", "src/index.ts"],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        codingTier: "code",
        expectLead: "coordinator",
        rootMustNotCode: true,
      },
    },
  },
  {
    // THE REAL SHAPE — open-ended "improve this" across multiple files (research +
    // code). Coding work → must still route to the coordinator, however much
    // reading it takes first.
    name: "improve-cli-ux",
    input: {
      files: APP_FILES,
      prompt:
        "This tiny CLI has rough edges: the `status` command does nothing, and the help text doesn't explain what each command does. Look through src/ and improve the UX — make `status` actually report something useful, and rewrite the help so it describes each command.",
      readback: ["src/commands.ts"],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        codingTier: "code",
        expectLead: "coordinator",
        rootMustNotCode: true,
      },
    },
  },
  {
    // INVESTIGATION (read-only Q&A that needs the file) → the root has no read tool,
    // so it routes to the research-coordinator; no code-tier spend.
    name: "qa-readonly",
    input: {
      files: { "src/util.ts": UTIL },
      prompt:
        "Read src/util.ts and tell me, in one sentence, what the `greet` function returns. Do not modify any files.",
      readback: [],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        codingTier: "general",
        expectLead: "research-coordinator",
        rootMustNotCode: true,
      },
    },
  },
  {
    // INVESTIGATION (explain from a file) → research-coordinator, no code spend.
    name: "explain-readme",
    input: {
      files: { "README.md": "# widget\n\nA tiny widget toolkit for terminals.\n" },
      prompt:
        "Based on the README, summarize in one sentence what this project is. Don't write or change any code.",
      readback: [],
    },
    expected: {
      routing: {
        shouldDelegate: true,
        codingTier: "general",
        expectLead: "research-coordinator",
        rootMustNotCode: true,
      },
    },
  },
  {
    // PURE INTERACTION — a one-glance answer that needs no workspace access. The
    // root answers directly; no spawn. This is the only "stay direct" path left.
    name: "pure-interaction",
    input: {
      files: { "src/util.ts": UTIL },
      prompt: "In one line: what does the acronym 'CLI' stand for?",
      readback: [],
    },
    expected: { routing: { shouldDelegate: false } },
  },
]

export const delegationDecisionEval = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "delegationDecision",
  description:
    "natural tasks (no 'delegate' hint): coding routes to the coordinator, investigation to the research-coordinator, pure interaction stays direct — and the root never loops on housekeeping",
  threshold: 0.6,
  // A full real run per case (the root delegates to a lead) → don't fan out.
  concurrency: 1,
  data: CASES,
  // includeFleet: with a lead in the roster the root is the orchestrator (no work
  // tools); without it there is no lead to route to and nothing can delegate.
  task: (input) =>
    runScenario(input.files, input.prompt, { includeFleet: true, readback: input.readback }),
  scorers: [routingScore("routing"), orchestratorPurityScore("purity")],
})
