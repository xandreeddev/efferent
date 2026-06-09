import { Effect, Queue } from "effect"
import { batch } from "solid-js"
import type { AgentEvent } from "../../events.js"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../presentation/toolDescribe.js"
import { formatTokens } from "../presentation/statusBar.js"
import {
  onAgentEnd as treeAgentEnd,
  onSubAgentEnd as treeSubAgentEnd,
  onSubAgentStart as treeSubAgentStart,
  onToolEnd as treeToolEnd,
  onToolStart as treeToolStart,
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
  let subAgentDepth = 0
  let toolSeq = 0

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

  return (event: AgentEvent): void => {
    const now = Date.now()
    switch (event.type) {
      case "turn_start":
        store.setProjection((p) => ({ ...p, tree: treeTurnStart(p.tree, event.turnIndex, now) }))
        return

      case "tool_call_start": {
        // The spawn tool is the sub-agent container, not a tool node.
        if (isSpawn(event.toolName)) return
        const label = describeToolCall(event.toolName, event.args)
        store.setProjection((p) => {
          const { tree, id } = treeToolStart(p.tree, label, now)
          enqueue(toolTreeIds, matchKey(event), id)
          return { ...p, tree }
        })
        // Top-level tools get a compact chat pill; sub-agent inner tools live
        // only in the tree.
        if (subAgentDepth === 0) {
          toolSeq++
          const sid = `t${toolSeq}`
          enqueue(toolScrollIds, matchKey(event), sid)
          store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running" })
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
        const label = `Task(${event.name})`
        toolSeq++
        const sid = `sa${toolSeq}`
        // Keyed by nodeId when present: parallel fan-out can run two spawns
        // with the same basename, and a name key would cross their pills.
        subAgentScrollId.set(event.nodeId ?? event.name, sid)
        store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running", output: event.task })
        store.setProjection((p) => ({
          ...p,
          tree: treeSubAgentStart(p.tree, `run_agent → ${event.name}`, now),
        }))
        return
      }

      case "subagent_end": {
        subAgentDepth = Math.max(0, subAgentDepth - 1)
        const filesDetail =
          event.filesChanged.length > 0
            ? `${event.filesChanged.length} file${event.filesChanged.length === 1 ? "" : "s"}`
            : undefined
        const endSid = subAgentScrollId.get(event.nodeId ?? event.name)
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
          subAgentScrollId.delete(event.nodeId ?? event.name)
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
        store.setProjection((p) => ({
          ...p,
          tree: treeSubAgentEnd(p.tree, event.ok, nodeDetail, now),
        }))
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
