import type { EfficiencyBudget, RoutingExpectation } from "../support/scenarioScorers.js"

/**
 * The HARD, discriminating scenario set — full features, not one-liners. Each
 * ships a precise API stub + a detailed behavioural spec, and is graded by an
 * objective HIDDEN test suite (`bun test`, run AFTER the agent finishes so it
 * can never read or game the tests) plus a demanding completeness rubric.
 *
 * The point: the golden set (`golden.ts`) saturates at ~1.0 for any competent
 * coder, so it can't rank models on quality. These features have many enumerable
 * edge cases (recency × expiry interplay, CSV quoting/escaping, nested-tx
 * tombstones) where a weak coder ships a happy-path solution that passes some
 * tests and fails the edges — the hidden-test pass-RATIO is the discriminator.
 * Scenarios are pure, dependency-free TypeScript so `bun test` runs hermetically
 * with no install and no Docker.
 */
export interface FeatureScenario {
  readonly name: string
  /** Starter files given to the agent — a typed API stub with unimplemented bodies. */
  readonly files: Record<string, string>
  /** The feature request: a precise spec the agent must implement to pass the hidden tests. */
  readonly prompt: string
  /** Test files written into the workspace AFTER the run, then executed. The
   *  agent never sees them — it must infer the full spec from the prompt. */
  readonly hiddenTests: Record<string, string>
  readonly testPaths?: ReadonlyArray<string>
  /** Impl files read back for the judge to assess code quality alongside the tests. */
  readonly readback: ReadonlyArray<string>
  readonly rubric: string
  readonly routing?: RoutingExpectation
  readonly budget?: EfficiencyBudget
}

// ───────────────────────── 1 · LRU cache with TTL ─────────────────────────

const lruStub = String.raw`export interface LruOptions {
  /** Default time-to-live (ms) for entries set without an explicit ttl. Omitted ⇒ those entries never expire. */
  readonly defaultTtlMs?: number
  /** Injectable monotonic clock returning the current time in ms. Defaults to Date.now. */
  readonly now?: () => number
}

/** A fixed-capacity cache that evicts the least-recently-used entry, with per-entry TTL. */
export class LruCache<K, V> {
  constructor(capacity: number, options?: LruOptions) {
    throw new Error("not implemented")
  }
  /** Number of LIVE (non-expired) entries. */
  get size(): number {
    throw new Error("not implemented")
  }
  set(key: K, value: V, ttlMs?: number): void {
    throw new Error("not implemented")
  }
  get(key: K): V | undefined {
    throw new Error("not implemented")
  }
  has(key: K): boolean {
    throw new Error("not implemented")
  }
  delete(key: K): boolean {
    throw new Error("not implemented")
  }
  clear(): void {
    throw new Error("not implemented")
  }
  /** Live keys, least-recently-used first → most-recently-used last. */
  keys(): K[] {
    throw new Error("not implemented")
  }
}
`

