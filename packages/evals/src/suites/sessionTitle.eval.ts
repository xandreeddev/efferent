import { type AgentMessage, generateSessionTitle } from "@efferent/core"
import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { llmJudge, predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Session title quality (fast tier).** Name a session from its first exchange
 * on the FAST role (`generateSessionTitle` → `UtilityLlm`). Deterministic guards
 * on `sanitizeTitle`'s contract (non-empty, single line, ≤60 chars, no wrapping
 * quotes) + an LLM judge for aptness.
 */

interface TitleInput {
  readonly user: string
  readonly assistant: string
}
interface TitleExpected {
  readonly rubric: string
}

const history = (user: string, assistant: string): ReadonlyArray<AgentMessage> => [
  { role: "user", content: user },
  { role: "assistant", content: [{ type: "text", text: assistant }] },
]

const CASES: ReadonlyArray<{ name: string; input: TitleInput; expected: TitleExpected }> = [
  {
    name: "bug-fix",
    input: {
      user: "The pagination on the users table is off by one — page 2 repeats the last row of page 1.",
      assistant: "Found it: the OFFSET used page*size instead of (page-1)*size. Fixed the query.",
    },
    expected: { rubric: "names an off-by-one pagination bug fix" },
  },
  {
    name: "feature",
    input: {
      user: "Add a dark mode toggle to the settings page that persists to localStorage.",
      assistant: "Added a toggle wired to a `theme` key in localStorage and a CSS class on <html>.",
    },
    expected: { rubric: "names adding a persisted dark-mode toggle" },
  },
  {
    name: "infra",
    input: {
      user: "Our CI is flaky — the integration tests time out about 1 in 5 runs.",
      assistant: "The DB container wasn't ready; added a healthcheck wait before the test step.",
    },
    expected: { rubric: "names fixing flaky CI / integration test timeouts" },
  },
]

export const sessionTitleEval = defineEval<TitleInput, string, TitleExpected, EvalEnv>({
  name: "session-title",
  description: "the generated session title is well-formed and apt",
  threshold: 0.6,
  concurrency: 3,
  data: CASES,
  task: (input) =>
    generateSessionTitle(history(input.user, input.assistant)).pipe(Effect.map((r) => r.title)),
  scorers: [
    predicate("well_formed", ({ output }) => {
      const t = output.trim()
      if (t.length === 0 || t.length > 60) return false
      if (t.includes("\n")) return false
      const quoted = (o: string, c: string) => t.startsWith(o) && t.endsWith(c) && t.length >= 2
      return !(quoted('"', '"') || quoted("'", "'") || quoted("`", "`"))
    }),
    llmJudge(
      "apt",
      ({ input, output, expected }) =>
        `A coding session began with:\nUSER: ${input.user}\nASSISTANT: ${input.assistant}\n\n` +
        `Generated title: "${output}"\n\n` +
        `Rubric: score 1.0 if the title is a concise, apt name for this work (${expected.rubric}); ` +
        `0.5 if vague but related; 0 if wrong or empty.`,
    ),
  ],
})
