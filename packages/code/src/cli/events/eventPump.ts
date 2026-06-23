import { Effect, Queue } from "effect"
import { batch } from "solid-js"
import type { AgentEvent } from "../../events.js"
import { reduceAgentState } from "../presentation/agentState.js"
import type { AgentRunRow } from "../presentation/conversation.js"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../presentation/toolDescribe.js"
import { formatTokens } from "../presentation/statusBar.js"
import { openApproval } from "../presentation/approvalView.js"
import {
  onAgentEnd as treeAgentEnd,
  onSubAgentEndKeyed as treeSubAgentEndKeyed,
  onSubAgentStartKeyed as treeSubAgentStartKeyed,
  onToolEnd as treeToolEnd,
  onToolStart as treeToolStart,
  onToolStartUnder as treeToolStartUnder,
  onTurnDetail as treeTurnDetail,
  onTurnStart as treeTurnStart,
  type ExecutionTree,
} from "../presentation/executionTree.js"
import {
  accumulateRoleSpend,
  accumulateUsage,
  mergeFileChange,
  parsePlanSteps,
} from "../presentation/sidePane.js"
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
export const makeEventReducer = (
  store: TuiStore,
  opts: {
    /** Fire-and-forget navigator reload (agents/sessions views). Called on
     *  sub-agent spawn/end so a RUNNING node is reachable in the agents pane
     *  mid-turn — without it the tree only refreshes at turn end and you
     *  can't open a live agent's session while it works. */
    readonly refreshNav?: () => void
  } = {},
): ((event: AgentEvent) => void) => {
  const toolTreeIds = new Map<string, number[]>() // matchKey → FIFO of tree node ids
  const toolScrollIds = new Map<string, string[]>() // matchKey → FIFO of scrollback pill ids
  const subAgentScrollId = new Map<string, string>() // subagent → scrollback pill id
  const previewToolIds = new Map<string, string[]>() // matchKey → FIFO of node-log pill ids
  const toolNodeId = new Map<string, string>() // matchKey → the node a logged tool pill belongs to
  const subTreeByNode = new Map<string, number>() // context-node id → Activity tree id
  // One live "Running N agents…" rail block per fan-out burst: rows keyed by
  // node id, updated in place (Claude-style), reset when the parent's next
  // turn starts. Replaces the old one-Task-pill-per-spawn rail.
  const agentRows = new Map<string, AgentRunRow>()
  let agentsBlockId: string | undefined
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

  // Is this node's session on-screen RIGHT NOW (preview overlay open on it)?
  // Read live per event — a captured "preview was open at spawn" flag freezes
  // a preview opened mid-run into a snapshot that only updates at the end.
  const watchedNode = (nodeId: string | undefined): boolean =>
    nodeId !== undefined && store.nodePreview()?.nodeId === nodeId

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
    // The live state machine reads EVERY event first — phases derive purely
    // (presentation/agentState.ts); the header + loading indicators follow.
    store.setAgentState((s) =>
      reduceAgentState(
        s,
        event,
        now,
        event.type === "tool_call_start"
          ? describeToolCall(event.toolName, event.args)
          : undefined,
      ),
    )
    switch (event.type) {
      case "turn_start":
        // The parent moved on — the fan-out burst (if any) is over; the next
        // spawn starts a fresh agents block.
        agentsBlockId = undefined
        agentRows.clear()
        store.setTree((t) => treeTurnStart(t, event.turnIndex, now))
        return

      case "tool_call_start": {
        // The plan tool's arguments ARE the session plan — mirror them into
        // the store when the top-level agent calls it (a sub-agent's plan
        // stays node-local; its session preview shows the calls).
        if (
          event.toolName === "update_plan" &&
          event.nodeId === undefined &&
          subAgentDepth === 0
        ) {
          const steps = parsePlanSteps(event.args)
          if (steps !== undefined) store.setProjection((p) => ({ ...p, plan: steps }))
        }
        // The spawn tool is the sub-agent container, not a tool node.
        if (isSpawn(event.toolName)) return
        const label = describeToolCall(event.toolName, event.args)
        // Inner calls carry their node id — attribute to THAT run's container
        // (parallel fan-out interleaves events; "deepest open" lies). A
        // top-level call still lands under the open turn.
        const owner = event.nodeId !== undefined ? subTreeByNode.get(event.nodeId) : undefined
        store.setTree((t) => {
          const { tree, id } =
            owner !== undefined
              ? treeToolStartUnder(t, owner, label, now)
              : treeToolStart(t, label, now)
          enqueue(toolTreeIds, matchKey(event), id)
          return tree
        })
        // Top-level tools get a compact chat pill on the lead rail; sub-agent
        // inner tools always stream into that node's live log (so opening its
        // pane — now or later — shows the whole run, not just events after you
        // looked), plus the tree.
        if (event.nodeId === undefined && subAgentDepth === 0) {
          toolSeq++
          const sid = `t${toolSeq}`
          enqueue(toolScrollIds, matchKey(event), sid)
          store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running" })
        } else if (event.nodeId !== undefined) {
          toolSeq++
          const pid = `nl${toolSeq}`
          enqueue(previewToolIds, matchKey(event), pid)
          toolNodeId.set(matchKey(event), event.nodeId)
          store.appendNodeLog(event.nodeId, { kind: "tool", id: pid, toolName: label, state: "running" })
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
          store.setTree((t) => treeToolEnd(t, nodeId, event.ok, detail, now))
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
        const pnode = toolNodeId.get(matchKey(event))
        if (pid !== undefined && pnode !== undefined) {
          toolNodeId.delete(matchKey(event))
          store.patchNodeLogTool(pnode, pid, {
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
        // Surface the freshly-spawned node in the agents navigator NOW — it's
        // already persisted, and waiting for turn end would make a running
        // agent unreachable mid-turn.
        opts.refreshNav?.()
        // Seed the node's live log with the task it was given — so its pane
        // opens onto "what it was asked", then streams its work under it. But
        // when a HUMAN resumed the node (the composer optimistically appended
        // their message just before resumeNode emitted this start), that line is
        // already the tail — appending the task again is the "double user
        // message on attach". Skip if the last entry already shows it (the task
        // may carry a staleness-brief prefix, so match by suffix too).
        if (event.nodeId !== undefined && event.task.trim().length > 0) {
          const log = store.nodeLog(event.nodeId)
          const last = log[log.length - 1]
          const alreadyShown =
            last !== undefined &&
            last.kind === "user" &&
            (last.text === event.task || event.task.trimEnd().endsWith(last.text.trimEnd()))
          if (!alreadyShown) store.appendNodeLog(event.nodeId, { kind: "user", text: event.task })
        }
        // This run's session is on-screen (the human resumed it from the
        // preview, or is watching the node the agent spawned into): its
        // events stream into the preview, and the parent rail gets no Task
        // pill — the run isn't the parent conversation's doing.
        const anchor =
          event.parentNodeId !== undefined ? subTreeByNode.get(event.parentNodeId) : undefined
        const startTree = (t: ExecutionTree): ExecutionTree => {
          const { tree, id } = treeSubAgentStartKeyed(
            t,
            `run_agent → ${event.name}`,
            anchor,
            now,
            event.nodeId,
          )
          if (event.nodeId !== undefined) subTreeByNode.set(event.nodeId, id)
          return tree
        }
        if (watchedNode(event.nodeId)) {
          store.setTree(startTree)
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
          store.setTree(startTree)
          return
        }
        const label = `Task(${event.name})`
        toolSeq++
        const sid = `sa${toolSeq}`
        subAgentScrollId.set(event.name, sid)
        store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running", output: event.task })
        store.setTree(startTree)
        return
      }

      case "subagent_end": {
        subAgentDepth = Math.max(0, subAgentDepth - 1)
        // Status glyph / summary / tokens just landed on the persisted node.
        opts.refreshNav?.()
        const filesDetail =
          event.filesChanged.length > 0
            ? `${event.filesChanged.length} file${event.filesChanged.length === 1 ? "" : "s"}`
            : undefined
        // The watched run finished: its prose already streamed into the
        // preview (assistant_message), and a failure must not be silent there.
        // Watched and grouped-block states can BOTH hold (a node spawned
        // unwatched whose preview was opened mid-run), so the preview append
        // composes with the row close instead of short-circuiting it.
        const ownTreeId = event.nodeId !== undefined ? subTreeByNode.get(event.nodeId) : undefined
        if (event.nodeId !== undefined) subTreeByNode.delete(event.nodeId)
        // Log the run's conclusion into its own live log (its pane shows it),
        // whether or not that pane is open right now. But for a leaf agent the
        // return summary IS its final assistant message, which already streamed
        // into the log via assistant_message — appending it again is the
        // "double message on attach". Skip when the tail already shows it.
        if (event.nodeId !== undefined && event.summary.trim().length > 0) {
          const log = store.nodeLog(event.nodeId)
          const last = log[log.length - 1]
          const dup =
            last !== undefined &&
            (last.kind === "assistant" || last.kind === "error") &&
            last.text.trim() === event.summary.trim()
          if (!dup) {
            store.appendNodeLog(
              event.nodeId,
              event.ok
                ? { kind: "assistant", text: event.summary }
                : { kind: "error", text: event.summary },
            )
          }
        }
        // NOTE: a top-level lead's RESULT is no longer surfaced from here. The
        // Workspace now auto-resumes the orchestrator when a top-level lead
        // finishes (`onTopLevelDone` in inProcess.ts), so the lead's result is
        // reported by the orchestrator IN ITS OWN VOICE (its inbox-folded turn
        // streams as normal assistant prose). Pushing the raw summary here too
        // would double it. Specialist outcomes stay in the tree (✗/✓) + the log.
        if (event.nodeId !== undefined && watchedNode(event.nodeId) && !agentRows.has(event.nodeId)) {
          // Human-driven resume (no rail presence) — close its tree node only.
          if (ownTreeId !== undefined) {
            store.setTree((t) => treeSubAgentEndKeyed(t, ownTreeId, event.ok, filesDetail, now))
          }
          return
        }
        if (event.nodeId !== undefined && agentRows.has(event.nodeId)) {
          // Close the row in the grouped block. The summary — the run's actual
          // return value, what the parent model received — lands on the row's
          // sub-line (truncated; ↵ on the node shows the full session), and a
          // failure shows as a ✗ glyph on the row + in the fleet tree. We do NOT
          // push a red block here: a specialist failing is the lead's concern,
          // not chat noise (only the top-level lead's outcome surfaces, above).
          touchAgentRow(event.nodeId, ({ currentTool: _t, ...r }) => ({
            ...r,
            status: event.ok ? "ok" : "error",
            ...(event.summary.trim().length > 0 ? { summary: event.summary.trim() } : {}),
            ...(event.usage !== undefined && r.tokens === 0
              ? { tokens: event.usage.inputTokens + event.usage.outputTokens }
              : {}),
          }))
          if (ownTreeId !== undefined) {
            store.setTree((t) => treeSubAgentEndKeyed(t, ownTreeId, event.ok, filesDetail, now))
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
          store.setTree((t) => treeSubAgentEndKeyed(t, ownTreeId, event.ok, nodeDetail, now))
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

      case "helper_usage":
        // A fast-tier helper call inside the loop (compaction summaries, titles) — ledger only.
        store.setStats((s) =>
          accumulateRoleSpend(s, event.role, event.usage.inputTokens + event.usage.outputTokens),
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
            // Sub-agents run on MAIN (delegation changes the context, not the
            // brain) — their spend lands on main's ledger. Node-local usage
            // still stays off the conversation gauge.
            store.setStats((s) =>
              accumulateRoleSpend(s, "main", u.inputTokens + u.outputTokens),
            )
          }
          // Always stream the narration into the node's live log (its pane reads
          // it), regardless of whether that pane is open right now.
          if (event.nodeId !== undefined) {
            if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
              store.appendNodeLog(event.nodeId, { kind: "reasoning", text: event.reasoning })
            }
            if (event.text.trim().length > 0) {
              store.appendNodeLog(event.nodeId, { kind: "assistant", text: event.text })
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
          store.setTree((t) => treeTurnDetail(t, `${formatTokens(u.outputTokens)} tok`))
        }
        return
      }

      case "agent_end":
        store.setTree((t) => treeAgentEnd(t, now))
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

      case "approval_needed": {
        // Remote-client path: the daemon parked on a bash approval — render the
        // sheet. The key handler answers via `ctx.resolveApproval` → `approve`.
        // (In-process never emits this; it uses `makeTuiApproval` directly.)
        const hint = {
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          ...(event.folder !== undefined ? { folder: event.folder } : {}),
        }
        store.setOverlay({
          kind: "approval",
          state: openApproval(
            { tool: event.tool, summary: event.summary, cwd: event.cwd, ruleKey: event.ruleKey },
            hint,
          ),
        })
        return
      }

      case "approval_resolved":
        // Some client answered — clear a stale sheet here.
        if (store.overlay().kind === "approval") store.closeOverlay()
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
