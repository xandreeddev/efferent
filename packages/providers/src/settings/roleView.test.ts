import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { EngineSettings, SettingsStore } from "@xandreed/engine"
import { roleModelView } from "./roleView.js"

const inner = (settings: EngineSettings) =>
  Layer.succeed(SettingsStore, {
    load: Effect.succeed(settings),
    setRole: () => Effect.void,
    set: () => Effect.void,
  })

const loadThrough = (role: "code" | "fast", settings: EngineSettings): EngineSettings =>
  Effect.runSync(
    Effect.flatMap(SettingsStore, (s) => s.load).pipe(
      Effect.provide(roleModelView(role).pipe(Layer.provide(inner(settings)))),
      Effect.orDie,
    ),
  )

describe("roleModelView — the role-scoped settings view", () => {
  test("code role: model becomes codeModel when set", () => {
    const out = loadThrough(
      "code",
      new EngineSettings({
        model: Option.some("opencode:kimi-k2.6"),
        codeModel: Option.some("opencode:kimi-k2.7-code"),
        fastModel: Option.none(),
      }),
    )
    expect(Option.getOrThrow(out.model)).toBe("opencode:kimi-k2.7-code")
  })

  test("an unset role falls back to the general model", () => {
    const out = loadThrough(
      "code",
      new EngineSettings({
        model: Option.some("opencode:kimi-k2.6"),
        codeModel: Option.none(),
        fastModel: Option.none(),
      }),
    )
    expect(Option.getOrThrow(out.model)).toBe("opencode:kimi-k2.6")
  })

  test("fast role maps fastModel", () => {
    const out = loadThrough(
      "fast",
      new EngineSettings({
        model: Option.some("a:b"),
        codeModel: Option.none(),
        fastModel: Option.some("opencode:deepseek-v4-flash"),
      }),
    )
    expect(Option.getOrThrow(out.model)).toBe("opencode:deepseek-v4-flash")
  })
})
