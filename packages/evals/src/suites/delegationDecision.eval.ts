import { defineEval } from "../framework/Eval.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import { routingScore, type RoutingExpectation } from "../support/scenarioScorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Delegation decision** — the eval the recurring "the fleet never fired / it
 * coded on the general model instead of a code agent" complaint actually needs.
 *
 * The rule it encodes (the user's, verbatim): **any CODING task is delegated to
 * the code tier; everything else (Q&A, reading, explaining) stays on the general
 * model and does NOT delegate.** Unlike `swarm.eval` — which *orders* the model
 * to "spawn the fleet" and only checks the fleet finishes — these prompts are
 * NATURAL: no "delegate", no "spawn", no "use a sub-agent". We measure the
 * ROOT's own routing decision, captured deterministically from the run
 * trajectory (`routingScore`, no judge):
 *   - a coding task  → `shouldDelegate: true`,  `codingTier: "code"`   (must hit the code tier)
 *   - a read-only/Q&A → `shouldDelegate: false`, `codingTier: "general"` (no spawn, no code spend)
 *
 * MUST be run with a DISTINCT code model or the `# Writing code` policy is never
 * emitted and the code-tier checks can't pass — that's the whole point:
 *   bun run eval delegationDecision --main opencode:kimi-k2.6 --code opencode:glm-5.1 --samples 3
 *
 * The default committed baselines run on gemini/sonnet with NO code tier, which
 * is exactly why routing looked green while real (kimi, codeModel-set) runs
 * coded on the general model.
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
// editing a couple. This is what actually didn't delegate in practice (a complex
// research+code task), unlike the toy "add function X" cases above.
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
    // CODING → must delegate to the code tier. A clear, unambiguous code edit,
    // phrased as plain work (no hint to delegate).
    name: "coding-single-file",
    input: {
      files: { "src/util.ts": UTIL },
      prompt:
        "Add a new exported function `slugify(input: string): string` to src/util.ts that lowercases the input and replaces runs of whitespace with single hyphens. Keep the existing code.",
      readback: ["src/util.ts"],
    },
    expected: { routing: { shouldDelegate: true, codingTier: "code" } },
  },
  {
    // CODING across two files → still the code tier. "Small" is never an excuse.
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
    expected: { routing: { shouldDelegate: true, codingTier: "code" } },
  },
  {
    // THE REAL SHAPE — open-ended "improve this" across multiple files (research +
    // code), exactly the kind of task that didn't delegate in practice. Coding work
    // → must still route to the code tier, however much reading it takes first.
    name: "improve-cli-ux",
    input: {
      files: APP_FILES,
      prompt:
        "This tiny CLI has rough edges: the `status` command does nothing, and the help text doesn't explain what each command does. Look through src/ and improve the UX — make `status` actually report something useful, and rewrite the help so it describes each command.",
      readback: ["src/commands.ts"],
    },
    expected: { routing: { shouldDelegate: true, codingTier: "code" } },
  },
  {
    // NON-coding (read-only Q&A) → stay on general, do NOT delegate, no code spend.
    name: "qa-readonly",
    input: {
      files: { "src/util.ts": UTIL },
      prompt:
        "Read src/util.ts and tell me, in one sentence, what the `greet` function returns. Do not modify any files.",
      readback: [],
    },
    expected: { routing: { shouldDelegate: false, codingTier: "general" } },
  },
  {
    // NON-coding (explain) → stay on general, no delegation.
    name: "explain-readme",
    input: {
      files: { "README.md": "# widget\n\nA tiny widget toolkit for terminals.\n" },
      prompt:
        "Based on the README, summarize in one sentence what this project is. Don't write or change any code.",
      readback: [],
    },
    expected: { routing: { shouldDelegate: false, codingTier: "general" } },
  },
]

export const delegationDecisionEval = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "delegationDecision",
  description:
    "natural tasks (no 'delegate' hint): a coding task routes to the code tier; a read-only/Q&A task stays on general and does not delegate",
  threshold: 0.6,
  // A full real run per case (the root may spawn a code worker) → don't fan out.
  concurrency: 1,
  data: CASES,
  task: (input) => runScenario(input.files, input.prompt, { readback: input.readback }),
  scorers: [routingScore("routing")],
})