const lruTest = String.raw`import { test, expect } from "bun:test"
import { LruCache } from "./lruCache"

const clock = (start = 0) => {
  let t = start
  return { now: () => t, advance: (d: number) => { t += d } }
}

test("basic set/get/size", () => {
  const c = new LruCache<string, number>(3)
  c.set("a", 1)
  c.set("b", 2)
  expect(c.get("a")).toBe(1)
  expect(c.get("b")).toBe(2)
  expect(c.get("missing")).toBeUndefined()
  expect(c.size).toBe(2)
})

test("has is a pure peek — does not change recency", () => {
  const c = new LruCache<string, number>(2)
  c.set("a", 1)
  c.set("b", 2)
  c.has("a")        // peek must NOT make 'a' most-recently-used
  c.set("c", 3)     // at capacity → evict LRU = 'a'
  expect(c.has("a")).toBe(false)
  expect(c.has("b")).toBe(true)
  expect(c.has("c")).toBe(true)
})

test("get refreshes recency, protecting from eviction", () => {
  const c = new LruCache<string, number>(2)
  c.set("a", 1)
  c.set("b", 2)
  expect(c.get("a")).toBe(1)   // 'a' now MRU
  c.set("c", 3)                // evict LRU = 'b'
  expect(c.has("a")).toBe(true)
  expect(c.has("b")).toBe(false)
  expect(c.has("c")).toBe(true)
})

test("updating an existing key refreshes value and recency", () => {
  const c = new LruCache<string, number>(2)
  c.set("a", 1)
  c.set("b", 2)
  c.set("a", 10)               // update + move to MRU
  expect(c.get("a")).toBe(10)
  expect(c.size).toBe(2)
  c.set("c", 3)                // evict LRU = 'b'
  expect(c.has("b")).toBe(false)
  expect(c.has("a")).toBe(true)
})

test("keys() returns live keys least-recently-used first", () => {
  const c = new LruCache<string, number>(3)
  c.set("a", 1)
  c.set("b", 2)
  c.set("c", 3)
  c.get("a")  // order LRU→MRU becomes b, c, a
  expect(c.keys()).toEqual(["b", "c", "a"])
})

test("ttl: entry expires once now >= insertedAt + ttl", () => {
  const k = clock()
  const c = new LruCache<string, number>(3, { now: k.now })
  c.set("a", 1, 1000)
  k.advance(999)
  expect(c.get("a")).toBe(1)
  k.advance(1)               // now = 1000 = 0 + 1000 → expired
  expect(c.get("a")).toBeUndefined()
  expect(c.size).toBe(0)
})

test("defaultTtlMs applies when no per-entry ttl is given", () => {
  const k = clock()
  const c = new LruCache<string, number>(3, { now: k.now, defaultTtlMs: 500 })
  c.set("a", 1)
  k.advance(500)
  expect(c.has("a")).toBe(false)
})

test("per-entry ttl overrides the default", () => {
  const k = clock()
  const c = new LruCache<string, number>(3, { now: k.now, defaultTtlMs: 500 })
  c.set("a", 1, 2000)
  k.advance(1000)
  expect(c.get("a")).toBe(1)
})

test("no ttl and no default ⇒ never expires", () => {
  const k = clock()
  const c = new LruCache<string, number>(3, { now: k.now })
  c.set("a", 1)
  k.advance(1_000_000)
  expect(c.get("a")).toBe(1)
})

test("expired entries are purged and do not occupy capacity", () => {
  const k = clock()
  const c = new LruCache<string, number>(2, { now: k.now })
  c.set("a", 1, 100)
  c.set("b", 2)              // no ttl
  k.advance(100)             // 'a' is now expired
  c.set("c", 3)              // purge expired first ⇒ room ⇒ 'b' is NOT evicted
  expect(c.has("a")).toBe(false)
  expect(c.has("b")).toBe(true)
  expect(c.has("c")).toBe(true)
  expect(c.size).toBe(2)
})

test("updating a key resets its ttl", () => {
  const k = clock()
  const c = new LruCache<string, number>(3, { now: k.now })
  c.set("a", 1, 1000)
  k.advance(900)
  c.set("a", 2, 1000)        // new expiry = 900 + 1000 = 1900
  k.advance(900)             // now = 1800 < 1900
  expect(c.get("a")).toBe(2)
})

test("delete and clear", () => {
  const c = new LruCache<string, number>(3)
  c.set("a", 1)
  c.set("b", 2)
  expect(c.delete("a")).toBe(true)
  expect(c.delete("a")).toBe(false)
  expect(c.has("a")).toBe(false)
  expect(c.size).toBe(1)
  c.clear()
  expect(c.size).toBe(0)
  expect(c.has("b")).toBe(false)
})

test("eviction picks the true LRU after mixed operations", () => {
  const c = new LruCache<string, number>(3)
  c.set("a", 1)
  c.set("b", 2)
  c.set("c", 3)   // LRU→MRU: a, b, c
  c.get("a")      // → b, c, a
  c.set("b", 20)  // update → c, a, b
  c.set("d", 4)   // evict LRU = c
  expect(c.has("c")).toBe(false)
  expect(c.keys()).toEqual(["a", "b", "d"])
})
`

const lruPrompt = `Implement the LruCache class in lruCache.ts (the file has a typed stub with unimplemented bodies — fill them in). It is a fixed-capacity, least-recently-used cache with optional per-entry time-to-live. Implement EXACTLY this behaviour:

Construction
- new LruCache(capacity, options?). options.defaultTtlMs is the TTL applied to entries set without an explicit ttl (omitted ⇒ those entries never expire). options.now is an injectable clock returning ms (defaults to Date.now) — read the time only through it.

Recency
- get(key) returns the value and marks the key most-recently-used (MRU).
- has(key) is a pure peek: it returns whether the key is present and live, and must NOT change recency.
- set on an existing key updates its value and marks it MRU.
- keys() returns the live keys ordered least-recently-used FIRST, most-recently-used LAST.

Capacity / eviction (on set of a NEW key)
- First purge expired entries; then if the cache is at capacity, evict the single least-recently-used live entry; then insert the new key as MRU.
- Updating an existing key never evicts another entry.

TTL / expiry
- An entry is expired once now() >= insertedAt + ttl, where ttl is the per-entry ttlMs if given, else defaultTtlMs, else infinite (never expires).
- set records insertedAt = now() and resets the entry's ttl (so updating a key restarts its clock).
- Expired entries read as absent: get returns undefined, has returns false, and they are removed lazily on access. size and keys reflect only live entries (and purge expired ones).

Other
- delete(key) removes the entry and returns whether it existed. clear() empties the cache. size is the count of live entries.

Keep the implementation tightly scoped to lruCache.ts.`

