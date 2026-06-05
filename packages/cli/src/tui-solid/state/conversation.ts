import { createSignal, type Accessor } from "solid-js"
import type { ScrollbackBlock } from "../presentation/conversation.js"

/**
 * A live search over the conversation rail: the query, the ordered ids of the
 * top-level items that matched (resolved via `conversationItemId`), and the
 * current position. `undefined` ⇒ no active search.
 */
export interface SearchState {
  readonly query: string
  readonly matchIds: ReadonlyArray<string>
  readonly index: number
}

/**
 * An imperative handle onto the conversation `<scrollbox>`, registered by the
 * pane component. Keeping it behind this interface (not the raw OpenTUI
 * renderable) means `keys/` and `actions/` drive scrolling without importing
 * `@opentui/core` — the seam stays clean. The holder is a mutable, non-reactive
 * slot (an imperative renderer handle is never something the view renders).
 */
export interface ConvScroller {
  /** Scroll by a signed number of lines (negative = up). */
  scrollBy: (lines: number) => void
  scrollToTop: () => void
  scrollToBottom: () => void
  /** Scroll a rendered top-level item (by its `conversationItemId`) into view. */
  scrollIntoView: (id: string) => void
  /** Visible viewport height in rows — drives half/page steps. */
  viewportRows: () => number
}

/**
 * Conversation slice: the append-only scrollback block list + the fold set, plus
 * the live search and the (non-reactive) scroller handle. Tools update in place
 * by id (never spliced) so the structure model's stable ids hold; `setBlocks`
 * replaces the whole list (resume / build a new session).
 */
export interface ConversationSlice {
  readonly blocks: Accessor<ScrollbackBlock[]>
  readonly collapsed: Accessor<Set<string>>
  readonly setCollapsed: (next: Set<string>) => void
  /** The conversation fold cursor: index into `buildConversationRows`. */
  readonly convCursor: Accessor<number>
  readonly setConvCursor: (next: number) => void
  /** Append a conversation block (append-only; tools update in place by id). */
  readonly pushBlock: (block: ScrollbackBlock) => void
  /** Patch the most recent tool block with the given id. */
  readonly updateTool: (
    id: string,
    patch: Partial<Extract<ScrollbackBlock, { kind: "tool" }>>,
  ) => void
  /** Replace the entire block list — used by resume / build-a-new-session. */
  readonly setBlocks: (next: ScrollbackBlock[]) => void
  /** Clear the conversation (`:clear`). */
  readonly clear: () => void
  /** The active conversation search, or `undefined`. */
  readonly search: Accessor<SearchState | undefined>
  readonly setSearch: (next: SearchState | undefined) => void
  /** Non-reactive scroller handle, registered by the conversation pane. */
  readonly convScroller: { current?: ConvScroller }
}

export const createConversationSlice = (): ConversationSlice => {
  const [blocks, setBlocksSig] = createSignal<ScrollbackBlock[]>([])
  const [collapsed, setCollapsedSig] = createSignal<Set<string>>(new Set())
  const [convCursor, setConvCursorSig] = createSignal(0)
  const [search, setSearchSig] = createSignal<SearchState | undefined>(undefined)
  const convScroller: { current?: ConvScroller } = {}

  return {
    blocks,
    collapsed,
    setCollapsed: (next) => setCollapsedSig(next),
    convCursor,
    setConvCursor: (next) => setConvCursorSig(next),
    pushBlock: (block) => setBlocksSig((bs) => [...bs, block]),
    updateTool: (id, patch) =>
      setBlocksSig((bs) =>
        bs.map((b) => (b.kind === "tool" && b.id === id ? { ...b, ...patch } : b)),
      ),
    setBlocks: (next) => setBlocksSig(next),
    clear: () => {
      setBlocksSig([])
      setSearchSig(undefined)
    },
    search,
    setSearch: (next) => setSearchSig(next),
    convScroller,
  }
}
