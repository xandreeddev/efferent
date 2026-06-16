/**
 * Human-readable, low-cardinality span names for the agent trace waterfall.
 * Names include the identifiers that matter at a glance (prompt label, turn
 * index, tool name, sub-agent label); full details stay in span attributes.
 */

import type { Prompt } from "../entities/Prompt.js"
import { promptLabel } from "../entities/Prompt.js"

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

const sanitizeOneLine = (s: string): string =>
  clip(
    s
      .replace(/\s+/g, " ")
      .replace(/[\p{Emoji}\p{Emoji_Presentation}]/gu, "")
      .trim(),
    50,
  )

/** Span name for a top-level agent run. Prompt text stays in attributes/table columns. */
export const runSpanName = (): string => "agent.run"

/** Span name for one agent-loop turn: `agent.turn <n>`. */
export const turnSpanName = (turnIndex: number): string =>
  `agent.turn ${turnIndex}`

/** Span name for a resolved tool call: `agent.tool.<name>`. */
export const toolSpanName = (toolName: string): string =>
  `agent.tool.${toolName}`

/** Span name for an LLM call: `llm.generate <prompt-label> · <provider>/<model>`. */
export const llmSpanName = (
  prompt: Prompt | undefined,
  role: string,
  provider: string,
  model: string,
): string => {
  const label = prompt !== undefined ? promptLabel(prompt) : role
  return `llm.generate ${label} · ${provider}/${model}`
}

/** Span name for a sub-agent branch: `agent.subagent <label> · <folder> · d<depth>`. */
export const subagentSpanName = (
  label: string,
  folder: string,
  depth: number,
): string => {
  const base = folder.split("/").pop() ?? folder
  return `agent.subagent ${sanitizeOneLine(label)} · ${base} · d${depth}`
}
