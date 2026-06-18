import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SettingsStore } from "@xandreed/sdk-core"
import { LocalFileSystemLive } from "../fileSystem/local.js"
import { LocalSettingsStoreLive } from "./local.js"

/**
 * Regression: the old `load()` merged configs by hand-enumerating fields, so
 * any field it forgot (approvedBashRules, theme, subAgentTokenBudget, …)
 * loaded as absent — and the next `update()` rewrote config.json WITHOUT it.
 * `:set` anything → unrelated settings silently vanished from the file.
 */

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eff-settings-"))
  mkdirSync(join(dir, ".efferent"), { recursive: true })
  writeFileSync(
    join(dir, ".efferent", "config.json"),
    JSON.stringify({
      allowBash: true,
      maxSteps: 80,
      model: "google:gemini-3.5-flash",
      theme: "tokyo-night",
      subAgentTokenBudget: 2_000_000,
      approvedBashRules: ["cmd:bun test"],
    }),
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const layer = () => LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive))

describe("LocalSettingsStore load/update round-trip", () => {
  test("every persisted field survives a load + unrelated update", async () => {
    const home = join(dir, "no-home")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        const loaded = yield* store.load(dir, home)
        const updated = yield* store.update((s) => ({ ...s, maxSteps: 99 }))
        return { loaded, updated }
      }).pipe(Effect.provide(layer())),
    )
    expect(result.loaded.theme).toBe("tokyo-night")
    expect(result.loaded.subAgentTokenBudget).toBe(2_000_000)
    expect(result.loaded.approvedBashRules).toEqual(["cmd:bun test"])
    // The update touched only maxSteps — nothing else may vanish on disk.
    const onDisk = JSON.parse(readFileSync(join(dir, ".efferent", "config.json"), "utf8"))
    expect(onDisk.maxSteps).toBe(99)
    expect(onDisk.theme).toBe("tokyo-night")
    expect(onDisk.subAgentTokenBudget).toBe(2_000_000)
    expect(onDisk.approvedBashRules).toEqual(["cmd:bun test"])
    expect(onDisk.allowBash).toBe(true)
  })
})

describe("config tiers (global ⊕ local) + scoped writes", () => {
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>

  test("local overrides global on read; global() ignores local", async () => {
    const home = mkdtempSync(join(tmpdir(), "eff-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "eff-cwd-"))
    mkdirSync(join(home, ".efferent"), { recursive: true })
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(home, ".efferent", "config.json"), JSON.stringify({ theme: "one-dark", maxSteps: 50 }))
    writeFileSync(join(cwd, ".efferent", "config.json"), JSON.stringify({ theme: "tokyo-night" }))

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        const merged = yield* store.load(cwd, home)
        const global = yield* store.global()
        return { merged, global }
      }).pipe(Effect.provide(layer())),
    )
    expect(out.merged.theme).toBe("tokyo-night") // local wins
    expect(out.merged.maxSteps).toBe(50) // from global (not in local)
    expect(out.global.theme).toBe("one-dark") // global tier alone
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  test("update(scope:'global') writes only the home file; default writes only local + a .gitignore", async () => {
    const home = mkdtempSync(join(tmpdir(), "eff-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "eff-cwd-"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.load(cwd, home)
        yield* store.update((s) => ({ ...s, theme: "efferent", onboarded: true }), "global")
        yield* store.update((s) => ({ ...s, theme: "tokyo-night" })) // default local
      }).pipe(Effect.provide(layer())),
    )
    const g = read(join(home, ".efferent", "config.json"))
    const l = read(join(cwd, ".efferent", "config.json"))
    expect(g.onboarded).toBe(true)
    expect(g.theme).toBe("efferent") // global write
    expect(l.theme).toBe("tokyo-night") // local override
    expect(l.onboarded).toBeUndefined() // global-only key didn't leak local
    // local write seeded a gitignore that ignores the personal files
    const ignore = readFileSync(join(cwd, ".efferent", ".gitignore"), "utf8")
    expect(ignore).toContain("config.json")
    expect(ignore).toContain("auth.json")
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  test("EFFERENT_HOME → single flat source; the cwd .efferent is ignored", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eff-sandbox-"))
    const cwd = mkdtempSync(join(tmpdir(), "eff-cwd-"))
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    // A stray local config that MUST be ignored in sandbox mode.
    writeFileSync(join(cwd, ".efferent", "config.json"), JSON.stringify({ theme: "tokyo-night" }))
    const prev = process.env.EFFERENT_HOME
    process.env.EFFERENT_HOME = sandbox
    try {
      const merged = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* SettingsStore
          const loaded = yield* store.load(cwd, "/nonexistent-home")
          yield* store.update((s) => ({ ...s, theme: "efferent" }), "local") // scope ignored
          return loaded
        }).pipe(Effect.provide(layer())),
      )
      expect(merged.theme).toBeUndefined() // the cwd's tokyo-night was NOT read
      // The write landed in the sandbox, not the cwd.
      expect(read(join(sandbox, ".efferent", "config.json")).theme).toBe("efferent")
      expect(read(join(cwd, ".efferent", "config.json")).theme).toBe("tokyo-night") // untouched
    } finally {
      if (prev === undefined) delete process.env.EFFERENT_HOME
      else process.env.EFFERENT_HOME = prev
      rmSync(sandbox, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
