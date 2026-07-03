import { html, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import { sanitizeHtml } from "../sanitize.js"
import type { CanvasItemView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * A generative-UI PAGE: agent-authored HTML, SANITIZED HERE (the only place
 * model HTML crosses into markup), rendered full-bleed — no card chrome —
 * keyed by the agent-chosen id. A second render_ui with the same id updates
 * the page in place; only the `--active` page is visible (tab switching).
 * `focus` stamps a transient `data-focus` marker on LIVE fragments — the
 * client adopts that page as its viewed tab, then strips the marker (a
 * resync/full-render never carries it, so reconnects don't yank the user).
 * A sanitizer strip shows as a small corner chip, never a content block.
 */
export const renderPageItem = (
  view: CanvasItemView,
  active: boolean,
  oob?: string,
  focus = false,
): Html => {
  const id = domIdForKey("ui", view.id)
  const { html: body, dropped } = sanitizeHtml(view.html)
  return html`<section id="${id}" class="ef-page${active ? " ef-page--active" : ""}" data-page-id="${view.id}"${focus ? html` data-focus="1"` : false}${oobAttr(oob)}>
    ${dropped.length > 0 && html`<div class="ef-page-dropped" title="${dropped.join(", ")}">sanitized: ${dropped.length} removed</div>`}
    <div class="ef-page-body">${body}</div>
  </section>`
}
