import { Effect } from "effect"
import { batch } from "solid-js"
import { ContextTreeStore, type ConversationId } from "@efferent/core"
import type { TuiStore } from "../state/store.js"

/** Load the persisted context-tree nodes for `cid` into the side projection. */
export const loadTreeNodes = (store: TuiStore, cid: ConversationId) =>
  Effect.gen(function* () {
    const cts = yield* ContextTreeStore
    const nodes = yield* cts.listTree(cid)
    yield* Effect.sync(() => store.setProjection((p) => ({ ...p, treeNodes: nodes })))
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
