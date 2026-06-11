import { basename } from "node:path"
import { Effect, Schema } from "effect"
import { batch } from "solid-js"
import {
  ContextNodeId,
  ContextTreeStore,
  ConversationStore,
  getWorkspaceRef,
  type ConversationId,
} from "@efferent/core"
import type { ScrollbackBlock } from "../presentation/conversation.js"
import type { NavConversation } from "../presentation/contextTreeView.js"
import { withSeedMarkers } from "../presentation/nodePreview.js"
import { treeRows } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"
import { replayBlocks } from "./replay.js"
import { applyResume, conversationLabel, conversationTitle, openContextView, resumeConversation } from "./session.js"

/**
 * Load the ACTIVE session's agent-context nodes (the `agents` view shows only
 * the current conversation's execution tree), plus the workspace's git HEAD —
 * nodes stamped with a different ref render a `stale` badge (their context
 * describes an older world). Best-effort: a store hiccup never breaks the view.
 */
export const loadAgentTree = (store: TuiStore, activeCid: ConversationId) =>
  Effect.gen(function* () {
    const cts = yield* ContextTreeStore
    const nodes = yield* cts.listTree(activeCid).pipe(Effect.catchAll(() => Effect.succeed([])))
    const head = yield* getWorkspaceRef(store.status().cwd)
    yield* Effect.sync(() =>
      store.setProjection((p) => ({
        ...p,
        treeNodes: nodes,
        ...(head !== undefined ? { treeWorkspaceRef: head } : {}),
      })),
    )
  })

/**
 * Load the workspace's conversations into the `sessions` view: every session
 * sharing this path, the active one marked — Enter there swaps between them.
 */
export const loadSessions = (store: TuiStore, activeCid: ConversationId) =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const list = yield* cs
      .listByWorkspace(store.status().cwd)
      .pipe(Effect.catchAll(() => Effect.succeed([])))
    // The active conversation may be brand-new (no messages persisted yet) and
    // absent from listByWorkspace — show it anyway, labelled as current.
    const sessions: NavConversation[] = list.map((c) => ({
      id: c.id,
      label: conversationLabel(c),
      title: conversationTitle(c),
      active: c.id === activeCid,
    }))
    if (!sessions.some((c) => c.active)) {
      sessions.unshift({ id: activeCid, label: "(current session)", active: true })
    }
    yield* Effect.sync(() => store.setProjection((p) => ({ ...p, sessions })))
  })

/** Refresh both navigator data sets (boot + every turn end). */
export const refreshNav = (store: TuiStore, activeCid: ConversationId) =>
  Effect.zipRight(loadAgentTree(store, activeCid), loadSessions(store, activeCid))

/**
 * Switch the side pane to the context-tree viewer, loading the persisted
 * sub-agent nodes. **Focus-free** — the `v` view cycle uses this directly;
 * `toggleTree` layers the `:tree` command's focus choreography on top.
 */
export const openTreeView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    yield* loadAgentTree(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => ({ ...n, view: "tree", treeCursor: 0 })),
    )
  })

/** Switch the side pane to the sessions list. Focus-free (the `v` cycle). */
export const openSessionsView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    yield* loadSessions(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => ({ ...n, view: "sessions", sessionsCursor: 0 })),
    )
  })

/** `:sessions` — toggle the workspace sessions list. Mirrors `toggleTree`. */
export const toggleSessions = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const opening = store.sidePane().view !== "sessions"
    if (opening) {
      yield* openSessionsView(store, cid)
      yield* Effect.sync(() => {
        store.setFocus("side")
        store.setMode("normal")
      })
      return
    }
    yield* Effect.sync(() =>
      batch(() => {
        store.setNav((n) => ({ ...n, view: "stack", sessionsCursor: 0 }))
        if (store.focus() === "side") {
          store.setFocus("input")
          store.setMode("insert")
        }
      }),
    )
  })

/**
 * `:tree` — toggle the context-tree viewer. Opening loads the persisted
 * sub-agent nodes for the current conversation and focuses the side pane;
 * closing returns to the Activity dashboard (and the input, if the side held
 * focus). Mirrors `toggleContext`.
 */
