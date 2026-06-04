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
import { accumulateUsage, type FileChange } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"

/**
 * Maps the mode-agnostic `AgentEvent` stream onto the UI signals — the Effect→
 * Solid crossing. The branch logic is lifted verbatim from the old `consumer`
 * forkDaemon (`tui.ts:1070-1332`); only the write target changes: conversation
 * blocks go through `store.pushBlock`/`store.updateTool`, the execution tree +
 * diffstat through `store.setSidePane` (reusing the pure reducers from
 * `presentation/executionTree.ts`), and per-turn usage through `store.setStats`
 * (the single source the status bar + Activity both read).
 *
 * Events carry no unique tool-call id, so — exactly like the old TUI — start↔end
 * are matched by tool name (most recent in-flight wins), the scrollback pill gets
 * a `t<n>` id and the tree node its numeric id. This closure holds that matching
 * state, so one reducer instance lives per pump.
 */
export const makeEventReducer = (store: TuiStore): ((event: AgentEvent) => void) => {
  const toolTreeId = new Map<string, number>() // toolName → tree node id
  const toolScrollId = new Map<string, string>() // toolName → scrollback pill id
  const subAgentScrollId = new Map<string, string>() // subagent → scrollback pill id
  const toolPath = new Map<string, string>() // edit/write toolName → path (diffstat)
  let subAgentDepth = 0
  let toolSeq = 0

  const isDelegate = (name: string): boolean => name.startsWith("delegate_to_")
  const joinDetail = (
    ...parts: ReadonlyArray<string | undefined>
  ): string | undefined =>
    parts.filter((p): p is string => p !== undefined).join(" · ") || undefined

  return (event: AgentEvent): void => {
    const now = Date.now()
    switch (event.type) {
      case "turn_start":
        store.setSidePane((s) => ({ ...s, tree: treeTurnStart(s.tree, event.turnIndex, now) }))
        return

      case "tool_call_start": {
        // Delegations are the sub-agent container, not a tool node.
        if (isDelegate(event.toolName)) return
        if (event.toolName === "edit_file" || event.toolName === "write_file") {
          const p = (event.args as { path?: unknown }).path
          if (typeof p === "string") toolPath.set(event.toolName, p)
        }
        const label = describeToolCall(event.toolName, event.args)
        store.setSidePane((s) => {
          const { tree, id } = treeToolStart(s.tree, label, now)
          toolTreeId.set(event.toolName, id)
          return { ...s, tree }
        })
        // Top-level tools get a compact chat pill; sub-agent inner tools live
        // only in the tree.
        if (subAgentDepth === 0) {
          toolSeq++
          const sid = `t${toolSeq}`
          toolScrollId.set(event.toolName, sid)
          store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running" })
        }
        return
      }

      case "tool_call_end": {
        if (isDelegate(event.toolName)) return
        const detail = describeToolResult(event.toolName, event.ok, event.result)
        const nodeId = toolTreeId.get(event.toolName)
        if (nodeId !== undefined) {
          store.setSidePane((s) => ({
            ...s,
            tree: treeToolEnd(s.tree, nodeId, event.ok, detail, now),
          }))
          toolTreeId.delete(event.toolName)
        }
        const sid = toolScrollId.get(event.toolName)
        if (sid !== undefined) {
          const artifacts = toolArtifacts(event.toolName, event.ok, event.result)
          store.updateTool(sid, {
            state: event.ok ? "ok" : "error",
            ...(detail !== undefined ? { detail } : {}),
            ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
            ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
          })
          toolScrollId.delete(event.toolName)
        }
        // Files-changed diffstat (edit/write only, on success).
        if (event.ok && (event.toolName === "edit_file" || event.toolName === "write_file")) {
          const path = toolPath.get(event.toolName)
          toolPath.delete(event.toolName)
          if (path !== undefined) {
            let added = 0
            let removed = 0
            if (detail !== undefined) {
              const m = /\+(\d+)\/-(\d+)/.exec(detail)
              if (m !== null) {
                added = Number(m[1])
                removed = Number(m[2])
              } else {
                const w = /(\d+)/.exec(detail) // write_file: "wrote N lines"
                if (w !== null) added = Number(w[1])
              }
            }
            store.setSidePane((s) => {
              const existing = s.filesChanged.find((f) => f.path === path)
              const next: FileChange =
                existing !== undefined
                  ? { path, added: existing.added + added, removed: existing.removed + removed }
                  : { path, added, removed }
              return {
                ...s,
                filesChanged:
                  existing !== undefined
                    ? s.filesChanged.map((f) => (f.path === path ? next : f))
                    : [...s.filesChanged, next],
              }
            })
          }
        }
        return
      }

      case "subagent_start": {
        subAgentDepth++
        const label = `Task(${event.name})`
        toolSeq++
        const sid = `sa${toolSeq}`
        subAgentScrollId.set(event.name, sid)
        store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running", output: event.task })
        store.setSidePane((s) => ({
          ...s,
          tree: treeSubAgentStart(s.tree, `delegate → ${event.name}`, now),
        }))
        return
      }

      case "subagent_end": {
        subAgentDepth = Math.max(0, subAgentDepth - 1)
        const filesDetail =
          event.filesChanged.length > 0
            ? `${event.filesChanged.length} file${event.filesChanged.length === 1 ? "" : "s"}`
            : undefined
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
        store.setSidePane((s) => ({
          ...s,
          tree: treeSubAgentEnd(s.tree, event.ok, nodeDetail, now),
        }))
        return
      }

      case "skill_load":
        store.setSidePane((s) =>
          s.skillsLoaded.includes(event.name)
            ? s
            : { ...s, skillsLoaded: [...s.skillsLoaded, event.name] },
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
          store.setSidePane((s) => ({
            ...s,
            tree: treeTurnDetail(s.tree, `${formatTokens(u.outputTokens)} tok`),
          }))
        }
        return
      }

      case "agent_end":
        store.setSidePane((s) => ({ ...s, tree: treeAgentEnd(s.tree, now) }))
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
