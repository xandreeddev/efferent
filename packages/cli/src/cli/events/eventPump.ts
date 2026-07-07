import { Effect, Queue } from "effect"
import { batch } from "solid-js"
import type { AgentEvent } from "../../events.js"
import { fleetCompletionLine, reduceAgentState } from "../presentation/agentState.js"
import { messageKey } from "../presentation/conversation.js"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../presentation/toolDescribe.js"
import { formatTokens } from "../presentation/statusBar.js"
import { openApproval } from "../presentation/approvalView.js"
import { decisionId } from "../state/decisions.js"
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
  const previewToolIds = new Map<string, string[]>() // matchKey → FIFO of node-log pill ids
  const toolNodeId = new Map<string, string>() // matchKey → the node a logged tool pill belongs to
  const subTreeByNode = new Map<string, number>() // context-node id → Activity tree id
  // Top-level sub-agents (the leads the root orchestrates — spawned with no
  // parent node). Only these get a clean completion line on the root rail;
  // deeper workers are the lead's concern and surface in the fleet tree only.
  const topLevelNodes = new Set<string>()
  let toolSeq = 0

  /** Prevent unbounded growth when end events are lost (crashes, transport drops). */
  const trimOldest = <K, V>(m: Map<K, V>, max: number): void => {
    while (m.size > max) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
      else break
    }
  }
  const MAX_TOOL_MAP_SIZE = 200
  const MAX_SUBTREE_SIZE = 500

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
        store.setTree((t) => treeTurnStart(t, event.turnIndex, now))
        return

      case "user_message": {
        // The user's prompt for a turn, flowing through the keyed stream (the
        // daemon emits it now — no client-side queue-diff reconstruction). On
        // the root rail it reconciles with any optimistic line by position; a
        // sub-agent's seed/user line streams into that node's live log.
        if (event.nodeId !== undefined) {
          store.appendNodeLog(event.nodeId, { kind: "user", text: event.text })
          return
        }
        if (event.position !== undefined) {
          store.resolveOptimisticUser(event.position, event.text)
        } else {
          store.pushBlock({ kind: "user", text: event.text })
        }
        return
      }

      case "tool_call_start": {
        // The plan tool's arguments ARE the session plan — mirror them into
        // the store when the ROOT agent calls it (a sub-agent's plan stays
        // node-local; its session preview shows the calls). Keyed off the
        // event's own `nodeId` (undefined ⇒ root), NOT an ambient depth counter:
        // in the async fleet the root runs CONCURRENTLY with background agents,
        // so "a sub-agent is running somewhere" must not gate the root's plan.
        if (event.toolName === "update_plan" && event.nodeId === undefined) {
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
          trimOldest(toolTreeIds, MAX_TOOL_MAP_SIZE)
          return tree
        })
        // Root tools get a compact chat pill on the lead rail; sub-agent inner
        // tools always stream into that node's live log (so opening its pane —
        // now or later — shows the whole run, not just events after you looked),
        // plus the tree. Routed by the event's own `nodeId` (undefined ⇒ root),
        // so a root tool call still gets its rail pill while a fleet runs.
        if (event.nodeId === undefined) {
          // Key the rail pill by the tool-call id — the SAME identity
          // `projectHistory` stamps (`part.toolCallId`). So when an idle resync
          // re-projects this turn, the projected pill upserts onto the live one
          // instead of the live pill surviving as an unmatched suffix and
          // "jumping to the end". The loop now mints a DETERMINISTIC id at the
          // source (`ensureToolCallIds`) for any provider that omits one, writing
          // it into BOTH the event and the persisted message — so `event.id` is
          // always non-empty here and matches the projected key. The `t<seq>`
          // counter is a defensive last resort that should never fire (an
          // ephemeral per-process id WOULD re-introduce the jump-to-end bug).
          const sid = event.id.length > 0 ? event.id : `t${++toolSeq}`
          enqueue(toolScrollIds, matchKey(event), sid)
          trimOldest(toolScrollIds, MAX_TOOL_MAP_SIZE)
          store.pushBlock({ kind: "tool", id: sid, toolName: label, state: "running" })
        } else if (event.nodeId !== undefined) {
          toolSeq++
          const pid = `nl${toolSeq}`
          enqueue(previewToolIds, matchKey(event), pid)
          trimOldest(previewToolIds, MAX_TOOL_MAP_SIZE)
          toolNodeId.set(matchKey(event), event.nodeId)
          trimOldest(toolNodeId, MAX_TOOL_MAP_SIZE)
          store.appendNodeLog(event.nodeId, { kind: "tool", id: pid, toolName: label, state: "running" })
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
        // Files-changed diffstat — structured, straight off the tool result (no
        // re-parsing the human detail string). Covers sub-agent inner edits too.
        if (artifacts.fileChange !== undefined) {
          const fc = artifacts.fileChange
          store.setProjection((p) => ({ ...p, filesChanged: mergeFileChange(p.filesChanged, fc) }))
        }
        return
      }

      case "subagent_start": {
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
        // No parent node ⇒ a TOP-LEVEL lead the root spawned — it earns a clean
        // completion line on the root rail when it finishes (see subagent_end).
        if (event.nodeId !== undefined && event.parentNodeId === undefined) {
          topLevelNodes.add(event.nodeId)
          if (topLevelNodes.size > MAX_SUBTREE_SIZE) {
            const oldest = topLevelNodes.values().next().value
            if (oldest !== undefined) topLevelNodes.delete(oldest)
          }
        }
        const startTree = (t: ExecutionTree): ExecutionTree => {
          const { tree, id } = treeSubAgentStartKeyed(
            t,
            `run_agent → ${event.name}`,
            anchor,
            now,
            event.nodeId,
          )
          if (event.nodeId !== undefined) {
            subTreeByNode.set(event.nodeId, id)
            trimOldest(subTreeByNode, MAX_SUBTREE_SIZE)
          }
          return tree
        }
        // The fleet lives ONLY in the right-pane fleet tree now — a spawn updates
        // the execution tree (and the navigator via refreshNav + the node's live
        // log), never the conversation rail. No `agents` rail block, no Task pill:
        // the rail stays the orchestrator's own voice + its own tools.
        store.setTree(startTree)
        return
      }

      case "subagent_end": {
        // Status glyph / summary / tokens just landed on the persisted node.
        opts.refreshNav?.()
        // Honest 4-valued outcome (legacy emitters carry only `ok`).
        const outcome = event.outcome ?? (event.ok ? "ok" : "error")
        // The run is terminal — its live health entry is done.
        if (event.nodeId !== undefined) store.clearNodeHealth(event.nodeId)
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
              outcome === "ok"
                ? { kind: "assistant", text: event.summary }
                : outcome === "partial"
                  ? { kind: "assistant", text: event.summary }
                  : { kind: "error", text: event.summary },
            )
          }
          if (outcome === "partial") {
            store.appendNodeLog(event.nodeId, {
              kind: "info",
              text: `stopped early (${event.reason ?? "partial"}) — the result above is usable but incomplete`,
            })
          }
        }
        // A sub-agent surfaces ONLY in the fleet (the tree + the navigator + its
        // own live log) — never on the root rail. A top-level lead's result is
        // reported by the orchestrator IN ITS OWN VOICE (the `onTopLevelDone`
        // auto-resume folds its inbox and streams normal assistant prose); a
        // specialist's outcome is the lead's concern (✓/◐/✗ in the tree). So
        // here we only close the tree node — no rail block, no Task pill.
        const nodeDetail = joinDetail(
          outcome === "partial" || outcome === "killed"
            ? (event.reason ?? outcome)
            : undefined,
          filesDetail,
          event.usage !== undefined ? `${formatTokens(event.usage.inputTokens)} ctx` : undefined,
        )
        if (ownTreeId !== undefined) {
          store.setTree((t) => treeSubAgentEndKeyed(t, ownTreeId, event.ok, nodeDetail, now))
        }
        // ONE clean completion line on the root rail for a TOP-LEVEL lead — the
        // Claude-style "● agent finished" update. Deeper workers stay in the tree
        // only. The orchestrator still reports the full result in its own voice
        // (onTopLevelDone auto-resume); this is the quick progress beat alongside.
        if (event.nodeId !== undefined && topLevelNodes.delete(event.nodeId)) {
          store.pushBlock({
            kind: "info",
            text: fleetCompletionLine(event.name, outcome, event.summary, event.reason),
          })
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
        // Sub-agent narration (it carries a `nodeId`, stamped by the inner
        // hooks) never lands on the parent rail and never counts toward the
        // conversation gauge (node usage lives on its tree node) — it streams
        // into the preview when that node's session is open, else tree-only.
        // Discriminate ONLY on the event's `nodeId`: in the async fleet the root
        // orchestrator (no nodeId) emits turns WHILE background agents run, so an
        // ambient depth counter would wrongly swallow the root's own narration
        // mid-fleet and then make it "pop" all at once on the next resync.
        if (event.nodeId !== undefined) {
          if (event.usage !== undefined) {
            const u = event.usage
            // A sub-agent's spend lands on the role it runs as (general | code),
            // carried on the event by the inner hooks; absent ⇒ general. Node-
            // local usage still stays off the conversation gauge.
            const role = event.subAgentRole ?? "general"
            store.setStats((s) =>
              accumulateRoleSpend(s, role, u.inputTokens + u.outputTokens),
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
        // Key the rail blocks on the message's absolute position so a replay or
        // a DB re-projection of this same message upserts in place — the dup
        // fix. (Absent only on the eval/direct path, which has no pump.)
        const pos = event.position
        if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
          store.pushBlock(
            pos !== undefined
              ? { kind: "reasoning", text: event.reasoning, key: messageKey(pos, "r", 0) }
              : { kind: "reasoning", text: event.reasoning },
          )
        }
        if (event.text.trim().length > 0) {
          store.pushBlock(
            pos !== undefined
              ? { kind: "assistant", text: event.text, key: messageKey(pos, "a", 0) }
              : { kind: "assistant", text: event.text },
          )
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

      case "agent_end": {
        store.setTree((t) => treeAgentEnd(t, now))
        const outcome = event.outcome ?? "ok"
        if (outcome === "killed") {
          // The turn was interrupted — the honest terminal event replaces the
          // old silence + driver-side state guessing.
          store.pushBlock({ kind: "info", text: "turn interrupted" })
        } else if (outcome === "partial") {
          store.pushBlock({
            kind: "info",
            text: `◐ the turn stopped early (${event.reason ?? "partial"}) — the answer above is incomplete`,
          })
        } else if (event.finalText.trim().length === 0) {
          store.pushBlock({
            kind: "info",
            text: "(agent stopped without a final answer — see ~/.efferent/efferent.log)",
          })
        }
        return
      }

      case "error":
        store.pushBlock({ kind: "error", text: event.message })
        return

      case "llm_retry": {
        // A transient provider failure is backing off — show the wait live so a
        // pause reads as "retrying", not a hang. (The hard failure, if retries
        // exhaust, still arrives as an `error` block.) A SUB-AGENT's retry goes
        // to ITS log (the fleet tree's health suffix shows it live) — the root
        // rail only carries the root's own retries.
        const secs = Math.max(1, Math.round(event.delayMs / 1000))
        // Patient ladder (waiting out an outage) → elapsed/budget wording;
        // fast retries → the attempt counter.
        const text =
          event.elapsedMs !== undefined
            ? `provider ${event.reason} — down ${Math.max(1, Math.round(event.elapsedMs / 60_000))}m, retrying in ${secs}s (waits up to ${Math.round((event.budgetMs ?? 0) / 60_000)}m; esc cancels)`
            : `provider ${event.reason} — retrying in ${secs}s (attempt ${event.attempt}/${event.maxAttempts})`
        if (event.nodeId !== undefined) {
          store.appendNodeLog(event.nodeId, { kind: "info", text })
        } else {
          store.pushBlock({ kind: "info", text })
        }
        return
      }

      case "bg_output": {
        // Live output from a background process (Bash run_in_background) — show
        // the latest non-empty line so a long-runner reads as alive. The model
        // still polls full output via bash_output; this is just awareness.
        const line = event.chunk
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0)
          .pop()
        if (line !== undefined) {
          store.pushBlock({
            kind: "info",
            text: `${event.processId}: ${line.slice(0, 200)}`,
          })
        }
        return
      }

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
        // Some client answered — clear a stale sheet here, and drop any PARKED
        // decisions for that session (the need was resolved). Interactive
        // roster entries clear by the same path: once the ask is answered, the
        // session's parked-or-not entries no longer need surfacing — but only
        // the parked ones are auto-cleared (the interactive mirror is dropped by
        // the sheet's own resolve). `clearSession` only touches parked entries.
        if (store.overlay().kind === "approval") store.closeOverlay()
        store.clearSession(event.sessionId)
        return

      case "needs_human": {
        // The control-plane "decisions" channel. Mirror the need into the
        // pending-decisions roster (de-duped by session+summary). `parked: true`
        // is an UNATTENDED denial recorded for later review; `parked: false` is
        // an interactive ask whose live sheet is already up (this is the roster
        // visibility). The interactive sheet itself stays on `approval_needed`.
        store.pushDecision({
          id: decisionId(event),
          ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
          ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
          ...(event.tool !== undefined ? { tool: event.tool } : {}),
          summary: event.summary,
          reason: event.reason,
          ...(event.folder !== undefined ? { folder: event.folder } : {}),
          parked: event.parked,
        })
        return
      }

      case "agent_health": {
        // A running agent's live state — pure signal write (the fleet tree's
        // running rows read the map for their suffix). Never a rail line.
        store.setNodeHealth(event.nodeId, {
          state: event.state,
          lastActivityAt: event.lastActivityAt,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        })
        return
      }

      // The inter-agent message stream: no longer dropped. Every note lands in
      // the SENDER-adjacent surfaces (a root-addressed note also gets ONE dim
      // rail line, so the human sees fleet→root traffic without opening panes).
      case "board_note": {
        const clipped =
          event.note.length > 200 ? `${event.note.slice(0, 199)}…` : event.note
        const rootKey = String(store.run.getConversationId())
        if (event.to !== undefined && event.to === rootKey) {
          // Root-addressed (a completion note / a message to the lead) → one
          // dim rail line, so fleet→root traffic is visible without panes.
          store.pushBlock({ kind: "info", text: `✉ ${event.from}: ${clipped}` })
        } else if (event.to !== undefined) {
          // Addressed to an agent's inbox → that node's log shows it.
          store.appendNodeLog(event.to, {
            kind: "info",
            text: `✉ from ${event.from}: ${clipped}`,
          })
        }
        // Broadcasts (no `to`) stay off the rail — the blackboard is ambient
        // chatter the agents read themselves.
        return
      }

      // Generative UI is a WEB surface concern (`efferent web` renders it into
      // the canvas); the TUI deliberately ignores it — an explicit no-op so the
      // event is documented as seen, not forgotten.
      case "ui_render":
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
