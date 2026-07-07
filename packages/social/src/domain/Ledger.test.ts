import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  appendLedger,
  engagedTweetIds,
  LedgerEntry,
  postedInWindow,
  readLedger,
} from "./Ledger.js"

const NOW = new Date("2026-07-07T12:00:00Z")

const entry = (over: Partial<Parameters<typeof LedgerEntry.make>[0]>): LedgerEntry =>
  new LedgerEntry({ at: NOW.toISOString(), event: "drafted", kind: "reply", ...over })

describe("engagement ledger", () => {
  test("append/read round-trips; a missing file is an empty ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "social-ledger-"))
    const path = join(dir, "nested", "ledger.jsonl")
    expect(await Effect.runPromise(readLedger(path))).toEqual([])
    await Effect.runPromise(appendLedger(path, entry({ targetTweetId: "1" })))
    await Effect.runPromise(appendLedger(path, entry({ event: "posted", targetTweetId: "2" })))
    const rows = await Effect.runPromise(readLedger(path))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.targetTweetId).toBe("1")
    expect(rows[1]?.event).toBe("posted")
  })

  test("a corrupt line is skipped, decodable history still loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "social-ledger-"))
    const path = join(dir, "ledger.jsonl")
    await Effect.runPromise(appendLedger(path, entry({ targetTweetId: "1" })))
    await Bun.write(path, `${await Bun.file(path).text()}{corrupt\n`)
    await Effect.runPromise(appendLedger(path, entry({ targetTweetId: "2" })))
    const rows = await Effect.runPromise(readLedger(path))
    expect(rows.map((r) => r.targetTweetId)).toEqual(["1", "2"])
  })

  test("engagedTweetIds counts drafted/posted/discarded, never skipped", () => {
    const ids = engagedTweetIds([
      entry({ targetTweetId: "a" }),
      entry({ event: "discarded", targetTweetId: "b" }),
      entry({ event: "skipped", targetTweetId: "c" }),
    ])
    expect(ids.has("a")).toBe(true)
    expect(ids.has("b")).toBe(true)
    expect(ids.has("c")).toBe(false)
  })

  test("postedInWindow slices by rolling window", () => {
    const rows = [
      entry({ event: "posted", at: new Date(NOW.getTime() - 30 * 60_000).toISOString() }),
      entry({ event: "posted", at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() }),
      entry({ event: "drafted", at: NOW.toISOString() }),
    ]
    expect(postedInWindow(rows, NOW, 3_600_000)).toHaveLength(1)
    expect(postedInWindow(rows, NOW, 24 * 3_600_000)).toHaveLength(1)
    expect(postedInWindow(rows, NOW, 26 * 3_600_000)).toHaveLength(2)
  })
})
