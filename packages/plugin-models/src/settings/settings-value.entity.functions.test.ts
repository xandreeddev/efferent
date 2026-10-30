import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { EngineSettings } from "../ports/settings-store.port.js"
import type { SettingsKey } from "../ports/settings-store.port.js"
import { applyRole, applySetting, coerceSettingValue, recordOfSettings, settingsFromRecord } from "./settings-value.entity.functions.js"

describe("the settings vocabulary", () => {
  test("each key's string form coerces to its stored type, or is refused", () => {
    const table: ReadonlyArray<readonly [SettingsKey, string, Option.Option<unknown>]> = [
      ["fallbackModel", "google:gemini-3.5-flash", Option.some("google:gemini-3.5-flash")],
      ["fallbackModel", "not-a-selection", Option.none()],
      ["maxAttempts", "5", Option.some(5)],
      ["maxAttempts", "0", Option.none()],
      ["maxAttempts", "zero", Option.none()],
      ["budgetMillis", "-5", Option.none()],
      ["budgetMillis", "2.5", Option.none()],
      ["reasoningEffort", "xhigh", Option.some("xhigh")],
      ["codeReasoningEffort", "extreme", Option.none()],
    ]
    expect(table.map(([key, raw]) => {
      const exit = Effect.runSyncExit(coerceSettingValue(key, raw))
      return Exit.isSuccess(exit) ? Option.some<unknown>(exit.value) : Option.none<unknown>()
    })).toEqual(table.map(([, , expected]) => expected))
  })

  test("applySetting and applyRole change one field, and None clears it", () => {
    const start = new EngineSettings({ model: Option.some("opencode:glm-5.1"), budgetMillis: Option.some(60_000) })
    const changed = Effect.runSync(applySetting(start, "maxAttempts", Option.some("4")).pipe(
      Effect.flatMap((settings) => applySetting(settings, "budgetMillis", Option.none())),
      Effect.flatMap((settings) => applyRole(settings, "code", Option.some("opencode:kimi-k2.7-code"))),
    ))
    expect(recordOfSettings(changed)).toEqual({ model: "opencode:glm-5.1", codeModel: "opencode:kimi-k2.7-code", maxAttempts: 4 })
    expect(Exit.isFailure(Effect.runSyncExit(applyRole(start, "general", Option.some("opencode"))))).toBe(true)
  })

  test("a config record reads typed, values of the wrong type as unset, keys it does not name not at all, the legacy effort key as a fallback", () => {
    const settings = settingsFromRecord({ model: "a:b", fastModel: "", budgetMillis: "soon", maxAttempts: 3, openAiReasoningEffort: "low", theme: "dark", sandbox: true, viMode: true })
    expect(recordOfSettings(settings)).toEqual({ model: "a:b", maxAttempts: 3, reasoningEffort: "low" })
  })
})
