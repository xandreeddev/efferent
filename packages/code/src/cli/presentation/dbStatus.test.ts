import { describe, expect, it } from "bun:test"
import { describeActiveDatabase, storageLabel } from "./dbStatus.js"

describe("storageLabel — status-bar indicator", () => {
  it("unset → sqlite", () => expect(storageLabel(undefined)).toBe("sqlite"))
  it("a path → sqlite", () => expect(storageLabel("/data/conv.db")).toBe("sqlite"))
  it("sqlite:-prefixed → sqlite", () => expect(storageLabel("sqlite:/x.db")).toBe("sqlite"))
  it("postgres:// → pg", () =>
    expect(storageLabel("postgres://u:p@h/db")).toBe("pg"))
  it("postgresql:// (case-insensitive) → pg", () =>
    expect(storageLabel("POSTGRESQL://u:p@h/db")).toBe("pg"))
})

describe("describeActiveDatabase — :settings reflects the active store", () => {
  it("env unset → SQLite default", () => {
    const { line, overrideNote } = describeActiveDatabase(undefined, undefined)
    expect(line).toBe("database: SQLite ~/.efferent/efferent.db  (active · default)")
    expect(overrideNote).toBeUndefined()
  })

  it("env = postgres → reports Postgres with the password masked (the reported bug)", () => {
    const { line } = describeActiveDatabase(
      "postgres://agent:secret@localhost:5434/agent",
      undefined, // config.json has no dbUrl — the old code wrongly showed the SQLite default here
    )
    expect(line).toContain("Postgres")
    expect(line).toContain("postgres://agent:***@localhost:5434/agent")
    expect(line).not.toContain("secret")
    expect(line).toContain("from EFFERENT_DB_URL env")
    expect(line).not.toContain("efferent.db")
  })

  it("env = a SQLite path → reports that path (active, from env)", () => {
    const { line } = describeActiveDatabase("/data/conv.db", undefined)
    expect(line).toBe("database: SQLite /data/conv.db  (active · from EFFERENT_DB_URL env)")
  })

  it("env seeded from config (env === config dbUrl) → source is config.json", () => {
    const url = "postgres://u:p@h/db"
    const { line, overrideNote } = describeActiveDatabase(url, url)
    expect(line).toContain("from config.json")
    expect(overrideNote).toBeUndefined()
  })

  it("config dbUrl overridden by a different env value → headline is env, note flags the override", () => {
    const { line, overrideNote } = describeActiveDatabase(
      "postgres://u:p@prod/db",
      "/local.db",
    )
    expect(line).toContain("Postgres")
    expect(line).toContain("from EFFERENT_DB_URL env")
    expect(overrideNote).toBe(
      "  config.json dbUrl: /local.db (overridden by EFFERENT_DB_URL env)",
    )
  })
})
