import { type AgentMessage, type Candidate, distill } from "@xandreed/sdk-core"
import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Distiller classification** — does the fast-tier miner correctly classify the
 * kind, scope, and source of each mined learning? The base `distill.eval.ts`
 * checks presence/extraction; this suite checks the NEW metadata dimensions.
 */

interface ClassificationCaseInput {
  readonly messages: ReadonlyArray<AgentMessage>
}
interface ClassificationExpected {
  readonly wantsCandidate: boolean
  readonly kind?: "skill" | "memory" | "constraint" | "process"
  readonly scope?: "global" | "project"
  readonly source?: "user" | "inferred"
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

// USER states a general rule about variable declarations.
const USER_GLOBAL_CONSTRAINT: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Always use `const`, never `let` unless you explicitly need to reassign the binding." },
  say("Understood — I'll default to `const` and only use `let` when reassignment is required."),
]

// USER states an Effect-domain rule — phrased as a STANDING rule for every Effect
// project (unambiguously global), so the miner shouldn't scope it to this repo.
const USER_EFFECT_RULE: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "A standing rule for all my Effect projects: never use try/catch — model failures as typed errors with Effect (Effect.fail / Effect.catchTag). This applies everywhere, not just here." },
  say("Understood — typed errors via Effect everywhere, never try/catch."),
]

// PROJECT-specific lesson inferred while working.
const INFERRED_PROJECT_LESSON: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Add a `createdAt` field to the Order schema." },
  t("1", "edit_file", { path: "Order.ts", oldText: "id: Schema.String", newText: "id: Schema.String,\n  createdAt: Schema.DateFromString" }),
  r("1", "edit_file", "edited Order.ts"),
  t("2", "Bash", { command: "bun run typecheck" }),
  r("2", "Bash", "error TS2741: property 'createdAt' missing in the Order decoder", true),
  say("The schema and its decoder live in separate files and must change together."),
  t("3", "edit_file", { path: "orderDecoder.ts", oldText: "{ id }", newText: "{ id, createdAt }" }),
  r("3", "edit_file", "edited orderDecoder.ts"),
  t("4", "Bash", { command: "bun run typecheck" }),
  r("4", "Bash", "0 errors"),
]

// USER states a HOW-to-work rule.
const USER_PROCESS_RULE: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "Before a multi-step task, write the plan and confirm the decomposition with me." },
  say("Understood — I'll outline the plan and get your confirmation before proceeding with multi-step work."),
]

// A general gotcha the agent DISCOVERS while debugging (NOT user-stated): JS
// `Array.sort()` is lexicographic by default, so numbers need an explicit
// comparator. A general rule that applies to ANY project → global + inferred.
const INFERRED_GLOBAL_GOTCHA: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "The leaderboard is in the wrong order — [10, 2, 30] isn't sorting numerically." },
  t("1", "read_file", { path: "leaderboard.ts" }),
  r("1", "read_file", "return scores.sort()"),
  say("Found it — `Array.prototype.sort()` sorts lexicographically (as strings) by default, so numbers come out wrong. It needs a numeric comparator."),
  t("2", "edit_file", { path: "leaderboard.ts", oldText: "scores.sort()", newText: "scores.sort((a, b) => a - b)" }),
  r("2", "edit_file", "edited leaderboard.ts"),
  t("3", "Bash", { command: "bun test" }),
  r("3", "Bash", "1 pass"),
  say("Fixed. The general rule: always pass a numeric comparator to `.sort()` for numbers — the default string ordering is a recurring footgun."),
]

// Chitchat / no-lesson transcript.
const CHITCHAT: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "thanks, that's perfect!" },
  say("You're welcome!"),
]

const CASES: ReadonlyArray<{
  name: string
  input: ClassificationCaseInput
  expected: ClassificationExpected
}> = [
  {
    name: "user-global-constraint",
    input: { messages: USER_GLOBAL_CONSTRAINT },
    expected: { wantsCandidate: true, scope: "global", source: "user", kind: "constraint" },
  },
  {
    name: "user-effect-rule",
    input: { messages: USER_EFFECT_RULE },
    expected: { wantsCandidate: true, scope: "global", source: "user", kind: "constraint" },
  },
  {
    name: "inferred-project-lesson",
    input: { messages: INFERRED_PROJECT_LESSON },
    expected: { wantsCandidate: true, scope: "project", source: "inferred", kind: "constraint" },
  },
  {
    name: "user-process-rule",
    input: { messages: USER_PROCESS_RULE },
    expected: { wantsCandidate: true, source: "user", kind: "process" },
  },
  {
    // kind is left unasserted — the miner may reasonably file a discovered gotcha
    // as a constraint OR a skill; the NEW dimensions (scope + source) are the point.
    name: "inferred-global-gotcha",
    input: { messages: INFERRED_GLOBAL_GOTCHA },
    expected: { wantsCandidate: true, scope: "global", source: "inferred" },
  },
  {
    name: "nothing-to-learn",
    input: { messages: CHITCHAT },
    expected: { wantsCandidate: false },
  },
]

export const distillClassificationEval = defineEval<
  ClassificationCaseInput,
  ReadonlyArray<Candidate>,
  ClassificationExpected,
  EvalEnv
>({
  name: "distillClassification",
  description: "the reflector correctly classifies kind, scope, and source of mined learnings",
  threshold: 0.5,
  concurrency: 2,
  data: CASES,
  task: (input) => distill({ conversationId: "eval", messages: input.messages, existing: [] }),
  scorers: [
    predicate("presence", ({ output, expected }) =>
      expected.wantsCandidate ? output.length > 0 : output.length === 0,
    ),
    // Each dimension is scored only when the case labels it; a labeled dimension
    // passes when SOME mined candidate carries it (robust to the miner emitting
    // more than one candidate, in any order).
    predicate("kind_correct", ({ output, expected }) =>
      expected.kind === undefined || output.some((c) => c.kind === expected.kind),
    ),
    predicate("scope_correct", ({ output, expected }) =>
      expected.scope === undefined || output.some((c) => c.scope === expected.scope),
    ),
    predicate("source_correct", ({ output, expected }) =>
      expected.source === undefined || output.some((c) => c.source === expected.source),
    ),
  ],
})
