/**
 * ONE walk from persisted messages to everything the UI shows for a loaded
 * context: the conversation rail blocks, the Activity execution tree, and the
 * files-changed diffstat. The principle (the foundation this codifies): an
 * agent context IS its message set; the rail and the Activity pane are two
 * projections of the same messages, derived together so they can never
 * disagree about a tool's status or detail. Used by every "make this message
 * set current" path (resume / build / fork / boot).
 *
 * Tree timestamps are all 0 — `AgentMessage` carries none. Renderers treat
 * `endedAt === startedAt` as "duration unknown" (Activity.tsx). Sub-agent
 * INNER tool calls live on their context node, not in the parent history, so
 * a rebuilt tree shows each spawn as a closed container (label, files detail,
 * persistent node id) without inner pills — the full session is one ↵ away in
 * the agents pane.
 */

import type { AgentMessage, Checkpoint } from "@efferent/core"
import { assistantUsage } from "@efferent/core"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "./toolDescribe.js"
import {
  subjectLine,
  type AgentRunRow,
  type ScrollbackBlock,
  type ToolBlock,
} from "./conversation.js"
import {
  emptyTree,
  onAgentEnd,
  onRunStart,
  onSubAgentEndKeyed,
  onSubAgentNodeId,
  onSubAgentStartKeyed,
  onToolEnd,
  onToolStart,
  onTurnDetail,
  onTurnStart,
  type ExecutionTree,
} from "./executionTree.js"
import { mergeFileChange, type FileChange } from "./sidePane.js"
import { formatTokens } from "./statusBar.js"

export interface HistoryProjection {
  readonly blocks: ScrollbackBlock[]
  readonly tree: ExecutionTree
  readonly filesChanged: ReadonlyArray<FileChange>
  /** `node:<id>` fold keys for every tree root — seed `stackCollapsed` so a
   *  freshly-loaded session lands compact (one folded line per run). */
  readonly foldIds: ReadonlySet<string>
}

/** One spawned-agent row from a `run_agent` tool-call's input. The model-given
 *  `name` is the label; folder basename is the legacy fallback. */
const spawnRow = (callId: string, input: unknown): AgentRunRow => {
  const a = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  const folder = typeof a.folder === "string" ? a.folder : "?"
  const tail = folder.split("/").filter(Boolean).pop() ?? folder
  const given = typeof a.name === "string" && a.name.trim().length > 0 ? a.name.trim() : undefined
  const seedMode = typeof a.seedMode === "string" ? a.seedMode : undefined
  const base = given ?? tail
  return {
    nodeId: callId,
    name: seedMode !== undefined ? `${base} · ${seedMode}` : base,
    status: "ok",
    toolUses: 0,
    tokens: 0,
  }
}

export const projectHistory = (
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
): HistoryProjection => {
  // ---- rail half ----
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

  // ---- activity half ----
  let tree = emptyTree
  let filesChanged: ReadonlyArray<FileChange> = []
  let turnIdx = 0
  // FIFO per tool-call key (id, else name) → tree node id; same matching
  // discipline as the live event pump, so duplicate same-named calls pair in
  // emission order. isSpawn marks run_agent containers (closed differently).
  const pending = new Map<string, Array<{ treeId: number; isSpawn: boolean }>>()
  const matchKey = (id: string, name: string): string => (id.length > 0 ? id : name)
  const enqueue = (k: string, v: { treeId: number; isSpawn: boolean }): void => {
    const q = pending.get(k)
    if (q !== undefined) q.push(v)
    else pending.set(k, [v])
  }
  const dequeue = (k: string): { treeId: number; isSpawn: boolean } | undefined => {
    const q = pending.get(k)
    if (q === undefined || q.length === 0) return undefined
    const v = q.shift()
    if (q.length === 0) pending.delete(k)
    return v
  }

  let msgIdx = 0
  for (const msg of history) {
    // One agents block per assistant message's spawn burst (mirrors the live
    // pump, which resets the block on the parent's next turn).
    let burstBlockIdx: number | undefined
    if (msg.role === "user") {
      blocks.push({ kind: "user", text: msg.content, msgIndex: msgIdx })
      tree = onRunStart(tree, subjectLine(msg.content), 0).tree
      turnIdx = 0
    } else if (msg.role === "assistant") {
      tree = onTurnStart(tree, turnIdx++, 0)
      const usage = assistantUsage(msg)
      if (usage !== undefined) {
        tree = onTurnDetail(tree, `${formatTokens(usage.outputTokens)} tok`)
      }
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
              const spawned = onSubAgentStartKeyed(tree, `run_agent → ${row.name}`, undefined, 0)
              tree = spawned.tree
              enqueue(matchKey(part.toolCallId, part.toolName), {
                treeId: spawned.id,
                isSpawn: true,
              })
            } else {
              blocks.push({
                kind: "tool",
                id: part.toolCallId,
                toolName: describeToolCall(part.toolName, part.input),
                state: "ok",
                msgIndex: msgIdx,
              })
              const started = onToolStart(tree, describeToolCall(part.toolName, part.input), 0)
              tree = started.tree
              enqueue(matchKey(part.toolCallId, part.toolName), {
                treeId: started.id,
                isSpawn: false,
              })
            }
          }
        }
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const queued = dequeue(matchKey(part.toolCallId, part.toolName))
        if (part.toolName === "run_agent") {
          const r = (typeof part.output === "object" && part.output !== null
            ? part.output
            : {}) as Record<string, unknown>
          const summary = typeof r.summary === "string" ? r.summary.trim() : ""
          const nodeId = typeof r.nodeId === "string" ? r.nodeId : undefined
          // `failureMode: "return"` failures arrive as `{error, message?}`.
          const failed =
            part.isError === true || (typeof r.error === "string" && r.error.length > 0)
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
          if (queued !== undefined) {
            const files = Array.isArray(r.filesChanged) ? r.filesChanged.length : 0
            const detail = failed
              ? describeToolResult("run_agent", false, part.output)
              : files > 0
                ? `${files} file${files === 1 ? "" : "s"}`
                : undefined
            tree = onSubAgentEndKeyed(tree, queued.treeId, !failed, detail, 0)
            if (nodeId !== undefined) tree = onSubAgentNodeId(tree, queued.treeId, nodeId)
          }
          continue
        }
        const ok = part.isError !== true
        const detail = describeToolResult(part.toolName, ok, part.output)
        const artifacts = toolArtifacts(part.toolName, ok, part.output)
        patchTool(part.toolCallId, {
          state: ok ? "ok" : "error",
          ...(detail !== undefined ? { detail } : {}),
          ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
          ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
        })
        if (queued !== undefined) tree = onToolEnd(tree, queued.treeId, ok, detail, 0)
        if (artifacts.fileChange !== undefined) {
          filesChanged = mergeFileChange(filesChanged, artifacts.fileChange)
        }
      }
    }
    const cp = checkpoints.find((c) => c.messagePosition === msgIdx)
    if (cp !== undefined) blocks.push({ kind: "checkpoint", text: cp.summary })
    msgIdx++
  }

  // Nothing stays "running" in a rebuilt tree — an interrupted tail's dangling
  // calls close as ok rather than rendering a frozen spinner forever.
  tree = onAgentEnd(tree, 0)
  const foldIds = new Set(
    tree.roots
      .filter((r) => r.kind === "run" || r.kind === "turn" || r.kind === "subagent")
      .map((r) => `node:${r.id}`),
  )
  return { blocks, tree, filesChanged, foldIds }
}
