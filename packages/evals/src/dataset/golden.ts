import type { EfficiencyBudget, RoutingExpectation } from "../support/scenarioScorers.js"

/**
 * The labeled golden scenario set for the quality scorecard. Each scenario
 * carries ground truth on three axes: an LLM-judge `rubric` (what "good"
 * means), an optional objective `expect` (substrings that must / must-not
 * appear in the produced file or answer), and `routing` labels (the expected
 * agent-selection behaviour). Routing labels assume a **distinct codeModel** is
 * configured (run the suite with `--code <model>`) — that's what exercises the
 * code-delegation policy; with no code tier, coding scenarios will (correctly)
 * score low on routing, which is itself the signal.
 *
 * Kept small + rubric-graded (no Docker) for fast iteration; objective
 * execution lives in the `repo-tasks` suite, folded into the nightly set later.
 */
export interface Scenario {
  readonly name: string
  readonly files: Record<string, string>
  readonly prompt: string
  /** Files to read back and feed the judge / objective check. Empty ⇒ judge the answer. */
  readonly readback?: ReadonlyArray<string>
  /** Objective outcome check over a produced file (or the final answer). */
  readonly expect?: {
    /** Which readback file to check; omitted ⇒ the agent's final text. */
    readonly file?: string
    readonly mustContain?: ReadonlyArray<string>
    readonly mustNotContain?: ReadonlyArray<string>
  }
  /** Anchored-rubric grading prompt for `qualityRubric`. */
  readonly rubric: string
  readonly routing?: RoutingExpectation
  readonly budget?: EfficiencyBudget
}

export const GOLDEN: ReadonlyArray<Scenario> = [
  {
    name: "bug-fix · off-by-one in one file",
    files: {
      "sum.ts":
        "export const sumTo = (n: number): number => {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n",
    },
    prompt:
      "sumTo(n) is meant to sum 1..n INCLUSIVE, but it stops at n-1 (sumTo(3) returns 3, should be 6). Fix the bug.",
    readback: ["sum.ts"],
    expect: { file: "sum.ts", mustContain: ["<= n"], mustNotContain: ["i < n;"] },
    rubric:
      "The loop now includes n so sumTo(3) === 6 (e.g. `i <= n` or equivalent). The fix is minimal — no unrelated rewrites, no new files.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 8 },
  },
  {
    name: "feature · add a small pure function to one file",
    files: {
      "strings.ts": "export const upper = (s: string): string => s.toUpperCase()\n",
    },
    prompt:
      "Add an exported `titleCase(s: string)` to strings.ts that upper-cases the first letter of each whitespace-separated word and lower-cases the rest.",
    readback: ["strings.ts"],
    expect: { file: "strings.ts", mustContain: ["titleCase"] },
    rubric:
      "strings.ts exports a correct `titleCase` (e.g. titleCase('hello world') === 'Hello World'). The existing `upper` is untouched; no unrelated changes.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 8 },
  },
  {
    name: "qa · explain a function (read-only)",
    files: {
      "rate.ts":
        "export const backoff = (attempt: number): number => Math.min(8000, 1000 * 2 ** attempt)\n",
    },
    prompt: "What does backoff() compute, and what's the maximum value it can return?",
    rubric:
      "Explains exponential backoff (1000ms doubled per attempt) and states the cap is 8000ms (8s). Accurate and concise.",
    routing: { shouldDelegate: false, codingTier: "general" },
    budget: { maxSteps: 5 },
  },
  {
    name: "qa · locate a definition (read-only)",
    files: {
      "a.ts": "export const config = { retries: 3 }\n",
      "b.ts": "import { config } from './a.js'\nexport const tries = config.retries\n",
    },
    prompt: "Where is `config` defined, and what is `config.retries`?",
    rubric:
      "Identifies config is defined in a.ts and retries is 3. Reads the files rather than guessing; does not edit anything.",
    routing: { shouldDelegate: false, codingTier: "general" },
    budget: { maxSteps: 5 },
  },
  {
    name: "refactor · rename a symbol across two files",
    files: {
      "math.ts": "export const add = (a: number, b: number): number => a + b\n",
      "use.ts": "import { add } from './math.js'\nexport const two = add(1, 1)\n",
    },
    prompt: "Rename `add` to `sum` everywhere (the export in math.ts and its use in use.ts). Keep behaviour identical.",
    readback: ["math.ts", "use.ts"],
    expect: { file: "math.ts", mustContain: ["sum"], mustNotContain: ["export const add"] },
    rubric:
      "`add` is renamed to `sum` in math.ts AND the import + call site in use.ts are updated consistently; nothing else changes.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 10 },
  },
]
