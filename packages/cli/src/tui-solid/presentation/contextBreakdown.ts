/**
 * A rough per-category split of context usage (user / assistant / tool / free),
 * estimated chars/4 over the loaded rail blocks — the Antigravity CLI's
 * `/context` breakdown, native. It is an **estimate** (we don't get provider
 * per-category counts; the `Σ main/fast` ledger remains the authoritative billed
 * spend), so the view labels it as such. UI-chrome blocks (info/error) and
 * sub-agent fan-out (agents — separate context) are excluded.
 */
import type { ScrollbackBlock } from "./conversation.js"

export interface ContextBreakdown {
  readonly user: number
  readonly assistant: number
  readonly tools: number
  readonly free: number
}

const estTokens = (s: string): number => Math.ceil(s.length / 4)

export const categorizeTokens = (
  blocks: ReadonlyArray<ScrollbackBlock>,
  window: number,
): ContextBreakdown => {
  let user = 0
  let assistant = 0
  let tools = 0
  for (const b of blocks) {
    switch (b.kind) {
      case "user":
        user += estTokens(b.text)
        break
      case "assistant":
      case "reasoning":
      case "checkpoint":
        assistant += estTokens(b.text)
        break
      case "tool":
        tools +=
          estTokens(b.toolName) +
          estTokens(b.detail ?? "") +
          estTokens(b.diff ?? "") +
          estTokens(b.output ?? "")
        break
      // info / error: UI chrome. agents: sub-agent context, billed via byRole.
    }
  }
  const used = user + assistant + tools
  const free = window > 0 ? Math.max(0, window - used) : 0
  return { user, assistant, tools, free }
}

/** Total estimated tokens across the three content categories. */
export const breakdownUsed = (b: ContextBreakdown): number => b.user + b.assistant + b.tools
