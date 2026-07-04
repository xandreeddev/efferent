import { html, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import type { ChatBlockView } from "../views.js"
import { renderDiff } from "./diffView.js"
import { oobAttr } from "./oob.js"

type ToolPillView = Extract<ChatBlockView, { kind: "tool" }>

/** A tool-call pill: `● label` + optional detail, diff or clipped output.
 *  A pill with a workspace card carries `data-ref` — clicking it opens the
 *  references drawer scrolled to that card (app.js). */
export const renderToolPill = (view: ToolPillView, oob?: string): Html => {
  const id = domIdForKey("blk", view.id)
  const ref = view.refId !== undefined ? html` data-ref="${view.refId}"` : false
  return html`<li id="${id}" class="ef-pill ef-pill--${view.state}${view.refId !== undefined ? " ef-pill--linked" : ""}"${ref}${oobAttr(oob)}>
    <span class="ef-pill-head"><span class="ef-pill-dot">●</span> <span class="ef-pill-label">${view.label}</span></span>
    ${view.detail !== undefined && html`<div class="ef-pill-detail">⎿ ${view.detail}</div>`}
    ${view.diff !== undefined && html`<div class="ef-artifact">${renderDiff(view.diff)}</div>`}
    ${view.output !== undefined && html`<pre class="ef-output">${view.output}</pre>`}
  </li>`
}
