import type { AgentMessage, Checkpoint } from "@efferent/core"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../presentation/toolDescribe.js"
import type { AgentRunRow, ScrollbackBlock, ToolBlock } from "../presentation/conversation.js"

/**
 * Turn a persisted message history (+ its handoff checkpoints) into the flat
 * `ScrollbackBlock[]` the conversation rail renders — the pure, Solid-store
 * analogue of the old `replayHistory` (`tui.ts:411`), which pushed into a
 * `Scrollback` object. Used by `resume` / build-a-new-session to repopulate the
 * conversation from records.
 *
 * Every block is tagged with the message's position (`msgIndex`) so the context
 * viewer can later jump the conversation to a chosen message. A tool-result row
 * patches the matching tool-call block in place (by `toolCallId`).
 *
 * `run_agent` calls don't replay as tool pills (live they're filtered by the
 * pump and rendered as the sub-agent container) — they rebuild the same
 * `agents` block the live rail shows: one `Ran N agents` container per
 * assistant message's burst, each row patched from its tool result with the
 * run's returned summary. A bare `run_agent ⎿ done` pill hid everything.
 */
export const replayBlocks = (
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
): ScrollbackBlock[] => {
  const blocks: ScrollbackBlock[] = []
  const patchTool = (id: string, patch: Partial<ToolBlock>): void => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      if (b.kind === "tool" && b.id === id) {
        blocks[i] = { ...b, ...patch }
        return
      }
    }
  }
  // Rows are keyed by the tool-call id until the result reveals the real
  // context-node id (the row key is presentation-only either way).
  const patchAgentRow = (
    callId: string,
    patch: (row: AgentRunRow) => AgentRunRow,
  ): void => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      if (b.kind !== "agents") continue
      const at = b.agents.findIndex((a) => a.nodeId === callId)
      if (at === -1) continue
      const agents = [...b.agents]
      agents[at] = patch(agents[at]!)
      blocks[i] = { ...b, agents }
      return
    }
  }
  const spawnRow = (callId: string, input: unknown): AgentRunRow => {
    const a = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >
    const folder = typeof a.folder === "string" ? a.folder : "?"
    const tail = folder.split("/").filter(Boolean).pop() ?? folder
    const seedMode = typeof a.seedMode === "string" ? a.seedMode : undefined
    return {
      nodeId: callId,
      name: seedMode !== undefined ? `${tail} · ${seedMode}` : tail,
      status: "ok",
      toolUses: 0,
      tokens: 0,
    }
  }

  let msgIdx = 0
  for (const msg of history) {
    // One agents block per assistant message's spawn burst (mirrors the live
    // pump, which resets the block on the parent's next turn).
    let burstBlockIdx: number | undefined
    if (msg.role === "user") {
      blocks.push({ kind: "user", text: msg.content, msgIndex: msgIdx })
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        blocks.push({ kind: "assistant", text: msg.content, msgIndex: msgIdx })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            if (part.text.trim().length > 0) {
              blocks.push({ kind: "assistant", text: part.text, msgIndex: msgIdx })
            }
          } else if (part.type === "reasoning") {
            if (part.text.trim().length > 0) {
              blocks.push({ kind: "reasoning", text: part.text, msgIndex: msgIdx })
            }
          } else if (part.type === "tool-call") {
            if (part.toolName === "run_agent") {
              const row = spawnRow(part.toolCallId, part.input)
              if (burstBlockIdx === undefined) {
                burstBlockIdx = blocks.length
                blocks.push({ kind: "agents", id: `ag:${part.toolCallId}`, agents: [row] })
              } else {
                const b = blocks[burstBlockIdx]! as Extract<ScrollbackBlock, { kind: "agents" }>
                blocks[burstBlockIdx] = { ...b, agents: [...b.agents, row] }
              }
            } else {
              blocks.push({
                kind: "tool",
                id: part.toolCallId,
                toolName: describeToolCall(part.toolName, part.input),
                state: "ok",
                msgIndex: msgIdx,
              })
            }
          }
        }
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.toolName === "run_agent") {
          const r = (typeof part.output === "object" && part.output !== null
            ? part.output
            : {}) as Record<string, unknown>
          const summary = typeof r.summary === "string" ? r.summary.trim() : ""
          const nodeId = typeof r.nodeId === "string" ? r.nodeId : undefined
          // `failureMode: "return"` failures arrive as `{error, message?}`.
          const failed =
            part.isError || (typeof r.error === "string" && r.error.length > 0)
          patchAgentRow(part.toolCallId, (row) => ({
            ...row,
            ...(nodeId !== undefined ? { nodeId } : {}),
            status: failed ? "error" : "ok",
            ...(!failed && summary.length > 0 ? { summary } : {}),
          }))
          if (failed) {
            const why =
              typeof r.message === "string"
                ? r.message
                : typeof r.error === "string"
                  ? r.error
                  : summary
            if (why.length > 0) blocks.push({ kind: "error", text: why })
          }
          continue
        }
        const detail = describeToolResult(part.toolName, !part.isError, part.output)
        const artifacts = toolArtifacts(part.toolName, !part.isError, part.output)
        patchTool(part.toolCallId, {
          state: part.isError ? "error" : "ok",
          ...(detail !== undefined ? { detail } : {}),
          ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
          ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
        })
      }
    }
    const cp = checkpoints.find((c) => c.messagePosition === msgIdx)
    if (cp !== undefined) blocks.push({ kind: "checkpoint", text: cp.summary })
    msgIdx++
  }
  return blocks
}
