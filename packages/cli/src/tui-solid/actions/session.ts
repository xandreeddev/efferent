import { batch } from "solid-js"
import { Effect } from "effect"
import {
  ConversationStore,
  recoverConversationStats,
  type AgentMessage,
  type Checkpoint,
  type ConversationId,
} from "@efferent/core"
import {
  buildContextView,
  messagesForSelectedTurns,
  turnIdsOf,
  type ContextSegment,
} from "../presentation/contextView.js"
import {
  emptyNav,
  emptyStats,
  type SidePaneNav,
  type SidePaneProjection,
  type SidePaneState,
} from "../presentation/sidePane.js"
import {
  projectHistory,
  type HistoryProjection,
} from "../presentation/historyProjection.js"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import type { TuiStore } from "../state/store.js"

/** A conversation row as `listByWorkspace` returns it. */
export type ConversationSummary = {
  readonly id: ConversationId
  readonly createdAt: number
  readonly firstPrompt?: string
}

/** Compact one-line label for a conversation: `<date> · <first-prompt preview>`. */
export const conversationLabel = (c: ConversationSummary): string => {
  const date = new Date(c.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  const preview =
    c.firstPrompt !== undefined && c.firstPrompt.trim().length > 0
      ? c.firstPrompt.trim().replace(/\s+/g, " ").slice(0, 80)
      : "(empty)"
  return `${date} · ${preview}`
}

/**
 * Options for the startup conversation picker: a leading "start new" row (value
 * `null`) then one row per prior conversation (`<date> · <first-prompt preview>`,
 * value = its id). Mirrors the old hand-rolled `conversationPickerOptions`.
 */
export const conversationPickerOptions = (
  list: ReadonlyArray<ConversationSummary>,
): ReadonlyArray<SelectOption<ConversationId | null>> => [
  { value: null, label: "+ Start a new conversation" },
  // Compact date (e.g. "Jun 4, 1:55 PM") leaves room for the name; the modal
  // truncates the whole label to its width, so no fixed slice is needed here.
  ...list.map((c) => ({ value: c.id, label: conversationLabel(c) })),
]

/**
 * The fresh side-pane halves for a conversation switch (resume / build): the
 * projection rebuilt from the loaded message set (activity tree + diffstat from
 * `projectHistory`, preserving the prev skills/instructions) and a fresh nav —
 * context viewer folded to `collapsed`, every rebuilt run folded to one line
 * (`activity.foldIds` UNIONED with `emptyNav`'s section folds, which must
 * survive the switch). Returns the two halves so the caller writes each
 * through its own segregated setter.
 */
const switchedSidePane = (
  prev: SidePaneProjection,
  context: ReadonlyArray<ContextSegment>,
  collapsed: ReadonlySet<string>,
  stats: SidePaneState["stats"],
  activity: Pick<HistoryProjection, "tree" | "filesChanged" | "foldIds">,
): { projection: SidePaneProjection; nav: SidePaneNav } => ({
  projection: { ...prev, tree: activity.tree, context, stats, filesChanged: activity.filesChanged },
  nav: {
    ...emptyNav,
    contextCollapsed: collapsed,
    stackCollapsed: new Set([...emptyNav.stackCollapsed, ...activity.foldIds]),
  },
})

const statsFrom = (
  prev: SidePaneState,
  history: ReadonlyArray<AgentMessage>,
): SidePaneState["stats"] => {
  const { lastUsage, cumulativeOutput, cumulativeTotal, turns } =
    recoverConversationStats(history)
  // History without persisted usage (pre-annotation records): a 0/1M gauge
  // would claim a resumed session costs nothing on its next turn. Estimate at
  // ~4 chars/token and mark it (the gauge shows `~`); the first real provider
  // count replaces it.
  const estimate =
    lastUsage === undefined && history.length > 0
      ? Math.round(JSON.stringify(history).length / 4)
      : undefined
  return {
    ...emptyStats,
    startedAt: Date.now(),
    contextWindow: prev.stats.contextWindow,
    inputTokens: lastUsage?.inputTokens ?? estimate ?? 0,
    cacheReadTokens: lastUsage?.cacheReadTokens ?? 0,
    outputTokens: cumulativeOutput,
    totalTokens: cumulativeTotal,
    turns,
    ...(estimate !== undefined ? { estimated: true } : {}),
  }
}

// --- pure store mutations (given already-fetched data) ---

/** Rebuild the context viewer's segments from records (folded, nothing picked). */
export const applyContextRebuild = (
  store: TuiStore,
  segments: ReadonlyArray<ContextSegment>,
): void => {
  store.setProjection((p) => ({ ...p, context: segments }))
  store.setNav((n) => ({
    ...n,
    contextCollapsed: new Set(turnIdsOf(segments)),
    contextSelected: new Set(),
    contextHandoffSelected: new Set(),
    contextCursor: 0,
  }))
}

/**
 * Swap the loaded conversation to `target` (resume — full replay for browsing).
 * `announce` pushes the "resumed …" rail line; boot-resume passes `false` so the
 * history simply appears (matching the old TUI's silent startup replay).
 */
export const applyResume = (
  store: TuiStore,
  target: ConversationId,
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
  announce = true,
): void => {
  const segments = buildContextView(history, checkpoints)
  const stats = statsFrom(store.sidePane(), history)
  const proj = projectHistory(history, checkpoints)
  store.run.newConversation(target)
  store.setBlocks(proj.blocks)
  // stats are the single source — switchedSidePane puts them in the projection; the status bar reads them.
  const switched = switchedSidePane(store.projection(), segments, new Set(turnIdsOf(segments)), stats, proj)
  store.setProjection(() => switched.projection)
  store.setNav(() => switched.nav)
  if (announce) {
    store.pushBlock({
      kind: "info",
      text: `resumed ${target.slice(0, 8)} · ${history.length} msgs loaded for browsing`,
    })
  }
  // The swapped-in content is a DIFFERENT document: the old fold cursor index
  // and search match ids are positional, so left alone they tint arbitrary rows
  // of the new conversation. Reset both, then land at the newest message —
  // sticky-bottom only follows appends, not whole-history swaps (the scroller's
  // scrollToBottom settles across layout frames and re-engages following).
  store.setConvCursor(0)
  if (store.search()?.pane === "conversation") store.setSearch(undefined)
  store.convScroller.current?.scrollToBottom()
}

/** Switch to a freshly-built conversation seeded with the picked units. */
export const applyBuilt = (
  store: TuiStore,
  newId: ConversationId,
  picked: ReadonlyArray<AgentMessage>,
  turnCount: number,
  handoffCount: number,
): void => {
  const stats = statsFrom(store.sidePane(), picked)
  const proj = projectHistory(picked, [])
  store.run.newConversation(newId)
  store.setBlocks(proj.blocks)
  const switched = switchedSidePane(store.projection(), buildContextView(picked, []), new Set(), stats, proj)
  store.setProjection(() => switched.projection)
  store.setNav(() => switched.nav)
  store.setFocus("input")
  store.setMode("insert")
  // Same content-swap hygiene as applyResume: stale positional cursor/search
  // would tint random rows of the freshly-built session.
  store.setConvCursor(0)
  if (store.search()?.pane === "conversation") store.setSearch(undefined)
  store.convScroller.current?.scrollToBottom()
  const units = [
    turnCount > 0 ? `${turnCount} turn${turnCount === 1 ? "" : "s"}` : "",
    handoffCount > 0 ? `${handoffCount} handoff${handoffCount === 1 ? "" : "s"}` : "",
  ]
    .filter((x) => x !== "")
    .join(" + ")
  store.pushBlock({
    kind: "info",
    text: `built new session ${newId.slice(0, 8)} · ${units} · ${picked.length} msgs`,
  })
}

// --- Effects (fetch records, then apply) ---

const listAll = (cs: ConversationStore["Type"], cid: ConversationId) =>
  Effect.all({
    history: cs.list(cid).pipe(Effect.catchAll(() => Effect.succeed([]))),
    checkpoints: cs.listCheckpoints(cid).pipe(Effect.catchAll(() => Effect.succeed([]))),
  })

/**
 * Switch the side pane to the context viewer, rebuilding its segments from the
 * current conversation's records. **Focus-free** — the `v` view cycle uses this
 * directly (cycling must never move focus off the side pane); `toggleContext`
 * layers the `:context` command's focus choreography on top.
 */
export const openContextView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const { history, checkpoints } = yield* listAll(cs, cid)
    const segments = buildContextView(history, checkpoints)
    yield* Effect.sync(() =>
      batch(() => {
        applyContextRebuild(store, segments)
        store.setNav((n) => ({ ...n, view: "context" }))
      }),
    )
  })

