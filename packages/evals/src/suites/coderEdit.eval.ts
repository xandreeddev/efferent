import { defineEval } from "../framework/Eval.js"
import { includesAll, llmJudge, predicate } from "../framework/scorers.js"
import { type CoderRun, runCoder } from "../support/coder.js"
import type { EvalEnv } from "../env.js"

/**
 * Target 3 — **coder edit, end-to-end**. Give the agent a tiny repo and an
 * edit instruction, let the full loop run, then read the target file back and
 * check the change actually landed (deterministic) + judge its correctness.
 */

interface EditInput {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly target: string
}
interface EditExpected {
  readonly mustContain: ReadonlyArray<string>
  readonly mustNotContain?: ReadonlyArray<string>
}

const CASES: ReadonlyArray<{ name: string; input: EditInput; expected: EditExpected }> = [
  {
    name: "add-function",
    input: {
      files: { "src/util.ts": "export const add = (a: number, b: number): number => a + b\n" },
      target: "src/util.ts",
      prompt:
        "Add a `subtract(a, b)` function to src/util.ts that returns a - b, exported the same way as `add`. Keep `add`.",
    },
    expected: { mustContain: ["subtract", "a - b", "add"] },
  },
  {
    name: "rename-literal",
    input: {
      files: {
        "src/greet.ts": "export function greet(name: string) {\n  return `Hi, ${name}`\n}\n",
      },
      target: "src/greet.ts",
      prompt: "In src/greet.ts change the greeting from `Hi,` to `Hello,`. Keep everything else identical.",
    },
    expected: { mustContain: ["Hello,"], mustNotContain: ["Hi,"] },
  },
  {
    name: "fix-clamp-bug",
    input: {
      files: {
        "src/clamp.ts":
          "export const clamp = (n: number, lo: number, hi: number): number =>\n  n < lo ? lo : n > hi ? lo : n\n",
      },
      target: "src/clamp.ts",
      prompt:
        "There's a bug in src/clamp.ts: when n is greater than hi it returns lo instead of hi. Fix the upper bound.",
    },
    expected: { mustContain: ["hi : n"], mustNotContain: ["n > hi ? lo"] },
  },
]

export const coderEditEval = defineEval<EditInput, CoderRun, EditExpected, EvalEnv>({
  name: "coder-edit",
  description: "the requested edit actually lands in the target file",
  threshold: 0.6,
  data: CASES,
  task: (input) => runCoder(input.files, input.prompt, { readback: [input.target] }),
  scorers: [
    predicate("edit_applied", ({ input, output, expected }) => {
      const content = output.files[input.target] ?? ""
      const has = expected.mustContain.every((s) => content.includes(s))
      const hasnt = (expected.mustNotContain ?? []).every((s) => !content.includes(s))
      return has && hasnt
    }),
    includesAll("contains_expected", ({ input, output, expected }) => ({
      haystack: output.files[input.target] ?? "",
      needles: expected.mustContain,
    })),
    llmJudge(
      "edit_correctness",
      ({ input, output }) =>
        `A coding agent was asked:\n"${input.prompt}"\n\n` +
        `The file ${input.target} now contains:\n---\n${output.files[input.target] ?? "(missing)"}\n---\n\n` +
        `Rubric: score 1.0 if the change correctly and completely satisfies the request with no obvious breakage; ` +
        `0.5 if partial; 0 if the file is unchanged, wrong, or broken.`,
    ),
  ],
})
