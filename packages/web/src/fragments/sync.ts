import { html, render } from "../html.js"
import { ID_CANVAS, ID_RAIL, ID_WS_ITEMS } from "../ids.js"
import type { ShellView } from "../views.js"
import { renderActivity } from "../components/activity.js"
import { renderApproval } from "../components/approval.js"
import { renderHeader } from "../components/header.js"
import { renderPlan } from "../components/plan.js"
import { renderQueue } from "../components/queue.js"
import { renderReply } from "../components/reply.js"
import { renderTabs } from "../components/tabs.js"
import { pagesContents, railContents, resolveActivePage, workspaceContents } from "./regions.js"

/**
 * The reconnect snapshot: ONE WS message that rebuilds every region —
 * `innerHTML` swaps for the three growing containers, `true` swaps for the
 * singletons (header · tabs · plan · activity · reply · queue · approval).
 * Drawer shells, the stage wrapper, the hero, and the dock are STATIC (shell
 * only) so client-side open/closed/dismissed state survives a resync. Keyed
 * ids make replaying this over live state idempotent; every socket open
 * (first or re-) receives it.
 */
export const renderFullSync = (view: ShellView): string => {
  const active = resolveActivePage(view.canvas, view.activePage)
  const parts = [
    html`<ol id="${ID_RAIL}" hx-swap-oob="innerHTML">${railContents(view.blocks)}</ol>`,
    html`<div id="${ID_WS_ITEMS}" hx-swap-oob="innerHTML">${workspaceContents(view.workspace)}</div>`,
    html`<div id="${ID_CANVAS}" hx-swap-oob="innerHTML">${pagesContents(view.canvas, active)}</div>`,
    renderHeader(view.header, "true"),
    renderTabs(view.canvas, active, "true"),
    renderPlan(view.plan, "true"),
    renderActivity(view.activity, "true"),
    renderReply(view.reply, "true"),
    renderQueue(view.queue, "true"),
    renderApproval(view.approval, "true"),
  ]
  return parts.map(render).join("\n")
}
