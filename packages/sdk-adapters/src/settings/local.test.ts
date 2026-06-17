import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SettingsStore } from "@efferent/sdk-core"
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