// ───────────────────────── 2 · RFC-4180 CSV parser ─────────────────────────

const csvStub = String.raw`/** Parse RFC-4180-style CSV text into an array of records, each an array of string fields. */
export const parseCsv = (input: string): string[][] => {
  throw new Error("not implemented")
}
`

const csvTest = String.raw`import { test, expect } from "bun:test"
import { parseCsv } from "./csv"

test("empty input ⇒ no records", () => {
  expect(parseCsv("")).toEqual([])
})

test("single field", () => {
  expect(parseCsv("a")).toEqual([["a"]])
})

test("simple row", () => {
  expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]])
})

test("multiple rows (LF)", () => {
  expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]])
})

test("CRLF line endings", () => {
  expect(parseCsv("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]])
})

test("a single trailing LF does not add a record", () => {
  expect(parseCsv("a,b\n")).toEqual([["a", "b"]])
})

test("a single trailing CRLF does not add a record", () => {
  expect(parseCsv("a\r\n")).toEqual([["a"]])
})

test("empty fields are preserved", () => {
  expect(parseCsv("a,,c")).toEqual([["a", "", "c"]])
})

test("a line of only commas ⇒ all-empty fields", () => {
  expect(parseCsv(",,")).toEqual([["", "", ""]])
})

test("an empty line in the middle ⇒ a record with one empty field", () => {
  expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]])
})

test("whitespace is significant (not trimmed)", () => {
  expect(parseCsv(" a , b ")).toEqual([[" a ", " b "]])
})

test("quoted field containing a comma", () => {
  expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]])
})

test("quoted field containing a newline", () => {
  expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]])
})

test("escaped quotes inside a quoted field", () => {
  expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']])
})

test("quoted empty field", () => {
  expect(parseCsv('"",a')).toEqual([["", "a"]])
})

test("quoted field then a new record", () => {
  expect(parseCsv('"a,b"\nc')).toEqual([["a,b"], ["c"]])
})

test("CRLF inside a quoted field is preserved literally", () => {
  expect(parseCsv('"a\r\nb"')).toEqual([["a\r\nb"]])
})

test("a realistic mixed document", () => {
  expect(parseCsv('name,note\n"Smith, J.","said ""ok"""\nDoe,plain')).toEqual([
    ["name", "note"],
    ["Smith, J.", 'said "ok"'],
    ["Doe", "plain"],
  ])
})
`

const csvPrompt = `Implement parseCsv in csv.ts (the file has a typed stub — fill it in). It parses RFC-4180-style CSV text into an array of records, each an array of string fields. Implement EXACTLY this behaviour:

Structure
- Fields are separated by commas. Records are separated by line breaks, where a line break is either "\\n" (LF) or "\\r\\n" (CRLF).
- Empty input returns [] (no records). Empty fields are preserved: "a,,c" → [["a","","c"]].
- Whitespace is significant — never trim fields.

Trailing / empty lines
- A SINGLE line break at the very end of the input is a record terminator and does NOT produce an extra trailing empty record: "a,b\\n" → [["a","b"]].
- An empty line that is NOT the final terminator produces a record with one empty field: "a\\n\\nb" → [["a"],[""],["b"]].

Quoting (a field is "quoted" when its first character is a double quote)
- Inside a quoted field, commas, "\\n", and "\\r" are literal characters (part of the field), not separators — preserve them exactly, CRLF included.
- Inside a quoted field, a literal double quote is written as two double quotes (""), which decode to a single ". The field ends at the next unescaped double quote.
- An unquoted field is read literally up to the next comma or line break (any quote characters in it are ordinary characters).

Keep the implementation tightly scoped to csv.ts.`

// ──────────────────── 3 · nested-transaction KV store ────────────────────

