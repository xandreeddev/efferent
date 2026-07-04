import { html, type Html } from "../html.js"
import { ID_ACTIVITY } from "../ids.js"
import { ACTION_INTERRUPT_PATH } from "../protocol/contract.js"
import type { ActivityView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * The activity strip — the web's RunningLoader: a pulse dot, what the agent
 * is doing, a client-ticked elapsed timer (`data-started-at`), and a zero-JS
 * interrupt button (a chrome form posting /action/interrupt). Idle renders
 * the hidden empty singleton so upserts always find their target.
 */
export const renderActivity = (view: ActivityView, oob?: string): Html => {
  if (view.status === "idle") {
    return html`<div id="${ID_ACTIVITY}" class="ef-activity ef-activity--idle"${oobAttr(oob)}></div>`
  }
  const label =
    view.label ?? (view.status === "thinking" ? "thinking" : "running a tool")
  const agents =
    view.agentsRunning > 0
      ? html`<span class="ef-activity-agents">◆ ${view.agentsRunning}</span>`
      : false
  return html`<div id="${ID_ACTIVITY}" class="ef-activity"${view.startedAt !== undefined ? html` data-started-at="${String(view.startedAt)}"` : false}${oobAttr(oob)}>
    <span class="ef-activity-dot">●</span>
    <span class="ef-activity-label">${label}</span>
    <span class="ef-activity-elapsed"></span>
    ${agents}
    <form class="ef-activity-stop" hx-post="${ACTION_INTERRUPT_PATH}" hx-swap="none">
      <button class="ef-btn ef-btn--ghost" type="submit" title="interrupt the agent">stop</button>
    </form>
  </div>`
}
