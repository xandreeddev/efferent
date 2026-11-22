import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { FileDiff } from "../diff.entity.js"
import { TurnNumber } from "../finding.entity.js"
import { GoldId } from "./review-eval.entity.js"
import type { RecordedFinding } from "./review-eval.entity.js"
import { goldScore, replayed, reviewKeyOf } from "./review-eval.entity.functions.js"

/** A file of 100 lines whose every line the change adds, so every finding on it is on a changed line. */
const added = (path: string): FileDiff => ({
  path,
  oldPath: Option.none(),
  change: "added",
  modeChange: Option.none(),
  binary: false,
  additions: 100,
  deletions: 0,
  hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 100, section: "", lines: Array.from({ length: 100 }, (_, index) => ({ _tag: "Added" as const, line: index + 1, text: `line(${index + 1})` })) }],
})

const finding = (turn: number, number: number, path: string, line: number, severity: RecordedFinding["severity"], judged: string | null): RecordedFinding => ({
  path, line, kind: "bug", severity, claim: `claim ${turn}.${number}`, evidence: "", turn: TurnNumber.make(turn), number, judged: judged === null ? null : GoldId.make(judged),
})

describe("the review eval's replay", () => {
  test("reviewKeyOf: the pull request and the first eight digits of the commit", () => {
    expect(reviewKeyOf({ pr: 418, reviewSha: "eaea24a5df6380fc148655d2e4e090a6e85916db" })).toBe("418-eaea24a5")
  })

  test("a gold is shown only when the finding the report prints, a shown bucket's best, was matched to it", () => {
    // Turn 1's high finding and turn 2's low one share a bucket: the high one is its best. Matched to the low one,
    // g1 is found and not shown (the person reads the high claim); matched to the high one, g1 is shown.
    const low = [finding(1, 1, "a.ts", 10, "high", null), finding(2, 1, "a.ts", 11, "low", "g1")]
    const high = [finding(1, 1, "a.ts", 10, "high", "g1"), finding(2, 1, "a.ts", 11, "low", null)]
    expect<unknown>([replayed(low, [added("a.ts")]), replayed(high, [added("a.ts")])]).toEqual([
      { found: ["g1"], shown: [], findings: 2, kept: 1 },
      { found: ["g1"], shown: ["g1"], findings: 2, kept: 1 },
    ])
  })

  test("past six kept buckets in the report's order, a gold is found and not shown", () => {
    // Six high buckets come before the low one that holds g2.
    const highs = Array.from({ length: 6 }, (_, index) => finding(1, index + 1, "a.ts", 10 + index * 10, "high", null))
    const replay = replayed([...highs, finding(1, 7, "b.ts", 5, "low", "g2")], [added("a.ts"), added("b.ts")])
    expect<unknown>([replay, goldScore(replay, GoldId.make("g2"))]).toEqual([{ found: ["g2"], shown: [], findings: 7, kept: 7 }, { found: true, shown: false }])
  })

  test("a finding on a file the diffs do not hold is off the changed lines: found, never kept or shown", () => {
    expect<unknown>(replayed([finding(1, 1, "c.ts", 5, "high", "g3")], [added("a.ts")])).toEqual({ found: ["g3"], shown: [], findings: 1, kept: 0 })
  })
})
