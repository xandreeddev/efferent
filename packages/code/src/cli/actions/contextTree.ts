import { basename } from "node:path"
import { Effect, Schema } from "effect"
import { batch } from "solid-js"
import {
  ContextNodeId,
  ContextTreeStore,
  ConversationStore,
  type ConversationId,
  getWorkspaceRef,
} from "@xandreed/sdk-core"
import type { ScrollbackBlock } from "../presentation/conversation.js"
import type { NavConversation } from "../presentation/contextTreeView.js"
import { withSeedMarkers } from "../presentation/nodePreview.js"
import { treeRows } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"
import { replayBlocks } from "./replay.js"
import { applyResume, conversationLabel, conversationTitle } from "./session.js"
import { type AppServices } from "../TuiContext.js"

/**
 * Load the ACTIVE session's agent-context nodes (the `agents` view shows only
 * the current conversation's execution tree), plus the workspace's git HEAD —
 * nodes stamped with a different ref render a `stale` badge (their context
 * describes an older world). Best-effort: a store hiccup never breaks the view.
 */
export const loadAgentTree = (store: TuiStore, activeCid: ConversationId): Effect.Effect<void, never, AppServices> =>
  Effect.gen(function* () {
    const cts = yield* ContextTreeStore
    const nodes = yield* cts.listTree(activeCid).pipe(Effect.catchAll((e) => Effect.logWarning(`tree: could not load: ${e}`).pipe(Effect.zipRight(Effect.succeed([])))))
    const head = yield* getWorkspaceRef(store.status().cwd)
    yield* Effect.sync(() =>
      store.setTreeData((d) => ({
        ...d,
        treeNodes: nodes,
        ...(head !== undefined ? { treeWorkspaceRef: head } : {}),
      })),
    )
  })

/**
 * Load the active session as the fleet tree's single root. The fleet pane is
 * **current-session-only** in both bins, so this defaults to `activeOnly: true`
 * — one root (the working session), the `treeRows` flattener nests its whole
 * agent subtree under it (its `adoptAll` path). Other sessions are reached via
 * the `:browse`/resume picker, not this always-visible pane. Pass
 * `{ activeOnly: false }` for the legacy multi-session list.
 */
export const loadSessions = (
  store: TuiStore,
  activeCid: ConversationId,
  opts: { readonly activeOnly?: boolean } = {},
): Effect.Effect<void, never, AppServices> =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const list = yield* cs
      .listByWorkspace(store.status().cwd)
      .pipe(Effect.catchAll(() => Effect.succeed([])))
    // The active conversation may be brand-new (no messages persisted yet) and
    // absent from listByWorkspace — show it anyway, labelled as current.
    const all: NavConversation[] = list.map((c) => ({
      id: c.id,
      label: conversationLabel(c),
      title: conversationTitle(c),
      active: c.id === activeCid,
    }))
    // Current-session-only (the default): keep just the active session as the
    // fleet root. If it isn't persisted yet, fall through to the synthetic
    // "(current session)". `{ activeOnly: false }` opts into the full list.
    const activeOnly = opts.activeOnly ?? true
    const sessions = activeOnly ? all.filter((c) => c.active) : all
    if (!sessions.some((c) => c.active)) {
      sessions.unshift({ id: activeCid, label: "(current session)", active: true })
    }
    yield* Effect.sync(() => store.setTreeData((d) => ({ ...d, sessions })))
  })

/** Refresh both navigator data sets (boot + every turn end + on each sub-agent
 *  start/end). Scopes the fleet tree to the active session by default
 *  (current-session-only); pass `{ activeOnly: false }` for the full list. */
export const refreshNav = (
  store: TuiStore,
  activeCid: ConversationId,
  opts: { readonly activeOnly?: boolean } = {},
): Effect.Effect<void, never, AppServices> =>
  Effect.zipRight(loadAgentTree(store, activeCid), loadSessions(store, activeCid, opts))

/**
 * Refresh the fleet tree and land the cursor on the FIRST agent node (not the
 * active-session row at the top — `↵` on a node jumps the chat into it, the
 * point of the tree, while `↵` on the session row returns to the assistant).
 * The view is pinned to "tree" (it drives the cursor/fold reducers).
 */
export const openTreeView = (store: TuiStore, cid: ConversationId): Effect.Effect<void, never, AppServices> =>
  Effect.gen(function* () {
    yield* loadAgentTree(store, cid)
    yield* loadSessions(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => {
        const withView = { ...n, view: "tree" as const }
        const rows = treeRows(withView, store.projection())
        const firstNode = rows.findIndex((r) => r.display.kind === "node")
        return { ...withView, treeCursor: firstNode >= 0 ? firstNode : 0 }
      }),
    )
  })

/**
 * `:tree` / `:sessions` — focus the always-visible fleet tree (the chat-first
 * layout shows it on the right at all times; these commands just move focus to
 * it after a fresh load). The old four cycled side views are gone — this is the
 * single tree pane.
 */
export const focusFleetTree = (store: TuiStore, cid: ConversationId): Effect.Effect<void, never, AppServices> =>
  Effect.gen(function* () {
    yield* openTreeView(store, cid)
    yield* Effect.sync(() =>
      batch(() => {
        store.setFocus("tree")
        store.setMode("normal")
      }),
    )
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
    // A context node is a cache of a world that keeps changing — it can be
    // dropped or never have been persisted. Tolerate a missing one instead of
    // crashing the whole action (which logged a raw `ContextNodeNotFound` and
    // spammed an error block every time the preview re-fetched at turn end).
    const fetched = yield* cts
      .get(decoded.value)
      .pipe(Effect.zip(cts.listMessages(decoded.value)), Effect.option)
    if (fetched._tag === "None") {
      yield* Effect.sync(() => {
        if (store.nodePreview()?.nodeId === nodeId) closeNodePreview(store)
        store.toast("that agent's session is no longer available")
      })
      return
    }
    const [node, messages] = fetched.value
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
        // The agent (right) pane reads the node's LIVE LOG (the pump accumulates
        // it as the agent works). Seed it from persisted history only when the
        // pump never streamed this node (a finished / prior-session node) —
        // seedNodeLog never clobbers a live log, so a running agent keeps its
        // richer streamed log.
        store.seedNodeLog(nodeId, blocks)
        store.setNodePreview({
          nodeId,
          title: `agent: ${name}`,
          blocks,
          savedCollapsed: store.collapsed(),
        })
        if (!focus) return
        // Focus the composer so you can message this agent immediately (typing
        // routes to its mailbox via submitToNode); the orchestrator stays left.
        store.setFocus("input")
        store.setMode("insert")
      }),
    )
  })

/**
 * Close the agent (right) jump-in: re-point the LEFT chat back to the
 * assistant. Focus moves to the fleet tree so you can pick another teammate;
 * the assistant's rail (and its folds) is left exactly as it was.
 */
export const closeNodePreview = (store: TuiStore): void => {
  const p = store.nodePreview()
  if (p === undefined) return
  batch(() => {
    store.setNodePreview(undefined)
    store.setFocus("tree")
    store.setMode("normal")
  })
}

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
    const fetched = yield* cts
      .get(decoded.value)
      .pipe(Effect.zip(cts.listMessages(decoded.value)), Effect.option)
    if (fetched._tag === "None") {
      yield* Effect.sync(() => store.toast("that agent's session is no longer available"))
      return
    }
    const [node, messages] = fetched.value
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
