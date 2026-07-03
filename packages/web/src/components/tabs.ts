import { html, join, type Html } from "../html.js"
import { domIdForKey, ID_TABS } from "../ids.js"
import type { CanvasItemView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * The page tab bar — a singleton (`#ef-tabs`) upserted alongside every page
 * fragment so it can never drift from the pages region. One tab per page:
 * `data-page` is the page's DOM id (click activation), `data-page-id` the raw
 * render_ui id (the composer's `[viewing:…]` context field). With no pages the
 * nav renders empty (CSS collapses it). app.js re-applies the `--active` class
 * after upserts (client tab choice survives server re-renders).
 */
export const renderTabs = (
  pages: ReadonlyArray<CanvasItemView>,
  activePage?: string,
  oob?: string,
): Html =>
  html`<nav id="${ID_TABS}" class="ef-tabs${pages.length === 0 ? " ef-tabs--empty" : ""}"${oobAttr(oob)}>${join(
    pages.map(
      (p) =>
        html`<button type="button" class="ef-tab${p.id === activePage ? " ef-tab--active" : ""}" data-page="${domIdForKey("ui", p.id)}" data-page-id="${p.id}">${p.title ?? p.id}</button>`,
    ),
  )}</nav>`