export const toggleTree = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const opening = store.sidePane().view !== "tree"
    if (opening) {
      yield* openTreeView(store, cid)
      yield* Effect.sync(() => {
        store.setFocus("side")
        store.setMode("normal")
      })
      return
    }
    yield* Effect.sync(() =>
      batch(() => {
        store.setNav((n) => ({ ...n, view: "stack", treeCursor: 0 }))
        if (store.focus() === "side") {
          store.setFocus("input")
          store.setMode("insert")
        }
      }),
    )
  })

/**
 * `v` — the side-view cycle: activity → context → agents → sessions → activity.
 * Loads each view's data on entry but **never moves focus or mode** — the
 * close-to-input behaviour belongs to the typed toggles, not the cycle (it's
 * what made `v` on the last view dump the keypress into the textarea).
 */
export const cycleSideView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const view = store.sidePane().view
    if (view === "stack") yield* openContextView(store, cid)
    else if (view === "context") yield* openTreeView(store, cid)
    else if (view === "tree") yield* openSessionsView(store, cid)
    else yield* Effect.sync(() => store.setNav((n) => ({ ...n, view: "stack" })))
  })

/**
 * `↵` in the tree view — open the node's full session as a **preview overlay**
 * on the conversation pane: its persisted messages replayed into rail blocks,
 * a header line (folder · provenance · seed preview), and the seed/run
 * boundary marked when the node recorded its seed count. Focus moves to the
 * conversation pane so the preview is visible even below the narrow
 * breakpoint (where only the focused pane renders); `↵` on the same node,
 * `q`, or Esc (idle) drop the overlay and return to the tree.
 *
 * `opts.focus: false` = a **refresh** of an already-open preview (a follow-up
 * turn just grew the node): re-fetch the blocks but leave focus, mode, cursor,
 * and scroll alone — the user may be mid-typing the next message.
 */
export const openNodePreview = (
  store: TuiStore,
  nodeId: string,
  opts: { readonly focus?: boolean } = {},
) =>
  Effect.gen(function* () {
    const focus = opts.focus ?? true
    const decoded = yield* Schema.decodeUnknown(ContextNodeId)(nodeId).pipe(Effect.option)
    if (decoded._tag === "None") return
    const cts = yield* ContextTreeStore
    const node = yield* cts.get(decoded.value)
    const messages = yield* cts.listMessages(decoded.value)
    const folder = basename(node.folder) || node.folder
    const name = node.title ?? folder
    const header: ScrollbackBlock = {
      kind: "info",
      text: [
        `agent ${name}${node.title !== undefined ? ` (${folder})` : ""} · ${node.edgeKind} · seed: ${node.seed.kind}`,
        node.seed.preview !== undefined ? ` — ${node.seed.preview}` : "",
        node.status === "running" ? " · running (live)" : "",
      ].join(""),
    }
    const blocks: ScrollbackBlock[] = [
      header,
      ...withSeedMarkers(replayBlocks(messages, []), node.seed.kind, node.seedMessageCount),
      // A failed run leaves no assistant message — surface its recorded error.
      ...(node.status === "error"
        ? [{ kind: "error", text: node.returnSummary ?? "run failed" } as const]
        : []),
    ]
    yield* Effect.sync(() =>
      batch(() => {
        const prior = store.nodePreview()
        store.setNodePreview({
          nodeId,
          title: `agent: ${name}`,
          blocks,
          // Swapping preview→preview must keep the ORIGINAL live fold set.
          savedCollapsed: prior?.savedCollapsed ?? store.collapsed(),
        })
        store.setCollapsed(new Set())
        if (!focus) return
        store.setConvCursor(0)
        if (store.search()?.pane === "conversation") store.setSearch(undefined)
        store.setFocus("conversation")
        store.setMode("normal")
        // Land on the node's LATEST work (same as opening a conversation) —
        // the header/seed markers are still there for gg readers.
        store.convScroller.current?.scrollToBottom()
      }),
    )
  })

/** Drop the preview overlay: restore the live rail, folds, and side focus. */
export const closeNodePreview = (store: TuiStore): void => {
  const p = store.nodePreview()
  if (p === undefined) return
  batch(() => {
    store.setNodePreview(undefined)
    store.setCollapsed(new Set(p.savedCollapsed))
    if (store.search()?.pane === "conversation") store.setSearch(undefined)
    store.setConvCursor(0)
    store.setFocus("side")
    store.setMode("normal")
    store.convScroller.current?.scrollToBottom()
  })
}

