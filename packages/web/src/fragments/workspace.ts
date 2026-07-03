import { render, type Html } from "../html.js"
import { ID_CANVAS, ID_WS_ITEMS } from "../ids.js"
import type { CanvasItemView, PlanView, WorkspaceItemView } from "../views.js"
import { renderDiffCard } from "../components/diffCard.js"
import { renderFileRef } from "../components/fileRef.js"
import { renderPageItem } from "../components/page.js"
import { renderPlan } from "../components/plan.js"
import { renderSourceCard } from "../components/sourceCard.js"
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

/** An UPDATED page (same agent-chosen id) — replaced in place. */
export const upsertPageItem = (item: CanvasItemView, active: boolean, focus = false): string =>
  render(renderPageItem(item, active, "true", focus))
