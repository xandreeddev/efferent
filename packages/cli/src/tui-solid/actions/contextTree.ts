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
 * `:tree` — toggle the context-tree viewer. Opening loads the persisted
 * sub-agent nodes for the current conversation and focuses the side pane;
 * closing returns to the Activity dashboard (and the input, if the side held
 * focus). Mirrors `toggleContext`.
 */
export const toggleTree = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const opening = store.sidePane().view !== "tree"
    if (opening) yield* loadTreeNodes(store, cid)
    yield* Effect.sync(() =>
      batch(() => {
        store.setNav((n) => ({ ...n, view: opening ? "tree" : "stack", treeCursor: 0 }))
        if (opening) {
          store.setFocus("side")
          store.setMode("normal")
        } else if (store.focus() === "side") {
          store.setFocus("input")
          store.setMode("insert")
        }
      }),
    )
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
