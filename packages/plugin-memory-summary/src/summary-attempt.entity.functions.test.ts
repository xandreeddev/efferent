import { expect, test } from "bun:test"
import { claimSummary, settleSummary } from "./summary-attempt.entity.functions.js"

test("summary claims remember every attempted frontier, decline reentry and preserve terminal failure", () => {
  const first = claimSummary({ _tag: "Ready", attempted: [] }, "first")
  expect(first).toEqual([true, { _tag: "Running", frontier: "first", attempted: ["first"] }])
  expect(claimSummary(first[1], "second")).toEqual([false, first[1]])
  const completed = settleSummary(first[1], true)
  expect(claimSummary(completed, "first")).toEqual([false, completed])
  const second = claimSummary(completed, "second")
  expect(second).toEqual([true, { _tag: "Running", frontier: "second", attempted: ["first", "second"] }])
  const again = settleSummary(second[1], true)
  expect(claimSummary(again, "first")).toEqual([false, again])
  const failed = settleSummary(second[1], false)
  expect(claimSummary(failed, "third")).toEqual([false, failed])
})
