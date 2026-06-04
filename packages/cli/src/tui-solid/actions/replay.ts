import type { AgentMessage, Checkpoint } from "@efferent/core"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../../tui/toolDescribe.js"
import type { ScrollbackBlock, ToolBlock } from "../model/conversation.js"

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

  let msgIdx = 0
  for (const msg of history) {
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
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
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
