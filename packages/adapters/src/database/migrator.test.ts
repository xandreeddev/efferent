import { describe, expect, it } from "bun:test"
import { parseDbTarget } from "./migrator.js"

describe("parseDbTarget — EFFERENT_DB_URL interpretation", () => {
  it("unset → SQLite at the default ~/.efferent/efferent.db", () => {
    const t = parseDbTarget(undefined)
    expect(t.kind).toBe("sqlite")
    if (t.kind === "sqlite") expect(t.filename).toMatch(/\.efferent[/\\]efferent\.db$/)
  })

  it("empty / whitespace → SQLite default", () => {
    expect(parseDbTarget("")).toEqual(parseDbTarget(undefined))
    expect(parseDbTarget("   ")).toEqual(parseDbTarget(undefined))
  })

  it("postgres:// → Postgres", () => {
    expect(parseDbTarget("postgres://agent:agent@localhost:5434/agent")).toEqual({
      kind: "postgres",
    })
  })

  it("postgresql:// → Postgres (case-insensitive)", () => {
    expect(parseDbTarget("POSTGRESQL://u:p@h/db")).toEqual({ kind: "postgres" })
  })

  it("a bare path → SQLite at that path", () => {
    expect(parseDbTarget("/tmp/foo.db")).toEqual({
      kind: "sqlite",
      filename: "/tmp/foo.db",
    })
  })

  it("a sqlite:-prefixed path → SQLite, prefix stripped", () => {
    expect(parseDbTarget("sqlite:/tmp/bar.db")).toEqual({
      kind: "sqlite",
      filename: "/tmp/bar.db",
    })
    expect(parseDbTarget("sqlite:///tmp/baz.db")).toEqual({
      kind: "sqlite",
      filename: "/tmp/baz.db",
    })
  })
})
