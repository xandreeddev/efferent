import { Effect, Queue } from "effect"
import { batch } from "solid-js"
import type { AgentEvent } from "../../events.js"
import type { AgentRunRow } from "../presentation/conversation.js"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../presentation/toolDescribe.js"
import { formatTokens } from "../presentation/statusBar.js"
import {
  onAgentEnd as treeAgentEnd,
  onSubAgentEndKeyed as treeSubAgentEndKeyed,
  onSubAgentStartKeyed as treeSubAgentStartKeyed,
  onToolEnd as treeToolEnd,
  onToolStart as treeToolStart,
  onToolStartUnder as treeToolStartUnder,
  onTurnDetail as treeTurnDetail,
  onTurnStart as treeTurnStart,
} from "../presentation/executionTree.js"
import { accumulateUsage, mergeFileChange } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"

/**
 * Maps the mode-agnostic `AgentEvent` stream onto the UI signals — the Effect→
 * Solid crossing. The branch logic is lifted verbatim from the old `consumer`
 * forkDaemon (`tui.ts:1070-1332`); only the write target changes: conversation
 * blocks go through `store.pushBlock`/`store.updateTool`, the execution tree +
 * diffstat through `store.setProjection` (reusing the pure reducers from
 * `presentation/executionTree.ts`), and per-turn usage through `store.setStats`
 * (the single source the status bar + Activity both read). The pump only ever
 * writes the projection half — nav (cursor/folds) is the keyboard's.
 *
 * start↔end are matched by the provider **tool-call id**, kept as a FIFO queue
 * per key so that multiple calls of the SAME tool in one turn each resolve their
 * own tree node + scrollback pill — the old name-keyed "most recent in-flight
 * wins" let a second same-named start overwrite the first, stranding it "running"
 * forever. When a provider omits the id we fall back to the tool name, still FIFO
 * so same-named calls pair in emission order. This closure holds that matching
 * state, so one reducer instance lives per pump.
 */
