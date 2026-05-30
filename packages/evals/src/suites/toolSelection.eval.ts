import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import { type CoderRun, runCoder } from "../support/coder.js"
import type { EvalEnv } from "../env.js"

/**
 * Target 2 — **tool selection / first action**. Give the agent a small
 * workspace and a read-only intent, and check the FIRST tool it reaches for.
 * The loop is bounded: only read-only tools are allowed, and it stops after
 * the first tool turn (so a case costs ~1 LLM call and never mutates).
 */

interface ToolInput {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface ToolExpected {
  readonly firstTool: string
}

const READ_ONLY = ["grep", "glob", "ls", "read_file", "read_skill"]

const CASES: ReadonlyArray<{ name: string; input: ToolInput; expected: ToolExpected }> = [
  {
    name: "search-for-symbol",
    input: {
      files: {
        "src/math.ts":
          "export const add = (a: number, b: number) => a + b\nexport const mul = (a: number, b: number) => a * b\n",
        "src/index.ts": "import { add } from './math'\nconsole.log(add(1, 2))\n",
      },
      prompt:
        "Search the codebase for where `mul` is defined and tell me the file and line. Do not change anything.",
    },
    expected: { firstTool: "grep" },
  },
  {
    name: "read-named-file",
    input: {
      files: { "config.json": '{ "port": 8088, "host": "localhost" }\n' },
      prompt: "Read config.json and tell me which port the server uses. Don't edit anything.",
    },
    expected: { firstTool: "read_file" },
  },
  {
    name: "list-directory",
    input: {
      files: {
        "src/a.ts": "export const a = 1\n",
        "src/b.ts": "export const b = 2\n",
        "src/nested/c.ts": "export const c = 3\n",
      },
      prompt: "List the files directly inside the src directory. Don't modify anything.",
    },
    expected: { firstTool: "ls" },
  },
]

export const toolSelectionEval = defineEval<ToolInput, CoderRun, ToolExpected, EvalEnv>({
  name: "tool-selection",
  description: "first tool matches the intent (read-only, bounded to one turn)",
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    runCoder(input.files, input.prompt, {
      allowTools: READ_ONLY,
      stopAfterFirstToolTurn: true,
    }),
  scorers: [
    predicate("first_tool_exact", ({ output, expected }) => output.tools[0] === expected.firstTool),
    predicate("used_expected_tool", ({ output, expected }) =>
      output.tools.includes(expected.firstTool),
    ),
  ],
})
