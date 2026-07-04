import { html, join, type Html } from "../html.js"
import { ID_PLAN } from "../ids.js"
import type { PlanView } from "../views.js"
import { oobAttr } from "./oob.js"

const MARKS = { done: "✓", active: "●", todo: "○" } as const

/** The agent's working plan — a singleton slot (`#ef-plan`), always upserted. */
export const renderPlan = (view: PlanView, oob?: string): Html => {
  const items = view.steps.map(
    (s) => html`<div class="ef-plan-item ef-plan-item--${s.status}">
      <span class="ef-plan-mark">${MARKS[s.status]}</span> ${s.text}
    </div>`,
  )
  return html`<div id="${ID_PLAN}" class="ef-wcard ef-plan"${oobAttr(oob)}>${
    view.steps.length === 0 ? "" : html`<div class="ef-wcard-title">plan</div>${join(items)}`
  }</div>`
}
