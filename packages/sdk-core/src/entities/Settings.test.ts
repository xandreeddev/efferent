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
    fc.assert(
      fc.property(Arbitrary.make(Settings), (value) => {
        expect(decode(encode(value))).toEqual(value)
      }),
      { numRuns: 100 },
    )
  })
})
