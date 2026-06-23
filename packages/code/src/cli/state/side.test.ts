import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { emptySidePane } from "../presentation/sidePane.js"
import { onToolStart } from "../presentation/executionTree.js"
import { createSideSlice } from "./side.js"

/**
 * The slice splits the old single `projection` signal into per-concern signals
 * (executionTree · stats · treeData · the rest) so an update notifies only the
 * consumers that care. These tests are the machine-checkable guarantee of that
 * scoping: a write to one concern must not change another concern's signal
 * reference (which is exactly what would re-run an unrelated consumer).
 */
describe("side slice — updates are scoped to their concern", () => {
  test("setTree (per-event, the hot path) leaves stats + treeData untouched", () => {
    createRoot((dispose) => {
      const s = createSideSlice(emptySidePane)
      const stats0 = s.stats()
      const treeData0 = s.treeData()

      s.setTree((t) => onToolStart(t, "read x", 0).tree)

      expect(s.executionTree().roots).toHaveLength(1) // the tree DID change
      expect(s.stats()).toBe(stats0) // StatusBar's input — same ref, no re-run
      expect(s.treeData()).toBe(treeData0) // fleet tree's input — same ref, no re-run
      dispose()
    })
  })

  test("setStats / setTreeData leave the execution tree untouched", () => {
    createRoot((dispose) => {
      const s = createSideSlice(emptySidePane)
      const tree0 = s.executionTree()

      s.setStats((st) => ({ ...st, turns: st.turns + 1 }))
      s.setTreeData((d) => ({ ...d, sessions: [{ id: "c1", label: "c1", active: true }] }))

      expect(s.executionTree()).toBe(tree0) // activity/live-feed input — undisturbed
      expect(s.stats().turns).toBe(1)
      expect(s.treeData().sessions).toHaveLength(1)
      dispose()
    })
  })

  test("the reassembled projection() still reflects every concern (compat shim)", () => {
    createRoot((dispose) => {
      const s = createSideSlice(emptySidePane)
      s.setTree((t) => onToolStart(t, "grep y", 0).tree)
      s.setStats((st) => ({ ...st, turns: 3 }))
      s.setTreeData((d) => ({ ...d, treeNodes: [] }))
      const p = s.projection()
      expect(p.tree.roots).toHaveLength(1)
      expect(p.stats.turns).toBe(3)
      expect(p.treeNodes).toEqual([])
      dispose()
    })
  })
})
