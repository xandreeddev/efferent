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

// A reusable multi-step routine the agent discovers via friction: adding a tool
// isn't one edit — it must be defined, REGISTERED in the toolkit, AND given a
// HANDLER, or it silently never runs. Exactly the repeatable recipe a skill
// should capture.
const SUCCESS_SKILL_SESSION: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Add a new `glob` tool to the coding toolkit." },
  t("1", "edit_file", { path: "codingToolkit.ts", oldText: "// tool defs", newText: "// tool defs\nconst glob = Tool.make({ name: 'glob' })" }),
  r("1", "edit_file", "edited codingToolkit.ts"),
  t("2", "Bash", { command: "bun run typecheck" }),
  r("2", "Bash", "0 errors"),
  { role: "user", content: "it typechecks but the model never calls glob — it can't see the tool." },
  say("Right — defining the tool isn't enough. It must also be registered in the Toolkit and given a handler in the layer. Three steps, not one."),
  t("3", "edit_file", { path: "codingToolkit.ts", oldText: "tools: [read, edit]", newText: "tools: [read, edit, glob]" }),
  r("3", "edit_file", "registered glob in the toolkit"),
  t("4", "edit_file", { path: "codingToolkit.ts", oldText: "// handlers", newText: "// handlers\nglob: (i) => fs.glob(i.pattern)," }),
  r("4", "edit_file", "added the glob handler"),
  say("Done. The repeatable recipe for adding a tool: define it, register it in the Toolkit, and add its handler in the layer — miss any one and it silently never runs."),
]

// A recurring failure: the agent keeps forgetting to run the typecheck after
// edits, leading to red CI.
const FAILURE_CONSTRAINT_SESSION: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Add a `retryDelay` option to the client config." },
  t("1", "edit_file", { path: "src/Client.ts", oldText: "timeout: Schema.Number", newText: "timeout: Schema.Number,\n  retryDelay: Schema.Number" }),
  r("1", "edit_file", "edited src/Client.ts"),
  say("Added `retryDelay` to the config schema."),
  { role: "user", content: "the typecheck is failing — did you forget to update the decoder?" },
  say("You're right, I skipped the decoder. Let me fix it."),
  t("2", "edit_file", { path: "src/clientDecoder.ts", oldText: "{ timeout }", newText: "{ timeout, retryDelay }" }),
  r("2", "edit_file", "edited src/clientDecoder.ts"),
  t("3", "Bash", { command: "bun run typecheck" }),
  r("3", "Bash", "0 errors"),
  say("Fixed — I need to remember to update the decoder alongside the schema."),
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
  {
    name: "success-skill",
    input: { messages: SUCCESS_SKILL_SESSION },
    expected: { wantsCandidate: true, keywords: ["register", "handler"] },
  },
  {
    name: "failure-constraint",
    input: { messages: FAILURE_CONSTRAINT_SESSION },
    expected: { wantsCandidate: true, keywords: ["typecheck", "decoder"] },
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