const txStub = String.raw`/** An in-memory key/value store with nestable transactions (begin/commit/rollback). */
export class TxStore<V = unknown> {
  /** Effective value for key in the current view (innermost transaction layered over the committed state); undefined if absent or deleted in-view. */
  get(key: string): V | undefined {
    throw new Error("not implemented")
  }
  has(key: string): boolean {
    throw new Error("not implemented")
  }
  /** Write into the innermost active transaction, or the base store if none is active. */
  set(key: string, value: V): void {
    throw new Error("not implemented")
  }
  /** Delete in the innermost active transaction (a tombstone), or the base store if none is active. */
  delete(key: string): void {
    throw new Error("not implemented")
  }
  /** Keys with an effective value in the current view, sorted ascending. */
  keys(): string[] {
    throw new Error("not implemented")
  }
  /** Begin a (nestable) transaction. */
  begin(): void {
    throw new Error("not implemented")
  }
  /** Commit the innermost transaction, merging its writes into the enclosing scope. Throws if none is active. */
  commit(): void {
    throw new Error("not implemented")
  }
  /** Discard the innermost transaction's writes. Throws if none is active. */
  rollback(): void {
    throw new Error("not implemented")
  }
  /** Number of currently active (uncommitted) transactions. */
  get depth(): number {
    throw new Error("not implemented")
  }
}
`

const txTest = String.raw`import { test, expect } from "bun:test"
import { TxStore } from "./txStore"

test("base get/set/has/delete with no transaction", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  expect(s.get("a")).toBe(1)
  expect(s.has("a")).toBe(true)
  expect(s.get("b")).toBeUndefined()
  s.delete("a")
  expect(s.has("a")).toBe(false)
  expect(s.get("a")).toBeUndefined()
})

test("keys are sorted ascending and exclude deleted", () => {
  const s = new TxStore<number>()
  s.set("c", 3)
  s.set("a", 1)
  s.set("b", 2)
  expect(s.keys()).toEqual(["a", "b", "c"])
  s.delete("b")
  expect(s.keys()).toEqual(["a", "c"])
})

test("depth tracks begin/commit/rollback", () => {
  const s = new TxStore()
  expect(s.depth).toBe(0)
  s.begin()
  expect(s.depth).toBe(1)
  s.begin()
  expect(s.depth).toBe(2)
  s.commit()
  expect(s.depth).toBe(1)
  s.rollback()
  expect(s.depth).toBe(0)
})

test("commit with no active transaction throws", () => {
  const s = new TxStore()
  expect(() => s.commit()).toThrow()
})

test("rollback with no active transaction throws", () => {
  const s = new TxStore()
  expect(() => s.rollback()).toThrow()
})

test("writes inside a transaction are isolated until commit; rollback reverts", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.begin()
  s.set("a", 2)
  s.set("b", 3)
  expect(s.get("a")).toBe(2)
  expect(s.get("b")).toBe(3)
  s.rollback()
  expect(s.get("a")).toBe(1)
  expect(s.has("b")).toBe(false)
})

test("commit merges transaction writes into the base", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.begin()
  s.set("a", 2)
  s.set("b", 3)
  s.commit()
  expect(s.get("a")).toBe(2)
  expect(s.get("b")).toBe(3)
  expect(s.depth).toBe(0)
})

test("delete inside a transaction tombstones a base key until rollback", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.begin()
  s.delete("a")
  expect(s.has("a")).toBe(false)
  expect(s.keys()).toEqual([])
  s.rollback()
  expect(s.get("a")).toBe(1)
})

test("a committed delete removes the base key", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.set("b", 2)
  s.begin()
  s.delete("a")
  s.commit()
  expect(s.has("a")).toBe(false)
  expect(s.keys()).toEqual(["b"])
})

test("nested transactions layer correctly", () => {
  const s = new TxStore<number>()
  s.set("x", 0)
  s.begin()        // L1
  s.set("x", 1)
  s.begin()        // L2
  s.set("x", 2)
  expect(s.get("x")).toBe(2)
  s.rollback()     // discard L2
  expect(s.get("x")).toBe(1)
  s.commit()       // L1 → base
  expect(s.get("x")).toBe(1)
  expect(s.depth).toBe(0)
})

test("an inner commit propagates to the outer tx, not the base, until the outer commits", () => {
  const s = new TxStore<number>()
  s.set("x", 0)
  s.begin()        // L1
  s.begin()        // L2
  s.set("x", 9)
  s.commit()       // L2 → L1
  expect(s.depth).toBe(1)
  expect(s.get("x")).toBe(9)
  s.rollback()     // discard L1 (which now carries x=9 from L2)
  expect(s.get("x")).toBe(0)
})

test("delete then set within the same transaction", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.begin()
  s.delete("a")
  expect(s.has("a")).toBe(false)
  s.set("a", 5)
  expect(s.get("a")).toBe(5)
  s.commit()
  expect(s.get("a")).toBe(5)
})

test("keys reflect the layered view with tombstones", () => {
  const s = new TxStore<number>()
  s.set("a", 1)
  s.set("b", 2)
  s.begin()
  s.delete("a")
  s.set("c", 3)
  expect(s.keys()).toEqual(["b", "c"])
  s.commit()
  expect(s.keys()).toEqual(["b", "c"])
})
`

