import type { ConversationId } from "@efferent/core"
import type { StatusState } from "../presentation/statusBar.js"
import type { SidePaneState } from "../presentation/sidePane.js"
import { createConversationSlice, type ConversationSlice } from "./conversation.js"
import { createSideSlice, type SideSlice } from "./side.js"
import { createSessionSlice, type SessionSlice } from "./session.js"
import { createUiSlice, type UiSlice } from "./ui.js"
import { createOverlaySlice, type OverlaySlice } from "./overlay.js"

// Re-export the foundational types so consumers can `import { … } from
// "…/state/store.js"` without chasing each slice file.
export type { AppServices, TuiContext } from "../TuiContext.js"
export type { FocusPane, UiMode } from "./ui.js"
export type { RunHandle, OAuthSession, BrowseEntry } from "./session.js"
export type { Overlay, SelectPurpose, PromptPurpose, EffortSettingKey } from "./overlay.js"
export type { SearchState, ConvScroller } from "./conversation.js"

/**
 * The reactive UI state, composed from four concern-scoped slices
 * (conversation · side · session · ui). The shape stays flat so the view tree
 * reads `store.blocks()` / `store.sidePane()` / `store.focus()` directly — the
 * slicing is an internal organising seam, not an API the components see.
 */
export interface TuiStore
  extends ConversationSlice,
    SideSlice,
    SessionSlice,
    UiSlice,
    OverlaySlice {}

export interface TuiStoreInit {
  readonly status: StatusState
  readonly conversationId: ConversationId
  readonly footer: string
  readonly sidePane: SidePaneState
}

export const createTuiStore = (init: TuiStoreInit): TuiStore => ({
  ...createConversationSlice(),
  ...createSideSlice(init.sidePane),
  ...createSessionSlice({
    status: init.status,
    conversationId: init.conversationId,
    footer: init.footer,
  }),
  ...createUiSlice(),
  ...createOverlaySlice(),
})
