import { Effect, Schema } from "effect"
import { batch } from "solid-js"
import {
  ContextNodeId,
  ContextTreeStore,
  getWorkspaceRef,
  type ConversationId,
} from "@efferent/core"
import { treeRows } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"
import { openContextView } from "./session.js"

/**
 * Load the persisted context-tree nodes for `cid` into the side projection,
 * along with the workspace's current git HEAD — nodes stamped with a different
 * ref render a `stale` badge (their context describes an older world).
 */
export const loadTreeNodes = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const cts = yield* ContextTreeStore
    const nodes = yield* cts.listTree(cid)
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
 * Switch the side pane to the context-tree viewer, loading the persisted
 * sub-agent nodes. **Focus-free** — the `v` view cycle uses this directly;
 * `toggleTree` layers the `:tree` command's focus choreography on top.
 */
export const openTreeView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    yield* loadTreeNodes(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => ({ ...n, view: "tree", treeCursor: 0 })),
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
 * `v` — pure 3-way side-view cycle: activity → context → tree → activity.
 * Loads each view's data on entry but **never moves focus or mode** — the
 * close-to-input behaviour belongs to the `:context`/`:tree` toggles, not the
 * cycle (it's what made `v` on the last view dump the keypress into the
 * textarea).
 */
export const cycleSideView = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const view = store.sidePane().view
    if (view === "stack") yield* openContextView(store, cid)
    else if (view === "context") yield* openTreeView(store, cid)
    else yield* Effect.sync(() => store.setNav((n) => ({ ...n, view: "stack" })))
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
    yield* loadTreeNodes(store, cid)
    yield* Effect.sync(() =>
      store.setNav((n) => {
        const count = treeRows(n, store.projection()).length
        return { ...n, treeCursor: Math.max(0, Math.min(n.treeCursor, count - 1)) }
      }),
    )
  })