const txPrompt = `Implement the TxStore class in txStore.ts (the file has a typed stub — fill in the bodies). It is an in-memory key/value store with NESTABLE transactions. Implement EXACTLY this behaviour:

Model
- There is a committed base store plus a stack of active transaction layers. depth is the number of active (uncommitted) layers.
- set/delete apply to the innermost active layer, or directly to the base store when depth is 0. A delete records a tombstone in that layer (the key reads as absent in-view even if a lower layer or the base holds it).

Reads (the current view = innermost layer down to base)
- get(key) / has(key) resolve the key by searching from the innermost layer down to the base; the first layer that has an entry for the key wins. If that entry is a tombstone, the key reads as absent.
- keys() returns, sorted ascending, every key with an effective (non-tombstoned) value in the current view.

Transactions
- begin() pushes a new empty layer.
- commit() merges the innermost layer's writes (both sets AND tombstones) into the enclosing scope (the layer below, or the base if it was the only layer), then pops it. An inner commit therefore makes its changes visible to the outer transaction but NOT to the base until the outer also commits.
- rollback() pops and discards the innermost layer, reverting all of its writes.
- commit() and rollback() throw an Error when no transaction is active (depth 0).

Keep the implementation tightly scoped to txStore.ts.`

export const FEATURES: ReadonlyArray<FeatureScenario> = [
  {
    name: "feature · LRU cache with per-entry TTL",
    files: { "lruCache.ts": lruStub },
    prompt: lruPrompt,
    hiddenTests: { "lruCache.spec.ts": lruTest },
    readback: ["lruCache.ts"],
    rubric:
      "lruCache.ts implements a correct fixed-capacity LRU cache with TTL. Critical behaviours: get refreshes recency but has does NOT; eviction removes the true least-recently-used live entry; expiry uses the injected clock (now >= insertedAt + ttl) with per-entry ttl overriding defaultTtlMs and no-ttl meaning never-expires; expired entries are purged lazily and excluded from size/keys; updating a key resets its ttl and recency; keys() is ordered LRU-first. Penalise any missing edge case (recency-on-has, expiry purging freeing capacity, ttl reset on update). Implementation stays scoped to lruCache.ts.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 18 },
  },
  {
    name: "feature · RFC-4180 CSV parser",
    files: { "csv.ts": csvStub },
    prompt: csvPrompt,
    hiddenTests: { "csv.spec.ts": csvTest },
    readback: ["csv.ts"],
    rubric:
      "csv.ts implements a correct RFC-4180 CSV parser. Critical behaviours: comma field separation; LF and CRLF record separation; a single trailing line break does NOT add an empty record but a mid-document empty line yields [\"\"]; empty fields preserved; whitespace significant; quoted fields where commas/newlines are literal; doubled quotes (\"\") decode to one quote; CRLF preserved literally inside quotes. Penalise any unhandled quoting/escaping/line-ending edge case. Scoped to csv.ts.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 18 },
  },
  {
    name: "feature · nested-transaction KV store",
    files: { "txStore.ts": txStub },
    prompt: txPrompt,
    hiddenTests: { "txStore.spec.ts": txTest },
    readback: ["txStore.ts"],
    rubric:
      "txStore.ts implements a correct nestable-transaction KV store. Critical behaviours: layered view (innermost layer down to base); set/delete target the innermost layer; delete is a tombstone that hides lower values in-view; commit merges the innermost layer (sets AND tombstones) into the enclosing scope so an inner commit reaches the outer tx but not the base until the outer commits; rollback discards the layer; commit/rollback throw when no tx is active; keys() reflects the layered view sorted ascending. Penalise missing tombstone handling, wrong commit propagation, or absent error-on-no-tx. Scoped to txStore.ts.",
    routing: { shouldDelegate: true, codingTier: "code" },
    budget: { maxSteps: 22 },
  },
]
