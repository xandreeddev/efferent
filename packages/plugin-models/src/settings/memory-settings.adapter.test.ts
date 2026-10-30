import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { EngineSettings, SettingsStore, settingsStoreConformance } from "@xandreed/core/models"
import type { SettingsStoreConformanceOptions } from "@xandreed/core/models"
import { damagedFile } from "../testing.js"
import { LocalSettingsStoreLive } from "./localSettings.js"
import { MemorySettingsStoreLive } from "./memory-settings.adapter.js"

const runKit = (store: typeof SettingsStore.Service, options: Partial<SettingsStoreConformanceOptions> = {}) => settingsStoreConformance(store, { writable: true, ...options }).map((check) => test(check.name, async () => {
  const exit = await Effect.runPromise(Effect.result(check.run))
  expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
}))

describe("MemorySettingsStoreLive conforms to the SettingsStore contract", () => {
  runKit(Effect.runSync(Effect.service(SettingsStore).pipe(Effect.provide(MemorySettingsStoreLive(new EngineSettings({ model: Option.some("opencode:glm-5.1"), maxAttempts: Option.some(2) }))))))
})

describe("LocalSettingsStoreLive conforms to the SettingsStore contract", () => {
  const home = mkdtempSync(join(tmpdir(), "efferent-settings-kit-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "efferent-settings-kit-cwd-"))
  afterAll(() => [home, cwd].map((dir) => rmSync(dir, { recursive: true, force: true })))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  // A global value under a local tier the kit writes: clearing the local key falls back to it.
  writeFileSync(join(home, ".efferent", "config.json"), JSON.stringify({ model: "opencode:glm-5.1", sandbox: false }))
  // The local file is the one the store writes: a write that ignored the damage would replace it.
  runKit(Effect.runSync(Effect.service(SettingsStore).pipe(Effect.provide(LocalSettingsStoreLive(cwd, home)))), { corrupt: damagedFile(join(cwd, ".efferent", "config.json")) })

  test("the kit puts every key back as it found it", () => {
    const local = JSON.parse(readFileSync(join(cwd, ".efferent", "config.json"), "utf8")) as Record<string, unknown>
    expect(local).toEqual({})
    expect(JSON.parse(readFileSync(join(home, ".efferent", "config.json"), "utf8"))).toEqual({ model: "opencode:glm-5.1", sandbox: false })
  })
})

describe("MemorySettingsStoreLive", () => {
  test("starts at its initial settings and keeps writes for its lifetime", async () => {
    const settings = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* SettingsStore
      yield* store.setRole("fast", Option.some("opencode:deepseek-v4-flash"))
      yield* store.set("fallbackModel", Option.some("google:gemini-3.5-flash"))
      yield* store.set("sandbox", Option.some("on"))
      yield* store.set("budgetMillis", Option.some("600000"))
      yield* store.setRole("general", Option.none())
      return yield* store.load
    }).pipe(Effect.provide(MemorySettingsStoreLive(new EngineSettings({ model: Option.some("opencode:glm-5.1") })))))
    expect(Option.isNone(settings.model)).toBe(true)
    expect(Option.getOrThrow(settings.fastModel)).toBe("opencode:deepseek-v4-flash")
    expect(Option.getOrThrow(settings.fallbackModel)).toBe("google:gemini-3.5-flash")
    expect(Option.getOrThrow(settings.sandbox)).toBe(true)
    expect(Option.getOrThrow(settings.budgetMillis)).toBe(600000)
  })

  test("refuses a value that does not parse and keeps the settings as they were", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* SettingsStore
      const role = yield* Effect.flip(store.setRole("general", Option.some("no-provider")))
      const key = yield* Effect.flip(store.set("maxAttempts", Option.some("0")))
      return { role, key, settings: yield* store.load }
    }).pipe(Effect.provide(MemorySettingsStoreLive(new EngineSettings({ model: Option.some("opencode:glm-5.1") })))))
    expect(result.role.message).toContain("general model must be")
    expect(result.key.message).toContain("maxAttempts must be a positive integer")
    expect(Option.getOrThrow(result.settings.model)).toBe("opencode:glm-5.1")
    expect(Option.isNone(result.settings.maxAttempts)).toBe(true)
  })
})
