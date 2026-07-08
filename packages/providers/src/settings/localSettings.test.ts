import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { SettingsStore } from "@xandreed/engine"
import { LocalSettingsStoreLive } from "./localSettings.js"

const setup = (global: Record<string, unknown>, local?: Record<string, unknown>) => {
  const home = mkdtempSync(join(tmpdir(), "engine-cfg-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "engine-cfg-cwd-"))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  writeFileSync(join(home, ".efferent", "config.json"), JSON.stringify(global))
  if (local !== undefined) {
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "config.json"), JSON.stringify(local))
  }
  return { layer: LocalSettingsStoreLive(cwd, home), cwd }
}

describe("LocalSettingsStoreLive", () => {
  test("reads the model roles, local-over-global", async () => {
    const { layer } = setup(
      { model: "opencode:kimi-k2.6", fastModel: "opencode:deepseek-v4-flash" },
      { model: "google:gemini-3.5-flash" },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        const settings = yield* store.load
        expect(Option.getOrThrow(settings.model)).toBe("google:gemini-3.5-flash")
        expect(Option.getOrThrow(settings.fastModel)).toBe("opencode:deepseek-v4-flash")
        expect(Option.isNone(settings.codeModel)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("setRole writes each role's key to the LOCAL config, preserving unrelated keys", async () => {
    const { layer, cwd } = setup({}, { theme: "efferent", telemetry: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setRole("general", Option.some("opencode:kimi-k2.6"))
        yield* store.setRole("code", Option.some("opencode:kimi-k2.7-code"))
        yield* store.setRole("fast", Option.some("opencode:deepseek-v4-flash"))
        const settings = yield* store.load
        expect(Option.getOrThrow(settings.model)).toBe("opencode:kimi-k2.6")
        expect(Option.getOrThrow(settings.codeModel)).toBe("opencode:kimi-k2.7-code")
        expect(Option.getOrThrow(settings.fastModel)).toBe("opencode:deepseek-v4-flash")
      }).pipe(Effect.provide(layer)),
    )
    const written = JSON.parse(
      readFileSync(join(cwd, ".efferent", "config.json"), "utf-8"),
    ) as Record<string, unknown>
    expect(written["theme"]).toBe("efferent")
    expect(written["telemetry"]).toBe(true)
    expect(written["model"]).toBe("opencode:kimi-k2.6")
    expect(written["codeModel"]).toBe("opencode:kimi-k2.7-code")
  })

  test("setRole None clears the key (the role falls back), others untouched", async () => {
    const { layer, cwd } = setup({}, { model: "opencode:kimi-k2.6", codeModel: "x:y" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setRole("code", Option.none())
        const settings = yield* store.load
        expect(Option.isNone(settings.codeModel)).toBe(true)
        expect(Option.getOrThrow(settings.model)).toBe("opencode:kimi-k2.6")
      }).pipe(Effect.provide(layer)),
    )
    const written = JSON.parse(
      readFileSync(join(cwd, ".efferent", "config.json"), "utf-8"),
    ) as Record<string, unknown>
    expect("codeModel" in written).toBe(false)
    expect(written["model"]).toBe("opencode:kimi-k2.6")
  })

  test("missing files → empty settings, no failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "engine-cfg-none-"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        const settings = yield* store.load
        expect(Option.isNone(settings.model)).toBe(true)
      }).pipe(Effect.provide(LocalSettingsStoreLive(home, home))),
    )
  })
})
