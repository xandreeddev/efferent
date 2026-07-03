/**
 * Patch + WebModel → htmx OOB fragment strings, and the full-page/full-sync
 * views — the adapter between the driver's model and `@xandreed/web`'s
 * structural props. Rendering decisions live in the web package; this file
 * only maps shapes.
 */
import {
  appendChatBlock,
  appendPageItem,
  appendWorkspaceItem,
  renderFullSync,
  renderShell,
  upsertActivity,
  upsertApproval,
  upsertChatBlock,
  upsertHeader,
  upsertPageItem,
  upsertPlan,
  upsertQueue,
  upsertReply,
  upsertTabs,
  upsertWorkspaceItem,
  type ActivityView,
  type ChatBlockView,
  type HeaderView,
  type PlanView,
  type ReplyView,
  type ShellView,
} from "@xandreed/web"
import type { PlanStep } from "@xandreed/sdk-core"
import type { WebBlock, WebModel, Patch } from "./model.js"

/** Static page identity the pump carries alongside the model. */
export interface WebMeta {
  readonly sessionTitle: string
  readonly workspacePath: string
  readonly model: string
  readonly wsUrl: string
}

const toChatBlock = (wb: WebBlock, refIds: WebModel["refIds"]): ChatBlockView => {
  const b = wb.block
  switch (b.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return { kind: "message", key: wb.key, role: b.kind, markdown: b.text }
    case "tool": {
      const refId = refIds[b.id]
      return {
        kind: "tool",
        id: b.id,
        label: b.toolName,
        state: b.state,
        ...(b.detail !== undefined ? { detail: b.detail } : {}),
        ...(b.diff !== undefined ? { diff: b.diff } : {}),
        ...(b.output !== undefined ? { output: b.output } : {}),
        ...(refId !== undefined ? { refId } : {}),
      }
    }
    case "agents":
      return { kind: "agents", id: b.id, agents: b.agents }
    case "info":
    case "error":
    case "checkpoint":
      return {
        kind: "line",
        key: wb.key,
        tone: b.kind === "checkpoint" ? "checkpoint" : b.kind,
        text: b.text,
      }
  }
}

const toPlanView = (steps: ReadonlyArray<PlanStep>): PlanView => ({
  steps: steps.map((s) => ({
    text: s.step,
    status: s.status === "pending" ? "todo" : s.status,
  })),
})

const toHeader = (m: WebModel, meta: WebMeta): HeaderView => ({
  sessionTitle: meta.sessionTitle,
  workspace: meta.workspacePath,
  model: meta.model,
  status: m.phase.phase === "idle" ? "idle" : "running",
  agentsRunning: m.agents.filter((a) => a.status === "running").length,
})

const toActivity = (m: WebModel): ActivityView => ({
  status: m.phase.phase,
  ...(m.activity.label !== undefined ? { label: m.activity.label } : {}),
  ...(m.activitySince !== undefined ? { startedAt: m.activitySince } : {}),
  agentsRunning: m.agents.filter((a) => a.status === "running").length,
})

/** The latest assistant message — the dock's reply bubble. */
const toReply = (m: WebModel): ReplyView | undefined => {
  for (let i = m.blocks.length - 1; i >= 0; i--) {
    const wb = m.blocks[i]
    if (wb !== undefined && wb.block.kind === "assistant") {
      return { key: wb.key, markdown: wb.block.text }
    }
  }
  return undefined
}

/** One patch → one OOB fragment batch line (empty when the target vanished). */
export const renderPatch = (m: WebModel, meta: WebMeta, p: Patch): string => {
  switch (p.kind) {
    case "block": {
      const wb = m.blocks.find((b) => b.key === p.key)
      if (wb === undefined) return ""
      const view = toChatBlock(wb, m.refIds)
      const fragment = p.isNew ? appendChatBlock(view) : upsertChatBlock(view)
      // A new/updated assistant message also refreshes the reply bubble.
      if (wb.block.kind === "assistant") {
        const reply = toReply(m)
        if (reply !== undefined && reply.key === wb.key) {
          return `${fragment}\n${upsertReply(reply)}`
        }
      }
      return fragment
    }
    case "plan":
      return upsertPlan(toPlanView(m.plan))
    case "workspace": {
      const item = m.workspace[p.index]
      if (item === undefined) return ""
      return p.isNew ? appendWorkspaceItem(item) : upsertWorkspaceItem(item)
    }
    case "canvas": {
      const item = m.canvas.find((c) => c.id === p.id)
      if (item === undefined) return ""
      const active = m.activePage === p.id
      const fragment = p.isNew
        ? appendPageItem(item, active, p.focus)
        : upsertPageItem(item, active, p.focus)
      // The tab bar rides in the SAME message so it can never drift.
      return `${fragment}\n${upsertTabs(m.canvas, m.activePage)}`
    }
    case "approval":
      return upsertApproval(m.approval)
    case "queue":
      return upsertQueue({ items: m.queue })
    case "header":
      return upsertHeader(toHeader(m, meta))
    case "activity":
      return upsertActivity(toActivity(m))
  }
}

export const buildShellView = (m: WebModel, meta: WebMeta): ShellView => {
  const reply = toReply(m)
  return {
    header: toHeader(m, meta),
    blocks: m.blocks.map((b) => toChatBlock(b, m.refIds)),
    workspace: m.workspace,
    plan: toPlanView(m.plan),
    canvas: m.canvas,
    ...(m.activePage !== undefined ? { activePage: m.activePage } : {}),
    activity: toActivity(m),
    ...(reply !== undefined ? { reply } : {}),
    queue: { items: m.queue },
    ...(m.approval !== undefined ? { approval: m.approval } : {}),
    wsUrl: meta.wsUrl,
  }
}

/** The full document (GET /). */
export const renderPage = (m: WebModel, meta: WebMeta): string =>
  renderShell(buildShellView(m, meta))

/** The reconnect snapshot batch (every socket open). */
export const renderSync = (m: WebModel, meta: WebMeta): string =>
  renderFullSync(buildShellView(m, meta))
