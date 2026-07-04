/**
 * @xandreed/web — the public surface the cli driver imports. Pure strings in,
 * strings out: page shell, OOB fragment builders, the sanitizer, the design
 * tokens, the protocol constants + parsers, and the static asset manifest.
 */

// pages
export { renderShell } from "./pages/shell.js"

// fragments (per-event OOB builders — ready for socket.send)
export { appendChatBlock, upsertChatBlock, renderChatBlock } from "./fragments/blocks.js"
export {
  appendPageItem,
  appendRegionItem,
  appendWorkspaceItem,
  removeRegionItem,
  renderWorkspaceItem,
  upsertPageItem,
  upsertPlan,
  upsertRegionItem,
  upsertWorkspaceItem,
} from "./fragments/workspace.js"
export {
  upsertActivity,
  upsertApproval,
  upsertHeader,
  upsertQueue,
  upsertReply,
  upsertTabs,
} from "./fragments/singletons.js"
export { renderFullSync } from "./fragments/sync.js"
export { resolveActivePage } from "./fragments/regions.js"

// event → workspace-card derivation
export { deriveWorkspaceItem } from "./derive.js"

// sanitizer (canvas items sanitize internally; exported for driver-side reuse)
export { sanitizeHtml, SANITIZE_MAX_BYTES, type SanitizeResult } from "./sanitize.js"

// protocol
export {
  ACTION_APPROVE_PATH,
  ACTION_INTERRUPT_PATH,
  ACTION_PREFIX,
  ACTION_UI_PATH,
  ASSET_PREFIX,
  HEALTH_PATH,
  SEND_PATH,
  SHUTDOWN_PATH,
  UI_ID_FIELD,
  WS_PATH,
} from "./protocol/contract.js"
export {
  formatUiActionMessage,
  parseActionPayload,
  parseClientMessage,
  withViewingContext,
  type ClientMessage,
  type UiActionPayload,
} from "./protocol/messages.js"

// assets + agent-facing docs
export { assetHref, staticAssets, type StaticAsset } from "./assets/static.js"
export { RENDER_UI_KIT_DOC } from "./docs/uiKit.js"

// the whole-page sentinel region (shared by the fold + replay)
export { MAIN_REGION } from "./views.js"

// view prop types (the driver adapts its models onto these)
export type {
  ActivityView,
  AgentChipView,
  ApprovalView,
  CanvasItemView,
  CanvasRegionView,
  ChatBlockView,
  DiffCardView,
  FileRefView,
  HeaderView,
  PlanStepView,
  PlanView,
  QueueView,
  ReplyView,
  ShellView,
  SourceCardView,
  WorkspaceItemView,
} from "./views.js"

// low-level reuse
export { empty, escapeHtml, html, join, raw, render, type Html } from "./html.js"
export { renderMarkdown } from "./markdown.js"
export {
  domIdForKey,
  ID_ACTIVITY,
  ID_APP,
  ID_APPROVAL,
  ID_CANVAS,
  ID_CHAT,
  ID_CHAT_DRAWER,
  ID_COMPOSER,
  ID_CONN,
  ID_HEADER,
  ID_PLAN,
  ID_QUEUE,
  ID_RAIL,
  ID_REFS_COUNT,
  ID_REFS_DRAWER,
  ID_REPLY,
  ID_RESYNC_FORM,
  ID_STAGE,
  ID_STAGE_EMPTY,
  ID_TABS,
  ID_WS_ITEMS,
  type IdPrefix,
} from "./ids.js"
export { DEFAULT_THEME_NAME, webThemes, type WebTheme } from "./theme/themes.js"
export { makeWebTokens, type SyntaxTokens, type WebTokens } from "./theme/tokens.js"
export { flattenTokens, renderTokensCss } from "./theme/css.js"