/**
 * `↵` on a conversation row — make that conversation the **active session**
 * (the one the input feeds): resume it into the rail, then reload the
 * navigator so the active mark moves. Focus stays on the navigator so the
 * user can keep hopping between sessions; `i` drops to the input to type.
 * Refused mid-turn — swapping the live conversation under a running agent
 * would orphan its appends.
 */
export const switchToConversation = (store: TuiStore, target: ConversationId) =>
  Effect.gen(function* () {
    if (store.busy()) {
      yield* Effect.sync(() => store.toast("can't switch sessions while a turn is running"))
      return
    }
    if (store.run.getConversationId() === target) {
      yield* Effect.sync(() => store.toast("already the active session"))
      return
    }
    yield* Effect.sync(() => closeNodePreview(store))
    yield* resumeConversation(store, target)
    // resume resets the side nav — restore the SESSIONS view (where the swap
    // came from) with fresh data so the active mark moves and hopping goes on.
    yield* refreshNav(store, target)
    yield* Effect.sync(() => {
      store.setNav((n) => ({ ...n, view: "sessions" }))
      store.setFocus("side")
      store.setMode("normal")
    })
  })

/**
 * `c` on an agent node — **continue from here**: materialize the node's full
 * persisted context into a brand-new conversation and make it the active
 * session, so the human takes over exactly where the sub-agent stopped (the
 * human-driven counterpart of `run_agent`'s `seedMode: "branch"`). The node
 * itself is untouched; the fork is a new manual branch in the navigator.
 */
export const continueFromNode = (store: TuiStore, cwd: string, nodeId: string) =>
  Effect.gen(function* () {
    if (store.busy()) {
      yield* Effect.sync(() => store.toast("can't fork a session while a turn is running"))
      return
    }
    const decoded = yield* Schema.decodeUnknown(ContextNodeId)(nodeId).pipe(Effect.option)
    if (decoded._tag === "None") return
    const cts = yield* ContextTreeStore
    const node = yield* cts.get(decoded.value)
    const messages = yield* cts.listMessages(decoded.value)
    const cs = yield* ConversationStore
    const created = yield* cs.create(cwd).pipe(Effect.either)
    if (created._tag === "Left") {
      yield* Effect.sync(() => store.toast("failed to create the new session"))
      return
    }
    const newId = created.right
    yield* Effect.forEach(messages, (m) =>
      cs.append(newId, m).pipe(Effect.catchAll(() => Effect.void)),
    )
    const name = node.title ?? (basename(node.folder) || node.folder)
    // Carry the node's name onto the fork so the sessions pane doesn't fall
    // back to a first-prompt preview (the title daemon only fires on a first
    // exchange, which a seeded fork never has).
    if (node.title !== undefined) {
      yield* cs.setTitle(newId, node.title).pipe(Effect.catchAll(() => Effect.void))
    }
    yield* Effect.sync(() =>
      batch(() => {
        closeNodePreview(store)
        applyResume(store, newId, messages, [], false)
        store.pushBlock({
          kind: "info",
          text: `continued agent ${name} as new session ${newId.slice(0, 8)} · ${messages.length} msgs — type to take over`,
        })
      }),
    )
    yield* refreshNav(store, newId)
    yield* Effect.sync(() => store.setNav((n) => ({ ...n, view: "tree" })))
    // The point of forking is to keep typing — land in the composer.
    yield* Effect.sync(() => {
      store.setFocus("input")
      store.setMode("insert")
    })
  })

/**
 * `d` in the tree view — drop the node under the cursor and its descendants
 * (cascade), then reload + clamp the cursor. A no-op on an unparseable id; the
 * caller guards against dropping a still-running node.
 */
export const dropNode = (store: TuiStore, cid: ConversationId, nodeId: string) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(ContextNodeId)(nodeId).pipe(Effect.option)
    if (decoded._tag === "None") return
    const cts = yield* ContextTreeStore
    yield* cts.drop(decoded.value)
    yield* loadAgentTree(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => {
        const count = treeRows(n, store.projection()).length
        return { ...n, treeCursor: Math.max(0, Math.min(n.treeCursor, count - 1)) }
      }),
    )
  })
