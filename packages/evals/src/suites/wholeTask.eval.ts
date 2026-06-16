import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { fromEffect, llmJudge, predicate } from "../framework/scorers.js"
import { type CoderRun, runCoder } from "../support/coder.js"
import type { EvalEnv } from "../env.js"

/**
 * **Whole-task, end-to-end.** Each case is a tiny temp repo + a real prompt run
 * through the FULL agent loop. Quality is the scored mean (deterministic
 * file/answer checks weighted over one LLM judge); cost/tokens/steps are
 * RECORDED as metrics (via `metricsOf`), not scored — so a cheaper model isn't
 * penalised on correctness; the comparison table is where cost is weighed.
 *
 * Cases mix synthetic + realistic-mini shapes: bug-fix, multi-file feature,
 * refactor, failing-test fix, and a read-only investigation.
 */

const READ_ONLY = ["grep", "glob", "ls", "read_file", "read_skill"] as const

interface WholeTaskInput {
  readonly files: Record<string, string>
  readonly prompt: string
  /** Files read back from the workspace for content assertions. */
  readonly readback: ReadonlyArray<string>
  /** Bound the run to read-only tools (for investigation / Q&A cases). */
  readonly readOnly?: boolean
}

interface WholeTaskExpected {
  /** `path → substrings that must be present` in that file after the run. */
  readonly mustContain?: Record<string, ReadonlyArray<string>>
  /** `path → substrings that must be ABSENT` after the run. */
  readonly mustNotContain?: Record<string, ReadonlyArray<string>>
  /** Substrings the final answer must include (case-insensitive). */
  readonly answerIncludes?: ReadonlyArray<string>
  /** One-line rubric for the LLM judge. */
  readonly rubric: string
}

/** Tally positive checks (file substrings + answer substrings) and forbidden ones. */
const collectChecks = (
  output: CoderRun,
  expected: WholeTaskExpected,
): { readonly coverage: number; readonly met: boolean } => {
  const positives: Array<boolean> = []
  for (const [path, subs] of Object.entries(expected.mustContain ?? {})) {
    const content = output.files[path] ?? ""
    for (const s of subs) positives.push(content.includes(s))
  }
  const answer = output.finalText.toLowerCase()
  for (const s of expected.answerIncludes ?? []) positives.push(answer.includes(s.toLowerCase()))

  let forbiddenPresent = false
  for (const [path, subs] of Object.entries(expected.mustNotContain ?? {})) {
    const content = output.files[path] ?? ""
    for (const s of subs) if (content.includes(s)) forbiddenPresent = true
  }

  const hits = positives.filter(Boolean).length
  const coverage = positives.length === 0 ? 1 : hits / positives.length
  return { coverage, met: hits === positives.length && !forbiddenPresent }
}