/**
 * `:context` — toggle the context viewer: open via `openContextView` and move
 * focus to the side pane (NORMAL, for the block cursor); close back to the
 * input. Lifted from `tui.ts`'s `:context` handler + `rebuildContext`.
 */
export const toggleContext = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const opening = store.sidePane().view !== "context"
    if (opening) {
      yield* openContextView(store, cid)
      yield* Effect.sync(() => {
        store.setFocus("side")
        store.setMode("normal")
      })
      return
    }
    yield* Effect.sync(() =>
      batch(() => {
        store.setNav((n) => ({ ...n, view: "stack" }))
        if (store.focus() === "side") {
          store.setFocus("input")
          store.setMode("insert")
        }
      }),
    )
  })

/** Load a conversation's records and swap it into view (browsing). */
export const resumeConversation = (store: TuiStore, target: ConversationId) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const { history, checkpoints } = yield* listAll(cs, target)
    yield* Effect.sync(() => batch(() => applyResume(store, target, history, checkpoints)))
  })

/**
 * Boot-time `--resume`: load the conversation's full record into the rail
 * silently (no "resumed …" line), matching the old TUI's startup replay. A
 * no-op when the conversation has no messages.
 */
export const loadInitialConversation = (store: TuiStore, target: ConversationId) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const { history, checkpoints } = yield* listAll(cs, target)
    if (history.length === 0) return
    yield* Effect.sync(() =>
      batch(() => applyResume(store, target, history, checkpoints, false)),
    )
  })

