/**
 * AgentEvent → WebModel reducer — the web port of the TUI event pump's switch
 * (`cli/events/eventPump.ts`), leaner by design: no execution tree, no per-node
 * logs; sub-agent activity aggregates into chips (the solo-web fleet is 1-2
 * helpers, not a swarm). Same disciplines, though:
 *   - demux by the event's `nodeId` (undefined ⇒ the root rail)
 *   - tool start↔end matched by tool-call id, FIFO per key (parallel same-name
 *     calls pair in emission order); args cached from the start for derivation
 *   - message blocks keyed by absolute store position (`messageKey`) so a
 *     replay/full-render upserts instead of duplicating
 * One reducer instance per pump (the closure holds the matching state).
 */
import type { AgentEvent, PlanStep } from "@xandreed/sdk-core"
import { reducePhase } from "@xandreed/sdk-core"
import { fleetCompletionLine } from "../cli/presentation/agentState.js"
import { messageKey } from "../cli/presentation/conversation.js"
import { describeToolCall, describeToolResult, toolArtifacts } from "../cli/presentation/toolDescribe.js"
import { parsePlanSteps } from "../cli/presentation/sidePane.js"
import { deriveWorkspaceItem, domIdForKey, type WorkspaceItemView } from "@xandreed/web"
import {
  AGENTS_BLOCK_KEY,
  patchToolBlock,
  putBlock,
  putCanvas,
  putChip,
  putWorkspaceItem,
  type Patch,
  type WebModel,
} from "./model.js"

export interface Reduced {
  readonly model: WebModel
  readonly patches: ReadonlyArray<Patch>
}

const same = (m: WebModel): Reduced => ({ model: m, patches: [] })

/** Fold `putChip` and re-emit the agents container block (one patch). */
const chipUpdate = (
  m: WebModel,
  nodeId: string,
  f: Parameters<typeof putChip>[2],
): Reduced => {
  const withChip = putChip(m, nodeId, f)
  const { model, patch } = putBlock(withChip, {
    kind: "agents",
    id: AGENTS_BLOCK_KEY,
    agents: withChip.agents.map((a) => ({
      nodeId: a.nodeId,
      name: a.name,
      status: a.status,
      toolUses: a.toolUses,
      tokens: a.tokens,
      ...(a.currentTool !== undefined ? { currentTool: a.currentTool } : {}),
      ...(a.summary !== undefined ? { summary: a.summary } : {}),
    })),
  })
  return { model, patches: [patch] }
}

const info = (m: WebModel, text: string): Reduced => {
  const { model, patch } = putBlock(m, { kind: "info", text })
  return { model, patches: [patch] }
}

/** Set the activity strip's label (undefined clears); emits the patch only
 *  when the label actually changed. */
const withActivityLabel = (r: Reduced, label: string | undefined): Reduced => {
  if (r.model.activity.label === label) return r
  return {
    model: { ...r.model, activity: label === undefined ? {} : { label } },
    patches: [...r.patches, { kind: "activity" }],
  }
}

/** A workspace card's DOM id — mirrors the component keying (fileRef by path,
 *  diff/source cards by tool-call id) so a pill's `data-ref` lands on it. */
const workspaceDomId = (item: WorkspaceItemView): string | undefined => {
  switch (item.kind) {
    case "file":
      return domIdForKey("ws-file", item.file.path)
    case "diff":
      return domIdForKey("ws-item", item.diff.id)
    case "source":
      return domIdForKey("ws-item", item.source.id)
    case "plan":
      return undefined
  }
}