const CASES: ReadonlyArray<{
  name: string
  input: WholeTaskInput
  expected: WholeTaskExpected
}> = [
  {
    name: "bug-fix",
    input: {
      files: {
        "src/clamp.ts":
          "export const clamp = (n: number, lo: number, hi: number): number =>\n  n < lo ? lo : n > hi ? lo : n\n",
      },
      prompt:
        "There's a bug in src/clamp.ts: when n is greater than hi it returns lo instead of hi. Fix the upper bound.",
      readback: ["src/clamp.ts"],
    },
    expected: {
      mustContain: { "src/clamp.ts": ["hi : n"] },
      mustNotContain: { "src/clamp.ts": ["hi ? lo"] },
      rubric: "The clamp now returns hi when n > hi, and lo when n < lo; nothing else broke.",
    },
  },
  {
    name: "multi-file-feature",
    input: {
      files: {
        "src/math.ts": "export const add = (a: number, b: number): number => a + b\n",
        "src/index.ts": 'import { add } from "./math"\n\nexport const sum = (a: number, b: number) => add(a, b)\n',
      },
      prompt:
        "Add a `double(n)` function to src/math.ts that returns n * 2 (exported like `add`, keep `add`). Then in src/index.ts add and export `quad(n)` that returns double(double(n)), importing double from ./math.",
      readback: ["src/math.ts", "src/index.ts"],
    },
    expected: {
      mustContain: { "src/math.ts": ["double"], "src/index.ts": ["quad", "double"] },
      rubric:
        "src/math.ts exports a correct `double`; src/index.ts exports `quad` using double(double(n)); `add` is intact.",
    },
  },
  {
    name: "refactor-extract-const",
    input: {
      files: {
        "src/status.ts":
          'export const isInactive = (s: string): boolean => s === "INACTIVE"\nexport const label = (s: string): string => (s === "INACTIVE" ? "off" : "on")\n',
      },
      prompt:
        'In src/status.ts, extract the repeated string literal "INACTIVE" into a single top-level `const STATUS_INACTIVE = "INACTIVE"` and use it in both places. Behaviour must be identical.',
      readback: ["src/status.ts"],
    },
    expected: {
      mustContain: { "src/status.ts": ["STATUS_INACTIVE", '= "INACTIVE"'] },
      rubric:
        "A single STATUS_INACTIVE constant is defined and used in both comparisons; behaviour is unchanged.",
    },
  },
  {
    name: "failing-test-fix",
    input: {
      files: {
        "src/sum.ts": "export const sum = (ns: ReadonlyArray<number>): number =>\n  ns.reduce((a, b) => a + b, 1)\n",
        "src/sum.test.ts":
          'import { expect, test } from "bun:test"\nimport { sum } from "./sum"\n\ntest("sums to 6", () => {\n  expect(sum([1, 2, 3])).toBe(6)\n})\n',
      },
      prompt:
        "The test in src/sum.test.ts fails because src/sum.ts has a bug. Fix src/sum.ts so the test passes. Do not change the test.",
      readback: ["src/sum.ts"],
    },
    expected: {
      mustContain: { "src/sum.ts": ["a + b, 0"] },
      mustNotContain: { "src/sum.ts": ["a + b, 1"] },
      rubric: "sum now reduces from an initial value of 0, so sum([1,2,3]) === 6.",
    },
  },
  {
    name: "investigation-readonly",
    input: {
      files: {
        "src/config.ts":
          "export const parseConfig = (raw: string): number => Number(raw)\n",
        "src/app.ts": 'import { parseConfig } from "./config"\n\nexport const boot = (s: string) => parseConfig(s) + 1\n',
      },
      prompt:
        "Without editing anything, tell me which file defines `parseConfig` and what type it returns.",
      readback: [],
      readOnly: true,
    },
    expected: {
      answerIncludes: ["config.ts", "number"],
      rubric: "The answer correctly names src/config.ts and says parseConfig returns a number.",
    },
  },
]

export const wholeTaskEval = defineEval<WholeTaskInput, CoderRun, WholeTaskExpected, EvalEnv>({
  name: "whole-task",
  description: "end-to-end agent tasks: the change lands / the question is answered",
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    runCoder(input.files, input.prompt, {
      readback: input.readback,
      ...(input.readOnly === true ? { allowTools: [...READ_ONLY] } : {}),
    }),
  scorers: [
    predicate("expectations_met", ({ output, expected }) => collectChecks(output, expected).met),
    fromEffect("coverage", ({ output, expected }) =>
      Effect.succeed(collectChecks(output, expected).coverage),
    ),
    llmJudge(
      "correctness",
      ({ input, output, expected }) =>
        `A coding agent was asked:\n"${input.prompt}"\n\n` +
        `Final answer:\n${output.finalText.slice(0, 1500) || "(none)"}\n\n` +
        `Files after the run:\n${
          Object.entries(output.files)
            .map(([p, c]) => `--- ${p} ---\n${c}`)
            .join("\n") || "(no files read back)"
        }\n\n` +
        `Rubric: score 1.0 if this fully satisfies the request (${expected.rubric}); ` +
        `0.5 if partial; 0 if wrong, unchanged, or broken.`,
    ),
  ],
})