/**
 * Build a brand-new conversation seeded with the turns/handoffs the user picked
 * in the context viewer, then switch to it (the original is untouched). Lifted
 * from `tui.ts`'s `doBuildSession`.
 */
export const buildFromSelection = (store: TuiStore, cwd: string) =>
  Effect.gen(function* () {
    if (store.busy()) {
      yield* Effect.sync(() =>
        store.pushBlock({ kind: "info", text: "can't build a session while a turn is running" }),
      )
      return
    }
    const sp = store.sidePane()
    const segs = sp.context ?? []
    const picked = messagesForSelectedTurns(segs, sp.contextSelected, sp.contextHandoffSelected)
    const turnCount = sp.contextSelected.size
    const handoffCount = sp.contextHandoffSelected.size
    if (picked.length === 0) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "info",
          text: "nothing selected — in :context, Space to pick turns or a handoff, then b to build",
        }),
      )
      return
    }
    const cs = yield* ConversationStore
    const created = yield* cs.create(cwd).pipe(Effect.either)
    if (created._tag === "Left") {
      yield* Effect.sync(() =>
        store.pushBlock({ kind: "info", text: "failed to create the new session" }),
      )
      return
    }
    const newId = created.right
    yield* Effect.forEach(picked, (m) =>
      cs.append(newId, m).pipe(Effect.catchAll(() => Effect.void)),
    )
    yield* Effect.sync(() =>
      batch(() => applyBuilt(store, newId, picked, turnCount, handoffCount)),
    )
  })

/**
 * Startup conversation picker: if this workspace has prior conversations, float a
 * "Resume a conversation" select over the (already-interactive) TUI. Selecting a
 * row resumes it (`submitSelect` → `resumeConversation`); "start new" / Esc just
 * dismisses, leaving the fresh conversation. A no-op when there are none, so a
 * brand-new workspace boots straight to an empty rail. Mirrors the old TUI's
 * boot-time `convPicker` (deferred at the OpenTUI cutover, now restored).
 */
export const openConversationPicker = (store: TuiStore, cwd: string) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const list = yield* cs.listByWorkspace(cwd).pipe(Effect.catchAll(() => Effect.succeed([])))
    if (list.length === 0) return
    yield* Effect.sync(() =>
      store.setOverlay({
        kind: "select",
        sel: openSelect("Resume a conversation", conversationPickerOptions(list)),
        purpose: { tag: "conversation" },
      }),
    )
  })

/** List this workspace's conversations into the rail (`:browse`). */
export const browseConversations = (store: TuiStore, cwd: string) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const list = yield* cs.listByWorkspace(cwd).pipe(Effect.catchAll(() => Effect.succeed([])))
    yield* Effect.sync(() =>
      batch(() => {
        store.run.setBrowseList(list)
        store.pushBlock({ kind: "info", text: `conversations in ${cwd}:` })
        if (list.length === 0) {
          store.pushBlock({ kind: "info", text: "  (none)" })
          return
        }
        list.forEach((c, i) => {
          const date = new Date(c.createdAt).toLocaleString()
          const preview =
            c.firstPrompt !== undefined && c.firstPrompt.trim().length > 0
              ? c.firstPrompt.trim().replace(/\s+/g, " ").slice(0, 50)
              : "(empty)"
          const here = c.id === store.run.getConversationId() ? " ← current" : ""
          store.pushBlock({ kind: "info", text: `  [${i + 1}] ${date} · ${preview}${here}` })
        })
        store.pushBlock({ kind: "info", text: "  :resume <#> to open one" })
      }),
    )
  })
