import { html, render, type Html } from "../html.js"
import { ID_CANVAS, ID_WS_ITEMS, pageBodyId, regionId } from "../ids.js"
import type { CanvasItemView, CanvasRegionView, PlanView, WorkspaceItemView } from "../views.js"
import { renderDiffCard } from "../components/diffCard.js"
import { renderFileRef } from "../components/fileRef.js"
import { renderPageItem, renderRegion } from "../components/page.js"
import { renderPlan } from "../components/plan.js"
import { renderSourceCard } from "../components/sourceCard.js"
import { oobAttr } from "../components/oob.js"
import { wrapAppend } from "./blocks.js"

/** Render a workspace stack item (plan routes to its own slot — see below). */
export const renderWorkspaceItem = (item: WorkspaceItemView, oob?: string): Html => {
  switch (item.kind) {
    case "plan":
      return renderPlan(item.plan, oob)
    case "file":
      return renderFileRef(item.file, oob)
    case "diff":
      return renderDiffCard(item.diff, oob)
    case "source":
      return renderSourceCard(item.source, oob)
  }
}

/**
 * A NEW workspace card — appended to the card stack (inside a throwaway
 * wrapper: htmx's selector-style OOB inserts CHILDREN — see blocks.ts).
 * A `plan` item is a singleton upsert regardless (its slot always exists).
 */
export const appendWorkspaceItem = (item: WorkspaceItemView): string =>
  item.kind === "plan" ? upsertWorkspaceItem(item) : wrapAppend(ID_WS_ITEMS, renderWorkspaceItem(item))

/** An UPDATED workspace card — outerHTML-replaces by id. */
export const upsertWorkspaceItem = (item: WorkspaceItemView): string =>
  render(renderWorkspaceItem(item, "true"))

/** The plan singleton, upserted into its always-present slot. */
export const upsertPlan = (plan: PlanView): string => render(renderPlan(plan, "true"))

/** A NEW page — appended to the pages region (wrapped, as above). `active`
 *  marks it focused; `focus` additionally tells the client to ADOPT it as the
 *  viewed tab (a transient data-focus marker — live fragments only). */
export const appendPageItem = (item: CanvasItemView, active: boolean, focus = false): string =>
  wrapAppend(ID_CANVAS, renderPageItem(item, active, undefined, focus))

/** A whole page REBUILT (a no-region replace, or a full-section resync) —
 *  outerHTML-replaces the section, dropping any stale component divs. */
export const upsertPageItem = (item: CanvasItemView, active: boolean, focus = false): string =>
  render(renderPageItem(item, active, "true", focus))

/** A NEW component — appended into its page's keyed body (wrapped, as above,
 *  so the keyed `<div id="uir-…">` keeps its id). */
export const appendRegionItem = (pageId: string, region: CanvasRegionView): string =>
  wrapAppend(pageBodyId(pageId), renderRegion(pageId, region))

/** An UPDATED component — outerHTML-replaces ONLY that region div; sibling
 *  components (and their rendered diagrams / scroll / form state) are untouched. */
export const upsertRegionItem = (pageId: string, region: CanvasRegionView): string =>
  render(renderRegion(pageId, region, "true"))

/** A DELETED component — an OOB `delete` swap removes just that region div. */
export const removeRegionItem = (pageId: string, region: string): string =>
  render(html`<div id="${regionId(pageId, region)}"${oobAttr("delete")}></div>`)
