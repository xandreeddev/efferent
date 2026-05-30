import { Effect } from "effect"
import { type AgentMessage, ConversationStore, createHandoff } from "@agent/core"
import { defineEval } from "../framework/Eval.js"
import { includesAll, llmJudge, predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

/**
 * Target 1 — **handoff summary quality**. Seed a transcript into the
 * in-memory store, run the real `createHandoff` use case, and judge the
 * checkpoint summary it produces. This guards the bug we just fixed: a handoff
 * that continues the chat ("let me know how you'd like to proceed!") instead
 * of summarising it.
 */

interface HandoffInput {
  readonly transcript: ReadonlyArray<AgentMessage>
  readonly goal: string
}
interface HandoffExpected {
  /** Facts a faithful summary must mention. */
  readonly mustMention: ReadonlyArray<string>
}

const user = (content: string): AgentMessage => ({ role: "user", content })
const assistant = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const toolCall = (name: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: name, toolName: name, input: {} }],
})
const toolResult = (name: string, isError = false): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: name, toolName: name, output: {}, isError }],
})

const CASES: ReadonlyArray<{ name: string; input: HandoffInput; expected: HandoffExpected }> = [
  {
    name: "auth-refactor",
    input: {
      goal: "Migrate the login flow from session cookies to JWT and fix the failing refresh test",
      transcript: [
        user("Migrate our login from session cookies to JWT. The refresh-token test is failing."),
        assistant("I'll start by reading the auth module and the failing test."),
        toolCall("read_file"),
        toolResult("read_file"),
        assistant(
          "The refresh test fails because `verifyRefresh` still reads `req.session`. I'll switch it to decode the JWT and re-run.",
        ),
        toolCall("edit_file"),
        toolResult("edit_file"),
        user("Good. Don't touch the OAuth path, we ship that separately next week."),
        assistant("Understood — I'll leave the OAuth path alone. Next I need to update the token issuance in `login.ts`."),
      ],
    },
    expected: {
      mustMention: ["JWT", "refresh", "OAuth", "login"],
    },
  },
  {
    name: "perf-investigation",
    input: {
      goal: "Find and fix the N+1 query making the dashboard slow",
      transcript: [
        user("The dashboard is slow. I think it's an N+1 query somewhere in the reports loader."),
        assistant("Let me grep the reports loader for per-row queries."),
        toolCall("grep"),
        toolResult("grep"),
        assistant(
          "Found it: `loadReport` queries `lineItems` inside a `.map`, so one query per report. I'll batch it with a single `WHERE report_id IN (...)`.",
        ),
        toolCall("edit_file"),
        toolResult("edit_file"),
        assistant("Batched the query. Still need to add an index on `line_items.report_id` and verify with EXPLAIN."),
      ],
    },
    expected: {
      mustMention: ["N+1", "batch", "index", "report"],
    },
  },
]

export const handoffEval = defineEval<HandoffInput, string, HandoffExpected, EvalEnv>({
  name: "handoff",
  description: "summary captures goal / state / next-steps (not a chat reply)",
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    Effect.gen(function* () {
      const store = yield* ConversationStore
      const id = yield* store.create()
      for (const m of input.transcript) yield* store.append(id, m)
      yield* createHandoff(id)
      const cp = yield* store.getLatestCheckpoint(id)
      // No checkpoint => createHandoff no-op'd; return "" so scorers score 0.
      return cp?.summary ?? ""
    }),
  scorers: [
    predicate("not_chat_reply", ({ output }) =>
      output.trim().length > 40 &&
      !/(let me know|how would you like|shall i\b|would you like me to|happy to help|let's continue)/i.test(
        output,
      ),
    ),
    includesAll("captures_facts", ({ output, expected }) => ({
      haystack: output,
      needles: expected.mustMention,
    })),
    llmJudge(
      "handoff_quality",
      ({ input, output }) =>
        `A coding session is being handed off to a fresh agent. The session's goal was:\n"${input.goal}"\n\n` +
        `Candidate handoff summary:\n---\n${output || "(empty)"}\n---\n\n` +
        `Rubric: a good handoff states the Goal, the current State / what was already done, and concrete Next steps, ` +
        `and reads as a summary (NOT a reply that continues the conversation). ` +
        `Score 1.0 if it faithfully captures goal + state + next steps; 0.5 if partial; 0 if it is empty, a chat reply, or off-topic.`,
    ),
  ],
})
