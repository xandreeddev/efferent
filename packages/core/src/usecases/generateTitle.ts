import { Effect } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import type { TokenUsage } from "../ports/LlmInfo.js"
import { UtilityLlm, type UtilityLlmError } from "../ports/UtilityLlm.js"
import { TITLE_PROMPT } from "../prompts/title.js"

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

/**
 * Normalize a model-emitted title for one-line display: collapse newlines and
 * runs of whitespace, strip wrapping quotes/backticks and a trailing period,
 * hard-cap the length. Pure — the model's formatting habits ("Title", `Title`,
 * Title.) must never leak into the sessions list.
 */
export const sanitizeTitle = (raw: string, maxLen = 60): string => {
  let t = raw.replace(/\s+/g, " ").trim()
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
  ] as const) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= 2) {
      t = t.slice(1, -1).trim()
    }
  }
  t = t.replace(/\.$/, "").trim()
  return clip(t, maxLen)
}

/**
 * Name a session from its first exchange, on the fast `UtilityLlm` tier.
 * Only the first user message + the first assistant prose feed the prompt
 * (clipped) — enough to name the task, fast enough to run after every new
 * session's first turn. Returns `title: ""` when the history has nothing
 * nameable; `usage` (when the provider reported it) lets the caller count
 * the fast tier's spend.
 */
export const generateSessionTitle = (
  history: ReadonlyArray<AgentMessage>,
): Effect.Effect<{ title: string; usage?: TokenUsage }, UtilityLlmError, UtilityLlm> =>
  Effect.gen(function* () {
    const firstUser = history.find((m) => m.role === "user")
    if (firstUser === undefined || firstUser.content.trim().length === 0) {
      return { title: "" }
    }
    const firstAssistantText = history
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])),
      )
      .find((t) => t.trim().length > 0)
    const excerpt = [
      `USER: ${clip(firstUser.content.trim(), 500)}`,
      ...(firstAssistantText !== undefined
        ? [`ASSISTANT: ${clip(firstAssistantText.trim(), 500)}`]
        : []),
    ].join("\n\n")
    const utility = yield* UtilityLlm
    const res = yield* utility.complete(
      `${TITLE_PROMPT}\n\n<exchange>\n${excerpt}\n</exchange>`,
      { role: "fast" },
    )
    return {
      title: sanitizeTitle(res.text),
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
    }
  })
