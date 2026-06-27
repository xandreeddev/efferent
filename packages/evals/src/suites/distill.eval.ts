import { type AgentMessage, type Candidate, distill } from "@xandreed/sdk-core"
import { defineEval } from "../framework/Eval.js"
import { includesAll, predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Distiller (Reflector)** — the cheap mining half of the self-improving loop
 * (`docs/self-improving-loop.md`). Given a finished session transcript, does the
 * fast tier extract a reusable lesson when there is one, and stay quiet when
 * there isn't? One fast call per case → cheap. Deterministic presence scoring +
 * a lenient keyword check; the Opus verify GATE is exercised separately (it
 * needs the `claude` binary, not a provider key, so it can't run here).
 */

interface DistillCaseInput {
  readonly messages: ReadonlyArray<AgentMessage>
}
interface DistillExpected {
  readonly wantsCandidate: boolean
  readonly keywords?: ReadonlyArray<string>
}

const t = (toolCallId: string, toolName: string, input: unknown): AgentMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId, toolName, input }],
})
const r = (toolCallId: string, toolName: string, output: string, isError = false): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId, toolName, output, isError }],
})
const say = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] })

// A session with a clear, recurring lesson: editing the schema without updating
// the matching decoder breaks the typecheck — exactly the kind of mistake a
// constraint should capture so it never recurs.
const TYPECHECK_SESSION: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Add an `autoCollapse` field to the Settings schema." },
  t("1", "edit_file", { path: "Settings.ts", oldText: "model: Schema.String", newText: "model: Schema.String,\n  autoCollapse: Schema.Boolean" }),
  r("1", "edit_file", "edited Settings.ts"),
  t("2", "Bash", { command: "bun run typecheck" }),
  r("2", "Bash", "error TS2741: property 'autoCollapse' missing in the Settings decoder", true),
  say("The schema and its decoder must move together — updating the decoder too."),
  t("3", "edit_file", { path: "settingsDecoder.ts", oldText: "{ model }", newText: "{ model, autoCollapse }" }),
  r("3", "edit_file", "edited settingsDecoder.ts"),
  t("4", "Bash", { command: "bun run typecheck" }),
  r("4", "Bash", "0 errors"),
  say("Done — schema + decoder updated together, typecheck green."),
]

// Nothing to learn.
const CHITCHAT: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "thanks, that's perfect!" },
  say("You're welcome!"),
]

const CASES: ReadonlyArray<{
  name: string
  input: DistillCaseInput
  expected: DistillExpected
}> = [
  {
    name: "typecheck-lesson",
    input: { messages: TYPECHECK_SESSION },
    expected: { wantsCandidate: true, keywords: ["schema"] },
  },
  {
    name: "nothing-to-learn",
    input: { messages: CHITCHAT },
    expected: { wantsCandidate: false },
  },
]

export const distillEval = defineEval<
  DistillCaseInput,
  ReadonlyArray<Candidate>,
  DistillExpected,
  EvalEnv
>({
  name: "distill",
  description: "the reflector mines a reusable lesson when there is one, and stays quiet when there isn't",
  threshold: 0.5,
  concurrency: 2,
  data: CASES,
  task: (input) => distill({ conversationId: "eval", messages: input.messages, existing: [] }),
  scorers: [
    predicate("candidate_presence", ({ output, expected }) =>
      expected.wantsCandidate ? output.length > 0 : output.length === 0,
    ),
    includesAll("mentions_topic", ({ output, expected }) => ({
      haystack: output.map((c) => `${c.name} ${c.description} ${c.body}`).join(" "),
      needles: expected.keywords ?? [],
    })),
  ],
})
