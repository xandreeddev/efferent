import { html, type Html } from "../html.js"
import { ID_APPROVAL } from "../ids.js"
import { ACTION_APPROVE_PATH } from "../protocol/contract.js"
import type { ApprovalView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * The bash-approval sheet — a singleton (`#ef-approval`). Each decision button
 * posts its OWN `decision` to /action/approve via `hx-post` + `hx-vals` — NOT
 * a shared `<form>` submit. That deliberately avoids depending on htmx
 * including the clicked submit button's value (browser/version-sensitive — the
 * "accept button doesn't work" report): every button is a self-contained
 * request that always carries its decision. The deny button pulls in the
 * reason field via `hx-include`. Buttons are `type="button"` so a stray native
 * form submit can never fire.
 */
export const renderApproval = (view: ApprovalView | undefined, oob?: string): Html => {
  if (view === undefined) return html`<div id="${ID_APPROVAL}" class="ef-approval ef-approval--empty"${oobAttr(oob)}></div>`
  const decide = (scope: string) =>
    html`hx-post="${ACTION_APPROVE_PATH}" hx-swap="none" hx-vals='{"decision":"${scope}"}'`
  return html`<div id="${ID_APPROVAL}" class="ef-approval"${oobAttr(oob)}>
    <div class="ef-approval-head">approval needed — ${view.tool}</div>
    <div class="ef-approval-summary"><code class="ef-code">${view.summary}</code></div>
    ${view.reason !== undefined && html`<div class="ef-approval-reason">${view.reason}</div>`}
    <div class="ef-muted">${view.cwd}</div>
    <div class="ef-approval-actions">
      <input type="text" id="ef-approval-reason" class="ef-input ef-approval-reason-input" name="reason" placeholder="reason (for deny)" />
      <button type="button" class="ef-btn ef-btn--primary" ${decide("once")}>allow once</button>
      <button type="button" class="ef-btn" ${decide("session")}>allow for session</button>
      <button type="button" class="ef-btn" ${decide("project")}>always in project</button>
      <button type="button" class="ef-btn ef-btn--ghost" hx-post="${ACTION_APPROVE_PATH}" hx-swap="none" hx-vals='{"decision":"deny"}' hx-include="#ef-approval-reason">deny</button>
    </div>
  </div>`
}
