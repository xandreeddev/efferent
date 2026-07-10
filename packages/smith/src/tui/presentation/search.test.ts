import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { ConversationBlock } from "./conversation.js"
import { currentHit, cycleSearch, searchNotice, startSearch } from "./search.js"

const blocks: ReadonlyArray<ConversationBlock> = [
  { kind: "user", text: "port the stats module" },
  { kind: "tool", id: "t1", name: "read_file", arg: "stats.py", status: "ok", first: true, result: "def mean(xs)…" },
  { kind: "assistant", text: "ported mean and median", tag: "kimi", leading: true, tokens: { input: 1, output: 1, cached: 0 } },
  { kind: "notice", text: "workspace memory curated" },
]

describe("/search over the story", () => {
  test("hits are block indexes, case-insensitive, across text/arg/result", () => {
    const found = Option.getOrThrow(startSearch(blocks, "STATS"))
    expect(found.hits).toEqual([0, 1])
    // Starts at the LAST hit (the story reads bottom-up).
    expect(found.at).toBe(1)
    expect(Option.getOrThrow(currentHit(Option.some(found)))).toBe(1)
    const inResult = Option.getOrThrow(startSearch(blocks, "median"))
    expect(inResult.hits).toEqual([2])
  })

  test("cycling wraps both ways", () => {
    const found = Option.getOrThrow(startSearch(blocks, "stats"))
    const back = cycleSearch(found, -1)
    expect(back.at).toBe(0)
    const wrapped = cycleSearch(cycleSearch(found, 1), 1)
    expect(wrapped.at).toBe(1)
  })

  test("no hits / empty query → None; the notice names position and keys", () => {
    expect(Option.isNone(startSearch(blocks, "zebra"))).toBe(true)
    expect(Option.isNone(startSearch(blocks, "  "))).toBe(true)
    const found = Option.getOrThrow(startSearch(blocks, "stats"))
    expect(searchNotice(found)).toContain("hit 2/2")
    expect(searchNotice(found)).toContain("ctrl+n")
  })
})