export const makeEventReducer = (store: TuiStore): ((event: AgentEvent) => void) => {
  const toolTreeIds = new Map<string, number[]>() // matchKey → FIFO of tree node ids
  const toolScrollIds = new Map<string, string[]>() // matchKey → FIFO of scrollback pill ids
  const subAgentScrollId = new Map<string, string>() // subagent → scrollback pill id
  const previewToolIds = new Map<string, string[]>() // matchKey → FIFO of preview pill ids
  const subTreeByNode = new Map<string, number>() // context-node id → Activity tree id
  // One live "Running N agents…" rail block per fan-out burst: rows keyed by
  // node id, updated in place (Claude-style), reset when the parent's next
  // turn starts. Replaces the old one-Task-pill-per-spawn rail.
  const agentRows = new Map<string, AgentRunRow>()
  let agentsBlockId: string | undefined
  let subAgentDepth = 0
  let toolSeq = 0
  // The node id of a sub-agent run whose session is OPEN in the conversation
  // pane (a human-driven resume, or an agent spawn the user is watching): its
  // events stream into the preview overlay instead of vanishing into the
  // Activity tab — without this, a resumed node runs with zero visible
  // progress and reads as "stuck".
  let previewRunNode: string | undefined

  // The id pairs a start with its end; empty/absent → fall back to the name.
  const matchKey = (e: { id?: string; toolName: string }): string =>
    e.id !== undefined && e.id.length > 0 ? e.id : e.toolName
  const enqueue = <V>(m: Map<string, V[]>, k: string, v: V): void => {
    const q = m.get(k)
    if (q !== undefined) q.push(v)
    else m.set(k, [v])
  }
  const dequeue = <V>(m: Map<string, V[]>, k: string): V | undefined => {
    const q = m.get(k)
    if (q === undefined || q.length === 0) return undefined
    const v = q.shift()
    if (q.length === 0) m.delete(k)
    return v
  }

  // `run_agent` is represented by the sub-agent container (Task pill + tree
  // node) built from the subagent_start/end events, not by a tool pill of its
  // own (it would be redundant). (Replaces the old `delegate_to_*` filtering.)
  const isSpawn = (name: string): boolean => name === "run_agent"
  const joinDetail = (
    ...parts: ReadonlyArray<string | undefined>
  ): string | undefined =>
    parts.filter((p): p is string => p !== undefined).join(" · ") || undefined

  const syncAgents = (): void => {
    if (agentsBlockId !== undefined) store.updateAgents(agentsBlockId, [...agentRows.values()])
  }
  const touchAgentRow = (nodeId: string, f: (row: AgentRunRow) => AgentRunRow): void => {
    const row = agentRows.get(nodeId)
    if (row === undefined) return
    agentRows.set(nodeId, f(row))
    syncAgents()
  }

  return (event: AgentEvent): void => {
    const now = Date.now()
    switch (event.type) {
      case "turn_start":
        // The parent moved on — the fan-out burst (if any) is over; the next
        // spawn starts a fresh agents block.
        agentsBlockId = undefined
        agentRows.clear()
        store.setProjection((p) => ({ ...p, tree: treeTurnStart(p.tree, event.turnIndex, now) }))
        return

      case "tool_call_start": {
        // The spawn tool is the sub-agent container, not a tool node.
        if (isSpawn(event.toolName)) return
        const label = describeToolCall(event.toolName, event.args)
        // Inner calls carry their node id — attribute to THAT run's container
        // (parallel fan-out interleaves events; "deepest open" lies). A
        // top-level call still lands under the open turn.
        const owner = event.nodeId !== undefined ? subTreeByNode.get(event.nodeId) : undefined
        store.setProjection((p) => {
          const { tree, id } =
            owner !== undefined
              ? treeToolStartUnder(p.tree, owner, label, now)
              : treeToolStart(p.tree, label, now)
          enqueue(toolTreeIds, matchKey(event), id)
          return { ...p, tree }
        })
        // Top-level tools get a compact chat pill; sub-agent inner tools live
        // only in the tree — unless their node's session is open in the
        // preview, where they stream as live pills.
        if (event.nodeId === undefined && subAgentDepth === 0) {
          toolSeq++
          const sid = `t${toolSeq}`
          enqueue(toolScrollIds, matchKey(event), sid)
          store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running" })
        } else if (event.nodeId !== undefined && event.nodeId === previewRunNode) {
          toolSeq++
          const pid = `pv${toolSeq}`
          enqueue(previewToolIds, matchKey(event), pid)
          store.appendPreviewBlock({ kind: "tool", id: pid, toolName: label, state: "running" })
        }
        if (event.nodeId !== undefined) {
          touchAgentRow(event.nodeId, (r) => ({
            ...r,
            toolUses: r.toolUses + 1,
            currentTool: label,
          }))
        }
        return
      }

      case "tool_call_end": {
        if (isSpawn(event.toolName)) return
        const detail = describeToolResult(event.toolName, event.ok, event.result)
        const nodeId = dequeue(toolTreeIds, matchKey(event))
        if (nodeId !== undefined) {
          store.setProjection((p) => ({
            ...p,
            tree: treeToolEnd(p.tree, nodeId, event.ok, detail, now),
          }))
        }
        const artifacts = toolArtifacts(event.toolName, event.ok, event.result)
        const sid = dequeue(toolScrollIds, matchKey(event))
        if (sid !== undefined) {
          store.updateTool(sid, {
            state: event.ok ? "ok" : "error",
            ...(detail !== undefined ? { detail } : {}),
            ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
            ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
          })
        }
        const pid = dequeue(previewToolIds, matchKey(event))
        if (pid !== undefined) {
          store.patchPreviewTool(pid, {
            state: event.ok ? "ok" : "error",
            ...(detail !== undefined ? { detail } : {}),
            ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
          })
        }
        if (event.nodeId !== undefined) {
          touchAgentRow(event.nodeId, ({ currentTool: _done, ...r }) => r)
        }
        // Files-changed diffstat — structured, straight off the tool result (no
        // re-parsing the human detail string). Covers sub-agent inner edits too.
        if (artifacts.fileChange !== undefined) {
          const fc = artifacts.fileChange
          store.setProjection((p) => ({ ...p, filesChanged: mergeFileChange(p.filesChanged, fc) }))
        }
        return
      }

      case "subagent_start": {
        subAgentDepth++
        // This run's session is on-screen (the human resumed it from the
        // preview, or is watching the node the agent spawned into): its
        // events stream into the preview, and the parent rail gets no Task
        // pill — the run isn't the parent conversation's doing.
        const anchor =
          event.parentNodeId !== undefined ? subTreeByNode.get(event.parentNodeId) : undefined
        const startTree = (p: { tree: Parameters<typeof treeSubAgentStartKeyed>[0] }) => {
          const { tree, id } = treeSubAgentStartKeyed(
            p.tree,
            `run_agent → ${event.name}`,
            anchor,
            now,
          )
          if (event.nodeId !== undefined) subTreeByNode.set(event.nodeId, id)
          return tree
        }
        if (event.nodeId !== undefined && store.nodePreview()?.nodeId === event.nodeId) {
          previewRunNode = event.nodeId
          store.setProjection((p) => ({ ...p, tree: startTree(p) }))
          return
        }
        if (event.nodeId !== undefined) {
          // One grouped block per burst; each spawn is a live row in it.
          if (agentsBlockId === undefined) {
            toolSeq++
            agentsBlockId = `ag${toolSeq}`
            store.pushBlock({ kind: "agents", id: agentsBlockId, agents: [] })
          }
          agentRows.set(event.nodeId, {
            nodeId: event.nodeId,
            name: event.name,
            status: "running",
            toolUses: 0,
            tokens: 0,
          })
          syncAgents()
          store.setProjection((p) => ({ ...p, tree: startTree(p) }))
          return
        }
        const label = `Task(${event.name})`
        toolSeq++
        const sid = `sa${toolSeq}`
        subAgentScrollId.set(event.name, sid)
        store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running", output: event.task })
        store.setProjection((p) => ({ ...p, tree: startTree(p) }))
        return
      }

      case "subagent_end": {
        subAgentDepth = Math.max(0, subAgentDepth - 1)
        const filesDetail =
          event.filesChanged.length > 0
            ? `${event.filesChanged.length} file${event.filesChanged.length === 1 ? "" : "s"}`
            : undefined
        // The watched run finished: its prose already streamed into the
        // preview (assistant_message), and a failure must not be silent there.
        const ownTreeId = event.nodeId !== undefined ? subTreeByNode.get(event.nodeId) : undefined
        if (event.nodeId !== undefined) subTreeByNode.delete(event.nodeId)
        if (event.nodeId !== undefined && previewRunNode === event.nodeId) {
          previewRunNode = undefined
          if (!event.ok && event.summary.trim().length > 0) {
            store.appendPreviewBlock({ kind: "error", text: event.summary })
          }
          if (ownTreeId !== undefined) {
            store.setProjection((p) => ({
              ...p,
              tree: treeSubAgentEndKeyed(p.tree, ownTreeId, event.ok, filesDetail, now),
            }))
          }
          return
        }
        if (event.nodeId !== undefined && agentRows.has(event.nodeId)) {
          // Close the row in the grouped block. An ok summary stays off the
          // rail (the parent's prose relays results; ↵ on the node shows the
          // full session) — a failure is always loud.
          touchAgentRow(event.nodeId, ({ currentTool: _t, ...r }) => ({
            ...r,
            status: event.ok ? "ok" : "error",
            ...(event.usage !== undefined && r.tokens === 0
              ? { tokens: event.usage.inputTokens + event.usage.outputTokens }
              : {}),
          }))
          if (!event.ok && event.summary.trim().length > 0) {
            store.pushBlock({ kind: "error", text: `${event.name}: ${event.summary}` })
          }
          if (ownTreeId !== undefined) {
            store.setProjection((p) => ({
              ...p,
              tree: treeSubAgentEndKeyed(p.tree, ownTreeId, event.ok, filesDetail, now),
            }))
          }
          return
        }
        const endSid = subAgentScrollId.get(event.name)
        if (endSid !== undefined) {
          const pillDetail = joinDetail(
            filesDetail,
            event.usage !== undefined
              ? `${formatTokens(event.usage.inputTokens)} ctx · ${formatTokens(event.usage.outputTokens)} out`
              : undefined,
          )
          store.updateTool(endSid, {
            state: event.ok ? "ok" : "error",
            ...(pillDetail !== undefined ? { detail: pillDetail } : {}),
          })
          subAgentScrollId.delete(event.name)
        }
        if (event.summary.trim().length > 0) {
          store.pushBlock(
            event.ok
              ? { kind: "assistant", text: event.summary }
              : { kind: "error", text: `${event.name}: ${event.summary}` },
          )
        }
        const nodeDetail = joinDetail(
          filesDetail,
          event.usage !== undefined ? `${formatTokens(event.usage.inputTokens)} ctx` : undefined,
        )
        if (ownTreeId !== undefined) {
          store.setProjection((p) => ({
            ...p,
            tree: treeSubAgentEndKeyed(p.tree, ownTreeId, event.ok, nodeDetail, now),
          }))
        }
        return
      }

      case "skill_load":
        store.setProjection((p) =>
          p.skillsLoaded.includes(event.name)
            ? p
            : { ...p, skillsLoaded: [...p.skillsLoaded, event.name] },
        )
        return

      case "assistant_message": {
        // Sub-agent narration (depth > 0, forwarded by the inner hooks) never
        // lands on the parent rail and never counts toward the conversation
        // gauge (node usage is tracked on its tree node) — it streams into
        // the preview when that node's session is open, else tree-only.
        if (event.nodeId !== undefined || subAgentDepth > 0) {
          if (event.nodeId !== undefined && event.usage !== undefined) {
            const u = event.usage
            touchAgentRow(event.nodeId, (r) => ({
              ...r,
              tokens: r.tokens + u.inputTokens + u.outputTokens,
            }))
          }
          if (event.nodeId !== undefined && event.nodeId === previewRunNode) {
            if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
              store.appendPreviewBlock({ kind: "reasoning", text: event.reasoning })
            }
            if (event.text.trim().length > 0) {
              store.appendPreviewBlock({ kind: "assistant", text: event.text })
            }
          }
          return
        }
        if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
          store.pushBlock({ kind: "reasoning", text: event.reasoning })
        }
        if (event.text.trim().length > 0) {
          store.pushBlock({ kind: "assistant", text: event.text })
        }
        if (event.usage !== undefined) {
          const u = event.usage
          // Single source: fold usage into the session stats (the status bar +
          // Activity both read these). The per-turn `· N tok` is a separate
          // annotation on the execution tree, not a copy of the stats.
          store.setStats((s) => accumulateUsage(s, u))
          store.setProjection((p) => ({
            ...p,
            tree: treeTurnDetail(p.tree, `${formatTokens(u.outputTokens)} tok`),
          }))
        }
        return
      }

      case "agent_end":
        store.setProjection((p) => ({ ...p, tree: treeAgentEnd(p.tree, now) }))
        if (event.finalText.trim().length === 0) {
          store.pushBlock({
            kind: "info",
            text: "(agent stopped without a final answer — see ~/.efferent/efferent.log)",
          })
        }
        return

      case "error":
        store.pushBlock({ kind: "error", text: event.message })
        return
    }
  }
}

/**
 * Drain the agent event queue into the store, forever. Each event's signal
 * writes are wrapped in `batch()` so Solid flushes one frame per event rather
 * than one per setter. Forked with `Effect.forkScoped` so it's interrupted when
 * the TUI scope closes.
 */
export const runEventPump = (
  queue: Queue.Queue<AgentEvent>,
  reduce: (event: AgentEvent) => void,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.flatMap(Queue.take(queue), (event) =>
      Effect.sync(() => batch(() => reduce(event))),
    ),
  )
