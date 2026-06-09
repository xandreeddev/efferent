import { LanguageModel, Prompt } from "@effect/ai"
import { Effect } from "effect"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { HANDOFF_PROMPT } from "../prompts/handoff.js"
import { handoffToMessage } from "./promptMapping.js"

/**
 * Render the loaded view as a single, labelled transcript string. Tool turns
 * keep their tool names + ok/fail (not "[omitted]") so the handoff can say what
 * was actually done.
 *
 * We pass this as ONE user message (see `createHandoff`) rather than replaying
 * the original user/assistant roles: feeding the transcript back as
 * role-alternating messages structurally cues the model to *continue the
 * conversation* (produce the next assistant turn) instead of summarizing it —
 * which is exactly how a handoff once came back as "Let me know how you'd like
 * to proceed!". A flat transcript inside a single user turn leaves the model
 * only one reasonable move: reply with the summary.
 */
const renderTranscript = (messages: ReadonlyArray<AgentMessage>): string =>
  messages
    .map((m) => {
      if (m.role === "user") {
        return `USER: ${m.content}`
      }
      if (m.role === "assistant") {
        const parts: string[] = []
        for (const p of m.content) {
          if (p.type === "text" || p.type === "reasoning") {
            if (p.text.trim().length > 0) parts.push(p.text)
          } else if (p.type === "tool-call") {
            parts.push(`[called ${p.toolName}]`)
          }
        }
        return `ASSISTANT: ${parts.join("\n") || "[tool calls]"}`
      }
      // tool results — keep names + ok/fail
      const results = m.content
        .map((p) => `${p.toolName}: ${p.isError ? "error" : "ok"}`)
        .join("; ")
      return `TOOL RESULTS: ${results}`
    })
    .join("\n\n")

/**
 * Summarize a loaded view into a handoff brief — the LLM-as-summarizer half of
 * `createHandoff`, also used to seed a spawned sub-agent from chosen context.
 * Renders the view as a flat transcript (one user message) so the model
 * summarizes rather than continues it.
 */
export const generateHandoffBrief = (view: ReadonlyArray<AgentMessage>) =>
  Effect.gen(function* () {
    const prompt = Prompt.make([
      { role: "system", content: HANDOFF_PROMPT },
      {
        role: "user",
        content:
          "Summarize the following conversation transcript into a handoff, " +
          "following your instructions exactly. Reply with ONLY the summary.\n\n" +
          "<transcript>\n" +
          renderTranscript(view) +
          "\n</transcript>",
      },
    ] as never)
    const res = yield* LanguageModel.generateText({ prompt })
    return res.text.trim()
  })

/**
 * Create a handoff for `conversationId`: summarize the **currently loaded
 * view** — the prior handoff summary (if any) plus the real messages since the
 * last fold — and record a checkpoint at the current head. From the next turn
 * on, the agent loads only this summary + messages created after it. Original
 * messages are untouched (still in `list`).
 *
 * Summarizing the loaded view (not the raw `list`) keeps handoffs **cumulative**:
 * a second handoff folds the first summary back in rather than dropping it.
 *
 * No-op if there's nothing new to fold since the last handoff.
 */
export const createHandoff = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const prior = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    if (active.length === 0) return // nothing new since the last handoff

    const view: ReadonlyArray<AgentMessage> = [
      ...(prior !== undefined ? [handoffToMessage(prior.summary)] : []),
      ...active,
    ]

    const summary = yield* generateHandoffBrief(view)
    yield* store.checkpoint(conversationId, summary)
  })