export const makeWebReducer = (
  rootKey: string,
  now: () => number = () => Date.now(),
): ((model: WebModel, event: AgentEvent) => Reduced) => {
  // matchKey → FIFO of { pill key, cached args } (args feed deriveWorkspaceItem
  // at tool_call_end, which carries only the result).
  const inFlight = new Map<string, Array<{ readonly key: string; readonly args: unknown }>>()
  let toolSeq = 0
  const matchKey = (e: { readonly id?: string; readonly toolName: string }): string =>
    e.id !== undefined && e.id.length > 0 ? e.id : e.toolName
  const enqueue = (k: string, v: { key: string; args: unknown }): void => {
    const q = inFlight.get(k)
    if (q !== undefined) q.push(v)
    else inFlight.set(k, [v])
    // Bounded: lost end events (crashes) must not grow the map forever.
    if (inFlight.size > 200) {
      const first = inFlight.keys().next().value
      if (first !== undefined) inFlight.delete(first)
    }
  }
  const dequeue = (k: string): { key: string; args: unknown } | undefined => {
    const q = inFlight.get(k)
    if (q === undefined || q.length === 0) return undefined
    const v = q.shift()
    if (q.length === 0) inFlight.delete(k)
    return v
  }

  return (m0: WebModel, event: AgentEvent): Reduced => {
    // Phase first (root events only move it — reducePhase skips nodeId events).
    // A phase change repaints the header AND the activity strip; the elapsed
    // clock starts on idle→busy and clears on the way back.
    const phase = reducePhase(m0.phase, event)
    const phaseChanged = phase.phase !== m0.phase.phase
    const phasePatches: Patch[] = phaseChanged ? [{ kind: "header" }, { kind: "activity" }] : []
    const wentBusy = phaseChanged && m0.phase.phase === "idle"
    const wentIdle = phaseChanged && phase.phase === "idle"
    const m: WebModel =
      phase === m0.phase
        ? m0
        : {
            ...m0,
            phase,
            ...(wentBusy ? { activitySince: now() } : {}),
            ...(wentIdle ? { activitySince: undefined, activity: {} } : {}),
          }
    const withPhase = (r: Reduced): Reduced => ({
      model: r.model,
      patches: [...phasePatches, ...r.patches],
    })

    switch (event.type) {
      case "turn_start":
      case "flush":
        return withPhase(same(m))

      case "user_message": {
        if (event.nodeId !== undefined) return withPhase(same(m))
        // The authoritative user line — also drains the matching queued entry.
        const queueAt = m.queue.findIndex((q) => q === event.text)
        const queue = queueAt === -1 ? m.queue : m.queue.filter((_, i) => i !== queueAt)
        const base: WebModel = queueAt === -1 ? m : { ...m, queue }
        const { model, patch } = putBlock(base, {
          kind: "user",
          text: event.text,
          ...(event.position !== undefined ? { key: messageKey(event.position, "u", 0) } : {}),
        })
        return withPhase({ model, patches: queueAt === -1 ? [patch] : [patch, { kind: "queue" }] })
      }

      case "assistant_message": {
        if (event.nodeId !== undefined) {
          // Sub-agent narration: only its spend lands on the chip.
          if (event.usage === undefined) return withPhase(same(m))
          const u = event.usage
          return withPhase(
            chipUpdate(m, event.nodeId, (chip) => ({
              nodeId: event.nodeId ?? "",
              name: chip?.name ?? "agent",
              status: chip?.status ?? "running",
              toolUses: chip?.toolUses ?? 0,
              tokens: (chip?.tokens ?? 0) + u.inputTokens + u.outputTokens,
              ...(chip?.currentTool !== undefined ? { currentTool: chip.currentTool } : {}),
              ...(chip?.summary !== undefined ? { summary: chip.summary } : {}),
            })),
          )
        }
        const pos = event.position
        const patches: Patch[] = []
        let model = m
        if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
          const r = putBlock(model, {
            kind: "reasoning",
            text: event.reasoning,
            ...(pos !== undefined ? { key: messageKey(pos, "r", 0) } : {}),
          })
          model = r.model
          patches.push(r.patch)
        }
        if (event.text.trim().length > 0) {
          const a = putBlock(model, {
            kind: "assistant",
            text: event.text,
            ...(pos !== undefined ? { key: messageKey(pos, "a", 0) } : {}),
          })
          model = a.model
          patches.push(a.patch)
        }
        return withPhase({ model, patches })
      }

      case "tool_call_start": {
        if (event.nodeId !== undefined) {
          // Inner call → the chip's live sub-line.
          return withPhase(
            chipUpdate(m, event.nodeId, (chip) => ({
              nodeId: event.nodeId ?? "",
              name: chip?.name ?? "agent",
              status: chip?.status ?? "running",
              toolUses: (chip?.toolUses ?? 0) + 1,
              tokens: chip?.tokens ?? 0,
              currentTool: describeToolCall(event.toolName, event.args),
              ...(chip?.summary !== undefined ? { summary: chip.summary } : {}),
            })),
          )
        }
        const patches: Patch[] = []
        let model = m
        // The plan tool's args ARE the plan (root only).
        if (event.toolName === "update_plan") {
          const steps = parsePlanSteps(event.args)
          if (steps !== undefined) {
            model = { ...model, plan: steps as ReadonlyArray<PlanStep> }
            patches.push({ kind: "plan" })
          }
        }
        // The spawn container comes from subagent_start — no pill for run_agent.
        if (event.toolName === "run_agent") return withPhase({ model, patches })
        const label = describeToolCall(event.toolName, event.args)
        const sid = event.id.length > 0 ? event.id : `t${++toolSeq}`
        enqueue(matchKey(event), { key: sid, args: event.args })
        const b = putBlock(model, { kind: "tool", id: sid, toolName: label, state: "running" })
        // The activity strip mirrors the running tool.
        return withPhase(
          withActivityLabel({ model: b.model, patches: [...patches, b.patch] }, label),
        )
      }

      case "tool_call_end": {
        if (event.nodeId !== undefined) {
          return withPhase(
            chipUpdate(m, event.nodeId, (chip) => {
              const { currentTool: _clear, ...rest } = chip ?? {
                nodeId: event.nodeId ?? "",
                name: "agent",
                status: "running" as const,
                toolUses: 0,
                tokens: 0,
              }
              return rest
            }),
          )
        }
        if (event.toolName === "run_agent") return withPhase(same(m))
        const entry = dequeue(matchKey(event))
        const detail = describeToolResult(event.toolName, event.ok, event.result)
        const artifacts = toolArtifacts(event.toolName, event.ok, event.result)
        const patches: Patch[] = []
        let model = m
        if (entry !== undefined) {
          const t = patchToolBlock(model, entry.key, {
            state: event.ok ? "ok" : "error",
            ...(detail !== undefined ? { detail } : {}),
            ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
            ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
          })
          model = t.model
          if (t.patch !== undefined) patches.push(t.patch)
        }
        // Event-derived workspace cards: files opened, diffs applied, sources.
        const item = deriveWorkspaceItem(
          event.toolName,
          entry?.key ?? matchKey(event),
          entry?.args ?? {},
          event.ok,
          event.result,
        )
        if (item !== undefined && item.kind !== "plan") {
          const w = putWorkspaceItem(model, item)
          model = w.model
          patches.push(w.patch)
          // Link the pill to its card (click-to-open the refs drawer). The
          // pill patch above renders from the FINAL model, so the ref lands.
          const domId = workspaceDomId(item)
          if (domId !== undefined && entry !== undefined) {
            model = { ...model, refIds: { ...model.refIds, [entry.key]: domId } }
          }
        }
        // The finished tool clears the strip's label (the phase fold keeps
        // "thinking" while the model reasons toward its next step).
        return withPhase(withActivityLabel({ model, patches }, undefined))
      }

      case "subagent_start": {
        if (event.nodeId === undefined) return withPhase(same(m))
        const nodeId = event.nodeId
        const r = chipUpdate(m, nodeId, () => ({
          nodeId,
          name: event.name,
          status: "running",
          toolUses: 0,
          tokens: 0,
        }))
        return withPhase({ model: r.model, patches: [...r.patches, { kind: "header" }] })
      }

      case "subagent_end": {
        if (event.nodeId === undefined) return withPhase(same(m))
        const nodeId = event.nodeId
        const outcome = event.outcome ?? (event.ok ? "ok" : "error")
        const r = chipUpdate(m, nodeId, (chip) => ({
          nodeId,
          name: event.name,
          status: event.ok ? "ok" : "error",
          toolUses: chip?.toolUses ?? 0,
          tokens: chip?.tokens ?? 0,
          ...(event.summary.trim().length > 0 ? { summary: event.summary } : {}),
        }))
        const line = info(
          r.model,
          fleetCompletionLine(event.name, outcome, event.summary, event.reason),
        )
        return withPhase({
          model: line.model,
          patches: [...r.patches, ...line.patches, { kind: "header" }],
        })
      }

      case "agent_health": {
        // The ROOT's own health stamps (wait_for_agents parks under the
        // conversation id) are not a sub-agent — never mint a chip; they feed
        // the activity strip instead ("waiting-on-agents", "retrying"…).
        if (event.nodeId === rootKey) {
          return withPhase(
            withActivityLabel(
              same(m),
              event.detail !== undefined ? `${event.state}: ${event.detail}` : event.state,
            ),
          )
        }
        return withPhase(
          chipUpdate(m, event.nodeId, (chip) => ({
            nodeId: event.nodeId,
            name: chip?.name ?? "agent",
            status: chip?.status ?? "running",
            toolUses: chip?.toolUses ?? 0,
            tokens: event.tokens ?? chip?.tokens ?? 0,
            currentTool: event.detail !== undefined ? `${event.state}: ${event.detail}` : event.state,
            ...(chip?.summary !== undefined ? { summary: chip.summary } : {}),
          })),
        )
      }

      case "gate": {
        const files = event.filesChanged.length > 0 ? ` · ${event.filesChanged.length} file(s)` : ""
        const text =
          event.verdict === "sound"
            ? `✓ verifier: deliverable SOUND (attempt ${event.attempt})${files}`
            : event.verdict === "unavailable"
              ? `⚠ verifier UNAVAILABLE — work NOT verified: ${event.reasons.join("; ")}`
              : event.advisory === true
                ? `⚑ verifier notes (delivered): ${event.reasons.join("; ")}`
                : `✗ verifier: ${event.verdict.toUpperCase().replace("_", " ")} (attempt ${event.attempt})${files} — ${event.reasons.join("; ")}`
        return withPhase(info(m, text))
      }

      case "learned":
        return event.lessons.length > 0
          ? withPhase(
              info(
                m,
                `learned ${event.lessons.length} reusable ${event.lessons.length === 1 ? "lesson" : "lessons"}: ${event.lessons.map((l) => l.name).join(", ")}`,
              ),
            )
          : withPhase(same(m))

      case "agent_end": {
        const outcome = event.outcome ?? "ok"
        const r =
          outcome === "killed"
            ? info(m, "turn interrupted")
            : outcome === "partial"
              ? info(m, `◐ the turn stopped early (${event.reason ?? "partial"}) — the answer above is incomplete`)
              : event.finalText.trim().length === 0
                ? info(m, "(agent stopped without a final answer)")
                : same(m)
        return withPhase({ model: r.model, patches: [...r.patches, { kind: "header" }] })
      }

      case "error": {
        const { model, patch } = putBlock(m, { kind: "error", text: event.message })
        return withPhase({ model, patches: [patch] })
      }

      case "llm_retry": {
        const secs = Math.max(1, Math.round(event.delayMs / 1000))
        const text =
          event.elapsedMs !== undefined
            ? `provider ${event.reason} — down ${Math.max(1, Math.round(event.elapsedMs / 60_000))}m, retrying in ${secs}s`
            : `provider ${event.reason} — retrying in ${secs}s (attempt ${event.attempt}/${event.maxAttempts})`
        if (event.nodeId !== undefined) {
          const nodeId = event.nodeId
          return withPhase(
            chipUpdate(m, nodeId, (chip) => ({
              nodeId,
              name: chip?.name ?? "agent",
              status: chip?.status ?? "running",
              toolUses: chip?.toolUses ?? 0,
              tokens: chip?.tokens ?? 0,
              currentTool: text,
              ...(chip?.summary !== undefined ? { summary: chip.summary } : {}),
            })),
          )
        }
        // Root retry: an info line in the rail + the live strip label.
        return withPhase(withActivityLabel(info(m, text), text))
      }

      case "bg_output": {
        const line = event.chunk
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0)
          .pop()
        return line !== undefined
          ? withPhase(info(m, `bg ${event.processId.slice(0, 8)} ${event.stream}: ${line.slice(0, 200)}`))
          : withPhase(same(m))
      }

      case "approval_needed": {
        const model: WebModel = {
          ...m,
          approval: {
            tool: event.tool,
            summary: event.summary,
            cwd: event.cwd,
            ruleKey: event.ruleKey,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
            ...(event.folder !== undefined ? { folder: event.folder } : {}),
          },
        }
        return withPhase({ model, patches: [{ kind: "approval" }] })
      }

      case "approval_resolved":
        return withPhase({ model: { ...m, approval: undefined }, patches: [{ kind: "approval" }] })

      case "needs_human":
        return withPhase(info(m, `⚠ needs you: ${event.summary} — ${event.reason}`))

      case "board_note":
        return event.to !== undefined && event.to === rootKey
          ? withPhase(info(m, `✉ ${event.from}: ${event.note.length > 200 ? `${event.note.slice(0, 199)}…` : event.note}`))
          : withPhase(same(m))

      case "ui_render": {
        const { model, patch } = putCanvas(m, {
          id: event.id,
          ...(event.title !== undefined ? { title: event.title } : {}),
          html: event.html,
          mode: event.mode,
          ...(event.active !== undefined ? { active: event.active } : {}),
        })
        return withPhase({ model, patches: [patch] })
      }

      case "skill_load":
      case "helper_usage":
        return withPhase(same(m))
    }
  }
}
