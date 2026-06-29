import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import { type CoderRun, runCoder } from "../support/coder.js"
import { loadDataset } from "../support/dataset.js"
import rawCases from "./data/toolSelection.dataset.json"
import type { EvalEnv } from "../env.js"

/**
 * Target 2 — **tool selection / first action**. Give the agent a small
 * workspace and a read-only intent, and check the FIRST tool it reaches for.
 * The loop is bounded: only read-only tools are allowed, and it stops after
 * the first tool turn (so a case costs ~1 LLM call and never mutates).
 *
 * Cases live in a versioned dataset file (`data/toolSelection.dataset.json`,
 * tagged + difficulty-labeled) loaded via `loadDataset` — the template for
 * migrating the other suites off inline literals.
 */

interface ToolInput {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface ToolExpected {
  readonly firstTool: string
}

const READ_ONLY = ["grep", "glob", "ls", "read_file", "read_skill"]

export const toolSelectionEval = defineEval<ToolInput, CoderRun, ToolExpected, EvalEnv>({
  name: "tool-selection",
  description: "first tool matches the intent (read-only, bounded to one turn)",
  threshold: 0.6,
  data: loadDataset<ToolInput, ToolExpected>(rawCases),
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
