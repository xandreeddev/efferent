import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EngineSettings } from "@xandreed/engine"
import { SMITH_MODEL_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { applySmithSettings } from "./smithSettings.js"

const run = (over: Partial<SmithRunConfig["models"]> = {}): SmithRunConfig =>
  ({
    models: {
      general: Option.none(),
      code: Option.none(),
      fast: Option.none(),
      ...over,
    },
  }) as SmithRunConfig

const empty = new EngineSettings({
  model: Option.none(),
  codeModel: Option.none(),
  fastModel: Option.none(),
})

describe("applySmithSettings — flags > user config > smith defaults", () => {
  test("nothing configured, the smith defaults fill every role", () => {
    const out = applySmithSettings(empty, run())
    expect(Option.getOrThrow(out.model)).toBe(SMITH_MODEL_DEFAULTS.general)
    expect(Option.getOrThrow(out.codeModel)).toBe(SMITH_MODEL_DEFAULTS.code)
    expect(Option.getOrThrow(out.fastModel)).toBe(SMITH_MODEL_DEFAULTS.fast)
  })

  test("user config beats the smith default", () => {
    const configured = new EngineSettings({
      model: Option.some("google:gemini-3.5-flash"),
      codeModel: Option.none(),
      fastModel: Option.none(),
    })
    const out = applySmithSettings(configured, run())
    expect(Option.getOrThrow(out.model)).toBe("google:gemini-3.5-flash")
    expect(Option.getOrThrow(out.codeModel)).toBe(SMITH_MODEL_DEFAULTS.code)
  })

  test("a CLI flag beats everything", () => {
    const configured = new EngineSettings({
      model: Option.some("google:gemini-3.5-flash"),
      codeModel: Option.some("google:gemini-3.5-pro"),
      fastModel: Option.none(),
    })
    const out = applySmithSettings(
      configured,
      run({ general: Option.some("anthropic:claude-sonnet-5") }),
    )
    expect(Option.getOrThrow(out.model)).toBe("anthropic:claude-sonnet-5")
    expect(Option.getOrThrow(out.codeModel)).toBe("google:gemini-3.5-pro")
  })
})
