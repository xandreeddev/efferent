import { render } from "../html.js"
import type {
  ActivityView,
  ApprovalView,
  CanvasItemView,
  HeaderView,
  QueueView,
  ReplyView,
} from "../views.js"
import { renderActivity } from "../components/activity.js"
import { renderApproval } from "../components/approval.js"
import { renderHeader } from "../components/header.js"
import { renderQueue } from "../components/queue.js"
import { renderReply } from "../components/reply.js"
import { renderTabs } from "../components/tabs.js"

/** Singleton upserts — always outerHTML-replace by their fixed region id. */
export const upsertHeader = (view: HeaderView): string => render(renderHeader(view, "true"))

export const upsertQueue = (view: QueueView): string => render(renderQueue(view, "true"))

/** `undefined` clears the sheet (renders the empty singleton). */
export const upsertApproval = (view: ApprovalView | undefined): string =>
  render(renderApproval(view, "true"))

/** The tab bar — sent in the SAME WS message as every page/region fragment.
 *  `focusPageId` set ⇒ stamp the transient `data-focus` (the focus channel for
 *  region-only updates; see `renderTabs`). */
export const upsertTabs = (
  pages: ReadonlyArray<CanvasItemView>,
  activePage?: string,
  focusPageId?: string,
): string => render(renderTabs(pages, activePage, "true", focusPageId))

/** The activity strip (idle renders the hidden empty singleton). */
export const upsertActivity = (view: ActivityView): string => render(renderActivity(view, "true"))

/** The latest-reply bubble (`undefined` clears it). */
export const upsertReply = (view: ReplyView | undefined): string => render(renderReply(view, "true"))
