import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import { type CoderRun, runCoder } from "../support/coder.js"
import type { EvalEnv } from "../env.js"

/**
 * Coverage for the BACKGROUND-PROCESS tools (`Bash(run_in_background)` +
 * `bash_output` + `kill_bash`) shipped with the shell PR. These had unit tests
 * for the adapter but no BEHAVIORAL eval — does the agent actually reach for them
 * when a task needs a process that outlives one tool call? (tmux `session_*` is
 * not covered here: the eval env has no tmux, by design.)
 *
 * Scored deterministically on tool USAGE + outcome — no LLM judge. A low score is
 * honest signal that the capability isn't being used, not a flake.
 */
interface BgInput {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface BgExpected {
  /** The background tool this task should drive. */
  readonly requiredTool: "bash_output" | "kill_bash"
  /** Substring the final answer must contain (the achieved outcome). */
  readonly mustContain?: string
}

const BG_TOOLS = ["Bash", "bash_output", "kill_bash", "read_file", "ls", "update_plan"]

const CASES: ReadonlyArray<{ name: string; input: BgInput; expected: BgExpected }> = [
  {
    name: "background-then-read",
    input: {
      files: { "README.md": "# scratch\n" },
      prompt:
        "Start the command `bash -c 'sleep 2; echo RESULT=42'` as a BACKGROUND process (do not block on it), " +
        "then read its output once it finishes and tell me the value it printed.",
    },
    expected: { requiredTool: "bash_output", mustContain: "42" },
  },
  {
    name: "background-kill",
    input: {
      files: { "README.md": "# scratch\n" },
      prompt:
        "Start a long-running background process `bash -c 'sleep 60'`, confirm it is running, then kill it. " +
        "Report that you started and stopped it.",
    },
    expected: { requiredTool: "kill_bash" },
  },
]

export const backgroundShellEval = defineEval<BgInput, CoderRun, BgExpected, EvalEnv>({
  name: "background-shell",
  description: "the agent uses run_in_background / bash_output / kill_bash when a task needs them",
  threshold: 0.5,
  data: CASES,
  task: (input) => runCoder(input.files, input.prompt, { allowTools: BG_TOOLS }),
  scorers: [
    predicate("used_required_tool", ({ output, expected }) =>
      output.tools.includes(expected.requiredTool),
    ),
    predicate("outcome", ({ output, expected }) =>
      expected.mustContain === undefined ? true : output.finalText.includes(expected.mustContain),
    ),
  ],
})
