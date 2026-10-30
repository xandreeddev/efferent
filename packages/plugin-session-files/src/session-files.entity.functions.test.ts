import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Option, Result } from "effect"
import { ConversationId } from "@xandreed/core"
import type { SessionHead, SessionListQuery } from "@xandreed/core"
import { PublishNonce } from "./session-files.entity.js"
import type { CommitRecord, StoreHealth } from "./session-files.entity.js"
import { admitCall, afterCall, crc32Of, decodeCommit, encodeCommit, isSessionDirectory, page, revisionFile, revisionOfFile, revisionOfTemporary, tailVerdict } from "./session-files.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000a1")
const record = (events: number, data: Record<string, unknown> = {}): CommitRecord => ({
  meta: { layout: 1, session, revision: 3, first: 5, last: 4 + events, at: 1_767_225_600_000, kinds: events > 0 ? ["note"] : [], nonce: PublishNonce.make("nonce-1") },
  state: { count: events, nested: { list: [1, "two", null], text: "ü ✓" } },
  events: Array.from({ length: events }, (_, n) => ({ seq: 5 + n, turn: n % 2 === 0 ? null : n, kind: "note", data: { n, ...data } })),
})

describe("crc32Of", () => {
  test("is IEEE 802.3's CRC-32", () => {
    expect(crc32Of(new TextEncoder().encode("123456789"))).toBe("cbf43926")
    expect(crc32Of(new Uint8Array())).toBe("00000000")
  })
})

describe("a commit file", () => {
  test("decodes to the commit it was encoded from, without events or with many", () => {
    expect(decodeCommit(encodeCommit(record(0)))).toEqual(Result.succeed(record(0)))
    expect(decodeCommit(encodeCommit(record(3, { text: "a\nb" })))).toEqual(Result.succeed(record(3, { text: "a\nb" })))
  })

  test("cut anywhere short of its end is never read as a commit", () => {
    const bytes = encodeCommit(record(4, { text: "long enough to cut in many places" }))
    fc.assert(fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), (length) => {
      expect(Result.isFailure(decodeCommit(bytes.subarray(0, length)))).toBe(true)
    }))
  })

  test("with any byte changed is never read as the commit it was", () => {
    const original = record(2)
    const bytes = encodeCommit(original)
    fc.assert(fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, delta) => {
      const changed = Uint8Array.from(bytes)
      changed[at] = ((changed[at] ?? 0) + delta) % 256
      const decoded = decodeCommit(changed)
      expect(Result.isFailure(decoded) || JSON.stringify(Result.getOrThrow(decoded)) !== JSON.stringify(original)).toBe(true)
    }))
  })

  test("a damaged tail is set aside, damage before it is not repaired", () => {
    expect(tailVerdict(Result.fail("short"), true)).toEqual({ _tag: "Quarantine", damage: "short" })
    expect(tailVerdict(Result.fail("checksum"), false)).toEqual({ _tag: "Corrupt", damage: "checksum" })
    expect(tailVerdict(Result.succeed(record(1)), true)).toEqual({ _tag: "Intact" })
  })
})

describe("names", () => {
  test("a revision's file name sorts as its number does and reads back; other names are no revision", () => {
    expect([revisionFile(1), revisionFile(10), revisionFile(9)].sort()).toEqual([revisionFile(1), revisionFile(9), revisionFile(10)])
    expect([revisionOfFile(revisionFile(42)), revisionOfFile("000000000042.jsonl.tmp"), revisionOfFile("42.jsonl")]).toEqual([Option.some(42), Option.none(), Option.none()])
  })

  test("a temporary commit file names the revision it was written for; a published one, or another name, names none", () => {
    expect([revisionOfTemporary(`${revisionFile(7)}.3f2a`), revisionOfTemporary(revisionFile(7)), revisionOfTemporary("link-probe.1")]).toEqual([Option.some(7), Option.none(), Option.none()])
  })

  test("only a session's id names a session's directory: an editor's or a network file system's leftovers do not", () => {
    expect([session, ".nfs0000000123", "notes.txt", `${session}.swp`].map(isSessionDirectory)).toEqual([true, false, false, false])
  })
})

describe("page", () => {
  const head = (id: string, updatedAt: number): SessionHead => ({
    header: { id: ConversationId.make(id), owner: "o", origin: "user", createdAt: 0, meta: {}, parent: Option.none() }, seq: 0, revision: 0, state: {}, updatedAt, now: 0,
  })
  const a = head("00000000-0000-4000-8000-00000000000a", 5)
  const b = head("00000000-0000-4000-8000-00000000000b", 5)
  const c = head("00000000-0000-4000-8000-00000000000c", 9)
  const query = (limit: number, before: SessionListQuery["before"] = Option.none()): SessionListQuery => ({ owner: "o", limit, before, parent: Option.none() })

  test("is the newest first, then by id descending, after the cursor, at most the limit", () => {
    expect(page([a, b, c], query(10)).map((found) => found.header.id)).toEqual([c.header.id, b.header.id, a.header.id])
    expect(page([a, b, c], query(1, Option.some({ updatedAt: 5, id: b.header.id }))).map((found) => found.header.id)).toEqual([a.header.id])
    expect(page([a, b, c], query(0))).toEqual([])
  })
})

describe("the store's health", () => {
  test("a stall fails every call at once, until one is let through a stallMs later; an answer heals it", () => {
    const healthy: StoreHealth = { _tag: "Healthy" }
    const stalled = afterCall(healthy, false, 1_000)
    expect(admitCall(healthy, 1_000, 500)).toEqual([true, healthy])
    expect(admitCall(stalled, 1_200, 500)[0]).toBe(false)
    const [probe, probing] = admitCall(stalled, 1_500, 500)
    expect([probe, admitCall(probing, 1_600, 500)[0]]).toEqual([true, false])
    expect(afterCall(probing, true, 1_700)).toEqual(healthy)
    expect(afterCall(probing, false, 1_700)).toEqual({ _tag: "Stalled", since: 1_700, probing: false })
  })
})
