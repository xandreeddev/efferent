import { basename } from "node:path"
import { Effect, Schema } from "effect"
import { batch } from "solid-js"
import {
  ContextNodeId,
  ContextTreeStore,
  getWorkspaceRef,
  type ConversationId,
} from "@efferent/core"
import type { ScrollbackBlock } from "../presentation/conversation.js"
import { withSeedMarkers } from "../presentation/nodePreview.js"
import { treeRows } from "../presentation/sidePane.js"
import type { TuiStore } from "../state/store.js"
import { replayBlocks } from "./replay.js"
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
 * `↵` in the tree view — open the node's full session as a **preview overlay**
 * on the conversation pane: its persisted messages replayed into rail blocks,
 * a header line (folder · provenance · seed preview), and the seed/run
 * boundary marked when the node recorded its seed count. Focus moves to the
 * conversation pane so the preview is visible even below the narrow
 * breakpoint (where only the focused pane renders); `↵` on the same node,
 * `q`, or Esc (idle) drop the overlay and return to the tree.
 */
export const openNodePreview = (store: TuiStore, nodeId: string) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(ContextNodeId)(nodeId).pipe(Effect.option)
    if (decoded._tag === "None") return
    const cts = yield* ContextTreeStore
    const node = yield* cts.get(decoded.value)
    const messages = yield* cts.listMessages(decoded.value)
    const folder = basename(node.folder) || node.folder
    const header: ScrollbackBlock = {
      kind: "info",
      text: [
        `agent ${folder} · ${node.edgeKind} · seed: ${node.seed.kind}`,
        node.seed.preview !== undefined ? ` — ${node.seed.preview}` : "",
        node.status === "running" ? " · running (snapshot)" : "",
      ].join(""),
    }
    const blocks = [
      header,
      ...withSeedMarkers(replayBlocks(messages, []), node.seed.kind, node.seedMessageCount),
    ]
    yield* Effect.sync(() =>
      batch(() => {
        const prior = store.nodePreview()
        store.setNodePreview({
          nodeId,
          title: `agent: ${folder}`,
          blocks,
          // Swapping preview→preview must keep the ORIGINAL live fold set.
          savedCollapsed: prior?.savedCollapsed ?? store.collapsed(),
        })
        store.setCollapsed(new Set())
        store.setConvCursor(0)
        if (store.search()?.pane === "conversation") store.setSearch(undefined)
        store.setFocus("conversation")
        store.setMode("normal")
        store.convScroller.current?.scrollToTop()
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
