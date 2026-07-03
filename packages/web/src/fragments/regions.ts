import { join, type Html } from "../html.js"
import type { CanvasItemView, ChatBlockView, WorkspaceItemView } from "../views.js"
import { renderPageItem } from "../components/page.js"
import { renderChatBlock } from "./blocks.js"
import { renderWorkspaceItem } from "./workspace.js"

/**
 * Region contents — shared by the initial page shell and the full-sync
 * reconnect message so the two can never drift.
 */
export const railContents = (blocks: ReadonlyArray<ChatBlockView>): Html =>
  join(blocks.map((b) => renderChatBlock(b)))

export const workspaceContents = (items: ReadonlyArray<WorkspaceItemView>): Html =>
  join(items.filter((i) => i.kind !== "plan").map((i) => renderWorkspaceItem(i)))

/** Which page is focused: the explicit choice, else the LAST page (the one
 *  most recently created — matches the live focus default). */
export const resolveActivePage = (
  items: ReadonlyArray<CanvasItemView>,
  activePage?: string,
): string | undefined =>
  activePage !== undefined && items.some((i) => i.id === activePage)
    ? activePage
    : items[items.length - 1]?.id

/** All pages, exactly one carrying `--active` (shell + full-sync share this). */
export const pagesContents = (
  items: ReadonlyArray<CanvasItemView>,
  activePage?: string,
): Html => {
  const active = resolveActivePage(items, activePage)
  return join(items.map((i) => renderPageItem(i, i.id === active)))
}
