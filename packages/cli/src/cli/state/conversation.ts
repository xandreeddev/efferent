import { createSignal, type Accessor } from "solid-js"
import { messageKey, type ScrollbackBlock, type SearchHit } from "../presentation/conversation.js"
import type { NodeHealthInfo } from "../presentation/agentState.js"
import type { NodePreview } from "../presentation/nodePreview.js"

/**
 * A block's stable cache identity, or `undefined` when it has none (transient
 * `info`/`error`/`checkpoint`, which always append). `tool`/`agents` key on
 * their own `id`; messages on the `key` the pump/projection stamped from their
 * absolute position.
 */
const identityOf = (b: ScrollbackBlock): string | undefined => {
  if (b.kind === "tool" || b.kind === "agents") return b.id
  if (b.kind === "user" || b.kind === "assistant" || b.kind === "reasoning") return b.key
  return undefined
}

/** Upsert a block into a list by {@link identityOf}: replace the existing entry
 *  with that identity in place (preserving order), else append. A keyless block
 *  always appends. The one operation that makes every rail writer idempotent. */
const upsertInto = (
  list: ReadonlyArray<ScrollbackBlock>,
  block: ScrollbackBlock,
): ScrollbackBlock[] => {
  const id = identityOf(block)
  if (id === undefined) return [...list, block]
  const at = list.findIndex((b) => identityOf(b) === id)
  if (at === -1) return [...list, block]
  const next = [...list]
  next[at] = block
  return next
}

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
  /**
   * Add a block to the rail, **keyed**: a block carrying a stable identity
   * (`tool`/`agents` `id`, or a message `key`) REPLACES the existing entry with
   * that identity in place; a keyless block (`info`/`error`/`checkpoint`) or a
   * new identity appends. This is the single guarantee that the same logical
   * message can't appear twice — a replayed event, or a DB re-projection landing
   * on top of a live block, reconciles to one entry instead of duplicating.
   */
  readonly pushBlock: (block: ScrollbackBlock) => void
  /**
   * Push an OPTIMISTIC user line (idle submit) keyed `opt:<n>` and register it
   * pending — shown instantly, before the daemon persists it. The matching
   * authoritative `user_message` event later reconciles onto it by
   * {@link resolveOptimisticUser} (FIFO), so the line never doubles and we never
   * resort to unsafe content-hash matching. Returns the optimistic key.
   */
  readonly pushOptimisticUser: (text: string) => string
  /**
   * Resolve an authoritative user message (from the `user_message` event) at its
   * absolute `position`: re-key the oldest pending optimistic line onto its
   * `m:p<position>` key (collapsing optimistic↔authoritative), or upsert a fresh
   * user block when none is pending (a queued message draining, or another
   * client's send).
   */
  readonly resolveOptimisticUser: (position: number, text: string) => void
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
  /** Replace the entire block list — a true document swap (resume / build /
   *  fork / boot / `:clear`). The incoming blocks carry keys, so events that
   *  arrive afterwards upsert onto them. */
  readonly setBlocks: (next: ScrollbackBlock[]) => void
  /**
   * Merge a DB re-projection onto the live cache by key — the reconnect-resync
   * write. Every block in `next` upserts by identity; current **keyed** blocks
   * NOT in `next` are kept (in-flight messages the snapshot doesn't show yet, so
   * a resync never drops the streaming tail); keyless transient lines are
   * dropped (the projection is the authoritative record). `next` first (the
   * persisted prefix), then the surviving live suffix.
   */
  readonly reconcile: (next: ScrollbackBlock[]) => void
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
   * Per-node LIVE health (what each running agent is doing + when it last
   * showed a sign of life), fed by `agent_health` events. The fleet tree
   * renders it as the running row's suffix (`↻ retrying 429 2/3`, `⚠ idle 2m`);
   * a terminal `subagent_end` clears the entry. Reconciled wholesale on
   * (re)attach from the daemon's fleet snapshot.
   */
  readonly nodeHealth: Accessor<ReadonlyMap<string, NodeHealthInfo>>
  readonly setNodeHealth: (nodeId: string, health: NodeHealthInfo) => void
  readonly clearNodeHealth: (nodeId: string) => void
  readonly reconcileNodeHealth: (
    entries: ReadonlyArray<readonly [string, NodeHealthInfo]>,
  ) => void
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
  const [nodeHealthSig, setNodeHealthSig] = createSignal<ReadonlyMap<string, NodeHealthInfo>>(
    new Map(),
  )
  const [searchPane, setSearchPaneSig] = createSignal<"conversation" | "side">("conversation")
  const convScroller: { current?: ConvScroller } = {}
  const inputControl: { current?: InputControl } = {}

  // Optimistic user lines awaiting their authoritative `user_message` event,
  // oldest first (FIFO). Non-reactive coordination state — never rendered. A
  // monotonic counter mints unique `opt:<n>` keys so two identical-text messages
  // stay distinct (content-hash dedup would wrongly merge them).
  const pendingOpt: string[] = []
  let optSeq = 0

  return {
    blocks,
    collapsed,
    setCollapsed: (next) => setCollapsedSig(next),
    convCursor,
    setConvCursor: (next) => setConvCursorSig(next),
    pushBlock: (block) => setBlocksSig((bs) => upsertInto(bs, block)),
    pushOptimisticUser: (text) => {
      const key = `opt:${optSeq++}`
      pendingOpt.push(key)
      setBlocksSig((bs) => upsertInto(bs, { kind: "user", text, key }))
      return key
    },
    resolveOptimisticUser: (position, text) => {
      const posKey = messageKey(position, "u")
      const optKey = pendingOpt.shift()
      setBlocksSig((bs) => {
        // Already have this position (a replay / a resync rebuilt it): upsert.
        if (bs.some((b) => identityOf(b) === posKey)) {
          // Drop a now-redundant optimistic placeholder if one was pending.
          const pruned = optKey !== undefined ? bs.filter((b) => identityOf(b) !== optKey) : bs
          return upsertInto(pruned, { kind: "user", text, key: posKey })
        }
        // Re-key the pending optimistic line in place → collapses opt↔authoritative.
        if (optKey !== undefined) {
          const at = bs.findIndex((b) => identityOf(b) === optKey)
          if (at !== -1) {
            const next = [...bs]
            next[at] = { kind: "user", text, key: posKey }
            return next
          }
        }
        // No optimistic placeholder (queued drain / another client): append fresh.
        return upsertInto(bs, { kind: "user", text, key: posKey })
      })
    },
    updateTool: (id, patch) =>
      setBlocksSig((bs) =>
        bs.map((b) => (b.kind === "tool" && b.id === id ? { ...b, ...patch } : b)),
      ),
    updateAgents: (id, agents) =>
      setBlocksSig((bs) =>
        bs.map((b) => (b.kind === "agents" && b.id === id ? { ...b, agents } : b)),
      ),
    setBlocks: (next) => setBlocksSig(next),
    reconcile: (next) =>
      setBlocksSig((cur) => {
        const nextIds = new Set<string>()
        for (const b of next) {
          const id = identityOf(b)
          if (id !== undefined) nextIds.add(id)
        }
        // Keep only the LIVE keyed MESSAGE blocks the snapshot doesn't represent
        // yet (positions past the persisted frontier) — so a mid-turn resync never
        // wipes the streaming tail. Keyless transient lines are dropped (the
        // projection is the authoritative record). `tool`/`agents` blocks are
        // NOT preserved: `projectHistory` is authoritative for them (it rebuilds
        // every pill/fan-out block from the persisted messages with the SAME keys
        // the live pump stamps), so an unmatched live tool/agents block here is a
        // stale duplicate, not in-flight work. Keeping it would append it AFTER
        // the whole projection — the "fleet block jumps to the end" bug. Dropping
        // it lets the projection supply that block at its true DB-order slot. This
        // is the safety net beneath the shared-identity keying: even if a parallel
        // spawn's arrival order skews which node is "first", nothing reorders.
        const liveSuffix = cur.filter((b) => {
          if (b.kind !== "user" && b.kind !== "assistant" && b.kind !== "reasoning") {
            return false
          }
          const id = identityOf(b)
          return id !== undefined && !nextIds.has(id)
        })
        return [...next, ...liveSuffix]
      }),
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
    nodeHealth: nodeHealthSig,
    setNodeHealth: (nodeId, health) =>
      setNodeHealthSig((m) => {
        const next = new Map(m)
        next.set(nodeId, health)
        return next
      }),
    clearNodeHealth: (nodeId) =>
      setNodeHealthSig((m) => {
        if (!m.has(nodeId)) return m
        const next = new Map(m)
        next.delete(nodeId)
        return next
      }),
    reconcileNodeHealth: (entries) => setNodeHealthSig(new Map(entries)),
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
      pendingOpt.length = 0
    },
    search,
    setSearch: (next) => setSearchSig(next),
    searchPane,
    setSearchPane: (pane) => setSearchPaneSig(pane),
    convScroller,
    inputControl,
  }
}
