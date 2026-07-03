import { html, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import type { DiffCardView } from "../views.js"
import { renderDiff } from "./diffView.js"
import { oobAttr } from "./oob.js"

/** An `edit_file`/`write_file` result rendered as a workspace diff card. */
export const renderDiffCard = (view: DiffCardView, oob?: string): Html => {
  const id = domIdForKey("ws-item", view.id)
  return html`<div id="${id}" class="ef-wcard ef-diffcard"${oobAttr(oob)}>
    <div class="ef-wcard-title" title="${view.path}">${view.path}
      <span class="ef-diffstat"><span class="ef-diffstat-add">+${view.added}</span> <span class="ef-diffstat-del">-${view.removed}</span></span>
    </div>
    ${renderDiff(view.diff)}
  </div>`
}
