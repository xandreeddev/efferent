import { type AgentMessage, compressToolResults } from "@efferent/sdk-core"
import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { includesAll, llmJudge, predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Headroom digest fidelity (fast tier).** Feed an oversized tool result
 * through `compressToolResults` and check the compression: head/tail facts
 * survive, the reversible marker is present, the output is far smaller than the
 * input, and (LLM judge) the fast-tier digest of the omitted middle reads as
 * faithful. Exercises the FAST role via `UtilityLlm` (present in the eval env).
 */

const BUDGET_CHARS = 2000

/** A large, neutral tool output: distinctive head + tail, bulky filler middle. */
const bigOutput = (head: string, tail: string): string => {
  const filler: Array<string> = []
  for (let i = 0; i < 1600; i++) {
    filler.push(`processing record ${i} of the import batch; status nominal; checksum ok`)
  }
  return `${head}\n${filler.join("\n")}\n${tail}\n`
}

const toolMessage = (text: string): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "t1", toolName: "Bash", output: { stdout: text } }],
})

/** Pull the (possibly compressed) stdout back out of the result message. */
const compressedStdout = (messages: ReadonlyArray<AgentMessage>): string => {
  const m = messages[0]
  if (m === undefined || m.role !== "tool") return ""
  const part = m.content[0]
  const output = part?.output as { readonly stdout?: unknown } | undefined
  return typeof output?.stdout === "string" ? output.stdout : ""
}

interface DigestInput {
  readonly content: string
}
interface DigestExpected {
  readonly mustSurvive: ReadonlyArray<string>
}

const CASES: ReadonlyArray<{ name: string; input: DigestInput; expected: DigestExpected }> = [
  {
    name: "build-log",
    input: { content: bigOutput("BUILD_ID=ABC123 using config.yaml", "RESULT=SUCCESS total=42") },
    expected: { mustSurvive: ["BUILD_ID=ABC123", "config.yaml", "RESULT=SUCCESS"] },
  },
]

export const headroomDigestEval = defineEval<DigestInput, string, DigestExpected, EvalEnv>({
  name: "headroom-digest",
  description: "oversized tool output is clipped with a reversible, faithful marker",
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    compressToolResults([toolMessage(input.content)], BUDGET_CHARS).pipe(
      Effect.map((rep) => compressedStdout(rep.messages)),
    ),
  scorers: [
    includesAll("facts_survive", ({ output, expected }) => ({
      haystack: output,
      needles: expected.mustSurvive,
    })),
    predicate(
      "compressed_with_marker",
      ({ input, output }) => output.length < input.content.length / 2 && output.includes("headroom"),
    ),
    llmJudge(
      "digest_fidelity",
      ({ output }) =>
        `A long tool output was compressed for an LLM's context. The compressed form is below; ` +
        `it should keep the start and end and replace the middle with a marker that says what was ` +
        `omitted and how to retrieve it (ideally with a short faithful summary).\n\n` +
        `<compressed>\n${output.slice(0, 2500)}\n</compressed>\n\n` +
        `Rubric: score 1.0 if the marker clearly flags the omission and any summary looks faithful ` +
        `and useful; 0.5 if present but weak; 0 if there's no marker or it's misleading.`,
    ),
  ],
})
