import { createSignal, type Accessor } from "solid-js"
import type { ScrollbackBlock, SearchHit } from "../presentation/conversation.js"
import type { NodePreview } from "../presentation/nodePreview.js"

/**
 * A live search over one pane. For the **conversation** the matches are
 * rendered row ids — turn heads, body items, checkpoints (`searchConversation`)
 * — with `hits` carrying each match's reveal info so jumping auto-expands the
 * fold hiding it; for the **side** pane they are the matching row indices (as
 * strings — the stack/context cursors are index-based, so the cursor jumps
 * straight to `Number(matchIds[index])`). The query + `[i/N]` position drive
 * the status line; `undefined` ⇒ no active search.
 */
export interface SearchState {
  readonly query: string
  /** Which pane this search ran against (drives n/N + how matchIds resolve). */
  readonly pane: "conversation" | "side"
  readonly matchIds: ReadonlyArray<string>
  readonly index: number
  /** Conversation-pane reveal info, aligned with `matchIds` (absent for side). */
  readonly hits?: ReadonlyArray<SearchHit>
}

/** A minimal handle onto the input `<textarea>`, registered by the pane, so a
 *  `/`-in-pane keystroke can seed the buffer + focus it without `keys/` importing
 *  OpenTUI (mirrors {@link ConvScroller}). */
export interface InputControl {
  /** Replace the buffer (and the mirrored store text) with `text`. */
  seed: (text: string) => void
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
  /** Replace the agent rows of the `agents` block with the given id. */
  readonly updateAgents: (
    id: string,
    agents: Extract<ScrollbackBlock, { kind: "agents" }>["agents"],
  ) => void
  /** Replace the entire block list — used by resume / build-a-new-session. */
  readonly setBlocks: (next: ScrollbackBlock[]) => void
  /** Which agent (context-node) is open in the RIGHT pane, if any. */
  readonly nodePreview: Accessor<NodePreview | undefined>
  readonly setNodePreview: (p: NodePreview | undefined) => void
  /**
   * The per-agent **live log** — every sub-agent's rail blocks, keyed by node id,
   * accumulated by the event pump as the agent works (NOT just while its pane is
   * open). The right pane (`AgentPane`) renders the current preview's log, so
   * swapping to any agent — running or finished — shows its full state, and a
   * running one keeps streaming. The durable record is still the context tree;
   * this is the live, in-memory view of "what each teammate is doing".
   */
  readonly nodeLog: (nodeId: string) => ReadonlyArray<ScrollbackBlock>
  /** Append a block to a node's live log. */
  readonly appendNodeLog: (nodeId: string, block: ScrollbackBlock) => void
  /** Patch a tool pill inside a node's live log by id. */
  readonly patchNodeLogTool: (
    nodeId: string,
    id: string,
    patch: Partial<Extract<ScrollbackBlock, { kind: "tool" }>>,
  ) => void
  /** Seed a node's log from persisted history — only when it has no live log yet
   *  (a finished/prior-session node the pump never streamed). Never clobbers a
   *  live log. */
  readonly seedNodeLog: (nodeId: string, blocks: ReadonlyArray<ScrollbackBlock>) => void
  /**
   * What the conversation pane currently shows: the preview overlay when one is
   * open, else the live blocks. Every conversation-pane *reader* (view, fold
   * cursor, search) goes through this; *writers* (pump, actions) keep targeting
   * the live `blocks`, so a running turn never clobbers an open preview.
   */
  readonly viewBlocks: () => ReadonlyArray<ScrollbackBlock>
  /** Clear the conversation (`:clear`). */
  readonly clear: () => void
  /** The active search (conversation or side), or `undefined`. */
  readonly search: Accessor<SearchState | undefined>
  readonly setSearch: (next: SearchState | undefined) => void
  /** Which pane a freshly-started `/` search targets (set by the `/`-in-pane key;
   *  a bare `/foo` typed in the input defaults to the conversation). */
  readonly searchPane: Accessor<"conversation" | "side">
  readonly setSearchPane: (pane: "conversation" | "side") => void
  /** Non-reactive scroller handle, registered by the conversation pane. */
  readonly convScroller: { current?: ConvScroller }
  /** Non-reactive input handle, registered by the input pane (`/`-in-pane seed). */
  readonly inputControl: { current?: InputControl }
}

export const createConversationSlice = (): ConversationSlice => {
  const [blocks, setBlocksSig] = createSignal<ScrollbackBlock[]>([])
  const [collapsed, setCollapsedSig] = createSignal<Set<string>>(new Set())
  const [convCursor, setConvCursorSig] = createSignal(0)
  const [search, setSearchSig] = createSignal<SearchState | undefined>(undefined)
  const [nodePreview, setNodePreviewSig] = createSignal<NodePreview | undefined>(undefined)
  const [nodeLogs, setNodeLogs] = createSignal<ReadonlyMap<string, ScrollbackBlock[]>>(new Map())
  const [searchPane, setSearchPaneSig] = createSignal<"conversation" | "side">("conversation")
  const convScroller: { current?: ConvScroller } = {}
  const inputControl: { current?: InputControl } = {}

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
    updateAgents: (id, agents) =>
      setBlocksSig((bs) =>
        bs.map((b) => (b.kind === "agents" && b.id === id ? { ...b, agents } : b)),
      ),
    setBlocks: (next) => setBlocksSig(next),
    nodePreview,
    setNodePreview: (p) => setNodePreviewSig(p),
    nodeLog: (nodeId) => nodeLogs().get(nodeId) ?? [],
    appendNodeLog: (nodeId, block) =>
      setNodeLogs((m) => {
        const next = new Map(m)
        next.set(nodeId, [...(m.get(nodeId) ?? []), block])
        return next
      }),
    patchNodeLogTool: (nodeId, id, patch) =>
      setNodeLogs((m) => {
        const cur = m.get(nodeId)
        if (cur === undefined) return m
        const next = new Map(m)
        next.set(
          nodeId,
          cur.map((b) => (b.kind === "tool" && b.id === id ? { ...b, ...patch } : b)),
        )
        return next
      }),
    seedNodeLog: (nodeId, blocks) =>
      setNodeLogs((m) => {
        if ((m.get(nodeId)?.length ?? 0) > 0) return m // never clobber a live log
        const next = new Map(m)
        next.set(nodeId, [...blocks])
        return next
      }),
    // The LEFT pane always shows the orchestrator (the lead conversation). A
    // selected agent no longer overlays it — it opens as the RIGHT pane
    // (`AgentPane`, reading `nodePreview().blocks` directly), so the two are
    // visible side by side. `viewBlocks` therefore feeds the left pane + its
    // cursor/search, which always operate on the lead.
    viewBlocks: () => blocks(),
    clear: () => {
      setBlocksSig([])
      setSearchSig(undefined)
      setNodePreviewSig(undefined)
      setNodeLogs(new Map())
    },
    search,
    setSearch: (next) => setSearchSig(next),
    searchPane,
    setSearchPane: (pane) => setSearchPaneSig(pane),
    convScroller,
    inputControl,
  }
}
