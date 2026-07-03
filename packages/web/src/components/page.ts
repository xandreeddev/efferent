import { html, join, type Html } from "../html.js"
import { domIdForKey, pageBodyId, regionId } from "../ids.js"
import { sanitizeHtml } from "../sanitize.js"
import type { CanvasItemView, CanvasRegionView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * One COMPONENT (region) of a page: agent-authored HTML, SANITIZED HERE (the
 * only place model HTML crosses into markup), keyed by (page id, region) so an
 * update swaps ONLY this node — the rest of the page (and its rendered
 * diagrams) stay put. The whole-page component is the `_main` region; its
 * wrapper is `display:contents` so a plain page looks identical to a legacy
 * one. A sanitizer strip shows as a small corner chip, never a content block.
 */
export const renderRegion = (pageId: string, region: CanvasRegionView, oob?: string): Html => {
  const id = regionId(pageId, region.region)
  const { html: body, dropped } = sanitizeHtml(region.html)
  return html`<div id="${id}" class="ef-region" data-region="${region.region}"${oobAttr(oob)}>${
    dropped.length > 0 &&
    html`<div class="ef-page-dropped" title="${dropped.join(", ")}">sanitized: ${dropped.length} removed</div>`
  }${body}</div>`
}

/**
 * A generative-UI PAGE: a full-bleed section (no card chrome) keyed by the
 * agent-chosen id, holding an ordered set of components in its keyed body. A
 * `render_ui` with a `region` swaps just that component (see `renderRegion`);
 * one with no region rebuilds the whole section. Only the `--active` page is
 * visible (tab switching). `focus` stamps a transient `data-focus` marker on a
 * LIVE whole-section fragment — the client adopts that page as its viewed tab,
 * then strips it (a resync/full-render never carries it, so reconnects don't
 * yank the user); region-only updates carry focus on the tab bar instead.
 */
export const renderPageItem = (
  view: CanvasItemView,
  active: boolean,
  oob?: string,
  focus = false,
): Html => {
  const id = domIdForKey("ui", view.id)
  const bodyId = pageBodyId(view.id)
  return html`<section id="${id}" class="ef-page${active ? " ef-page--active" : ""}" data-page-id="${view.id}"${focus ? html` data-focus="1"` : false}${oobAttr(oob)}>
    <div id="${bodyId}" class="ef-page-body">${join(view.regions.map((r) => renderRegion(view.id, r)))}</div>
  </section>`
}
