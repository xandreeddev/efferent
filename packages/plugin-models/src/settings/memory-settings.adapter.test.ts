import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { EngineSettings, SettingsStore } from "../ports/settings-store.port.js"
import { settingsStoreConformance } from "./settings-store.conformance.js"
import type { SettingsStoreSubject } from "./settings-store.conformance.js"
import { damagedFile } from "../testing.js"
import { LocalSettingsStoreLive } from "./localSettings.js"
import { MemorySettingsStoreLive } from "./memory-settings.adapter.js"

const runKit = (subject: SettingsStoreSubject) => settingsStoreConformance(subject).map((check) => test(check.name, async () => {
  const exit = await Effect.runPromise(Effect.result(check.run))
  expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
}))

describe("MemorySettingsStoreLive conforms to the SettingsStore contract", () => {
  runKit({ writable: true, open: () => Effect.service(SettingsStore).pipe(
    Effect.provide(MemorySettingsStoreLive(new EngineSettings({ model: Option.some("opencode:glm-5.1"), maxAttempts: Option.some(2) }))),
    Effect.map((store) => ({ store })),
  ) })
})

describe("LocalSettingsStoreLive conforms to the SettingsStore contract", () => {
  runKit({ writable: true, corrupt: true, open: () => Effect.gen(function* () {
    const directories = yield* Effect.acquireRelease(Effect.sync(() => ({
      home: mkdtempSync(join(tmpdir(), "efferent-settings-kit-home-")),
      cwd: mkdtempSync(join(tmpdir(), "efferent-settings-kit-cwd-")),
    })), ({ home, cwd }) => Effect.sync(() => [home, cwd].forEach((dir) => rmSync(dir, { recursive: true, force: true }))))
    const { home, cwd } = directories
    mkdirSync(join(home, ".efferent"), { recursive: true })
    writeFileSync(join(home, ".efferent", "config.json"), JSON.stringify({ model: "opencode:glm-5.1", budgetMillis: 30000 }))
    const store = yield* Effect.service(SettingsStore).pipe(Effect.provide(LocalSettingsStoreLive(cwd, home)))
    return { store, corruptions: [damagedFile(join(cwd, ".efferent", "config.json")), damagedFile(join(home, ".efferent", "config.json"))] }
  }) })
})

describe("MemorySettingsStoreLive", () => {
  test("starts at its initial settings and keeps writes for its lifetime", async () => {
    const settings = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* SettingsStore
      yield* store.setRole("fast", Option.some("opencode:deepseek-v4-flash"))
      yield* store.set("fallbackModel", Option.some("google:gemini-3.5-flash"))
      yield* store.set("maxAttempts", Option.some("4"))
      yield* store.set("budgetMillis", Option.some("600000"))
      yield* store.setRole("general", Option.none())
      return yield* store.load
    }).pipe(Effect.provide(MemorySettingsStoreLive(new EngineSettings({ model: Option.some("opencode:glm-5.1") })))))
    expect(Option.isNone(settings.model)).toBe(true)
    expect(Option.getOrThrow(settings.fastModel)).toBe("opencode:deepseek-v4-flash")
    expect(Option.getOrThrow(settings.fallbackModel)).toBe("google:gemini-3.5-flash")
    expect(Option.getOrThrow(settings.maxAttempts)).toBe(4)
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
