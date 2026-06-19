import { describe, expect, it } from "bun:test"
import { Arbitrary, FastCheck as fc, Schema } from "effect"
import { maskDbUrl, Settings } from "./Settings.js"

const decodePartial = Schema.decodeUnknownSync(Schema.partial(Settings))

describe("Settings — optional dbUrl", () => {
  it("decodes a config.json carrying a postgres dbUrl", () => {
    const s = decodePartial({ dbUrl: "postgres://agent:agent@localhost:5434/agent" })
    expect(s.dbUrl).toBe("postgres://agent:agent@localhost:5434/agent")
  })

  it("decodes a config.json carrying a sqlite path dbUrl", () => {
    const s = decodePartial({ model: "google:gemini-3.5-flash", dbUrl: "/tmp/foo.db" })
    expect(s.dbUrl).toBe("/tmp/foo.db")
    expect(s.model).toBe("google:gemini-3.5-flash")
  })

  it("decodes a config.json with no dbUrl (field stays absent)", () => {
    const s = decodePartial({ maxSteps: 12 })
    expect(s.dbUrl).toBeUndefined()
    expect(s.maxSteps).toBe(12)
  })
})

describe("maskDbUrl", () => {
  it("masks the password in a postgres:// URL", () => {
    expect(maskDbUrl("postgres://agent:secret@localhost:5434/agent")).toBe(
      "postgres://agent:***@localhost:5434/agent",
    )
  })

  it("masks the password in a postgresql:// URL", () => {
    expect(maskDbUrl("postgresql://u:p@h/db")).toBe("postgresql://u:***@h/db")
  })

  it("passes a SQLite path through unchanged", () => {
    expect(maskDbUrl("/home/u/.efferent/efferent.db")).toBe(
      "/home/u/.efferent/efferent.db",
    )
  })

  it("passes a passwordless / odd value through unchanged", () => {
    expect(maskDbUrl("sqlite:/tmp/x.db")).toBe("sqlite:/tmp/x.db")
  })
})

describe("properties — encode/decode round-trip", () => {
  it("Settings survives encode→decode for any generated value", () => {
    // Covers all 22 fields incl. every optional and the five Literal enums.
    const encode = Schema.encodeSync(Settings)
    const decode = Schema.decodeUnknownSync(Settings)
    // A `__proto__` / `constructor` / `prototype` key in the `databases` record is
    // a fast-check edge case, not a real connection name: those keys can't survive
    // a plain-object round-trip (assigning them mutates the prototype chain rather
    // than creating an own enumerable key), so any decoder building a JS object
    // drops them. Skip those degenerate keys — everything else must round-trip.
    const DANGEROUS = new Set(["__proto__", "constructor", "prototype"])
    fc.assert(
      fc.property(Arbitrary.make(Settings), (value) => {
        const dbKeys = value.databases ? Object.keys(value.databases) : []
        if (dbKeys.some((k) => DANGEROUS.has(k))) return true
        expect(decode(encode(value))).toEqual(value)
        return true
      }),
      { numRuns: 100 },
    )
  })
})
