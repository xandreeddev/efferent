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

import type { AgentMessage, Checkpoint } from "@xandreed/sdk-core"
import { assistantUsage } from "@xandreed/sdk-core"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "./toolDescribe.js"
import {
  messageKey,
  subjectLine,
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
import { mergeFileChange, parsePlanSteps, type FileChange } from "./sidePane.js"
import { formatTokens } from "./statusBar.js"
import type { PlanStep } from "../../usecases/codingToolkit.js"

export interface HistoryProjection {
  readonly blocks: ScrollbackBlock[]
  readonly tree: ExecutionTree
  readonly filesChanged: ReadonlyArray<FileChange>
  /** The agent's working plan as of the LAST `update_plan` call in the set. */
  readonly plan: ReadonlyArray<PlanStep>
  /** `node:<id>` fold keys for every tree root — seed `stackCollapsed` so a
   *  freshly-loaded session lands compact (one folded line per run). */
  readonly foldIds: ReadonlySet<string>
}

/** The tree-container label for a `run_agent` spawn: the model-given `name`
 *  (with its `seedMode` suffix), folder basename as the legacy fallback. */
const spawnName = (input: unknown): string => {
  const a = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  const folder = typeof a.folder === "string" ? a.folder : "?"
  const tail = folder.split("/").filter(Boolean).pop() ?? folder
  const given = typeof a.name === "string" && a.name.trim().length > 0 ? a.name.trim() : undefined
  const seedMode = typeof a.seedMode === "string" ? a.seedMode : undefined
  const base = given ?? tail
  return seedMode !== undefined ? `${base} · ${seedMode}` : base
}

export const projectHistory = (
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
  /**
   * The absolute store position of `history[0]` — 0 for a full record, or
   * `latestCheckpoint.messagePosition + 1` for a post-handoff window. Positions
   * are contiguous, so message `history[i]` sits at `baseOffset + i`; the rail's
   * message-block keys derive from that absolute position, matching the keys the
   * live event stream carries (which knows the true store position). Handoff-safe
   * because an absolute position never shifts when the window narrows.
   */
  baseOffset = 0,
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
  // ---- activity half ----
  let tree = emptyTree
  let filesChanged: ReadonlyArray<FileChange> = []
  let plan: ReadonlyArray<PlanStep> = []
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
    // This message's absolute store position + per-kind part ordinals — the
    // basis of the cache keys, computed identically to the live event pump.
    const pos = baseOffset + msgIdx
    let aOrd = 0
    let rOrd = 0
    if (msg.role === "user") {
      blocks.push({ kind: "user", text: msg.content, msgIndex: msgIdx, key: messageKey(pos, "u") })
      tree = onRunStart(tree, subjectLine(msg.content), 0).tree
      turnIdx = 0
    } else if (msg.role === "assistant") {
      tree = onTurnStart(tree, turnIdx++, 0)
      const usage = assistantUsage(msg)
      if (usage !== undefined) {
        tree = onTurnDetail(tree, `${formatTokens(usage.outputTokens)} tok`)
      }
      if (typeof msg.content === "string") {
        blocks.push({ kind: "assistant", text: msg.content, msgIndex: msgIdx, key: messageKey(pos, "a", aOrd++) })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            if (part.text.trim().length > 0) {
              blocks.push({ kind: "assistant", text: part.text, msgIndex: msgIdx, key: messageKey(pos, "a", aOrd++) })
            }
          } else if (part.type === "reasoning") {
            if (part.text.trim().length > 0) {
              blocks.push({ kind: "reasoning", text: part.text, msgIndex: msgIdx, key: messageKey(pos, "r", rOrd++) })
            }
          } else if (part.type === "tool-call") {
            if (part.toolName === "run_agent") {
              // The fleet surfaces ONLY in the tree (+ the navigator), never the
              // conversation rail — so a spawn opens a tree container, no rail block.
              const spawned = onSubAgentStartKeyed(tree, `run_agent → ${spawnName(part.input)}`, undefined, 0)
              tree = spawned.tree
              enqueue(matchKey(part.toolCallId, part.toolName), {
                treeId: spawned.id,
                isSpawn: true,
              })
            } else {
              // The last plan call in the set IS the loaded plan.
              if (part.toolName === "update_plan") {
                const steps = parsePlanSteps(part.input)
                if (steps !== undefined) plan = steps
              }
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
          // Close the spawn's TREE container only — the fleet never touches the
          // rail (a failed spawn shows as ✗ in the tree, not a rail error block).
          const r = (typeof part.output === "object" && part.output !== null
            ? part.output
            : {}) as Record<string, unknown>
          const nodeId = typeof r.nodeId === "string" ? r.nodeId : undefined
          // `failureMode: "return"` failures arrive as `{error, message?}`.
          const failed =
            part.isError === true || (typeof r.error === "string" && r.error.length > 0)
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
  return { blocks, tree, filesChanged, plan, foldIds }
}
