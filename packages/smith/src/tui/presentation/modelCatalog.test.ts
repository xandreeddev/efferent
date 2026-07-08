import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EngineSettings } from "@xandreed/engine"
import { SMITH_MODEL_DEFAULTS } from "../../domain/SmithConfig.js"
import { customRow, modelPickerOptions } from "./modelCatalog.js"

const settings = new EngineSettings({
  model: Option.some(SMITH_MODEL_DEFAULTS.general),
  codeModel: Option.some(SMITH_MODEL_DEFAULTS.code),
  fastModel: Option.none(),
})

describe("modelCatalog — the curated picker rows", () => {
  test("the current selection is pre-highlighted", () => {
    const rows = modelPickerOptions("general", settings)
    const active = rows.filter((r) => r.active === true)
    expect(active).toHaveLength(1)
    expect(active[0]?.label).toBe(SMITH_MODEL_DEFAULTS.general)
  })

  test("code/fast get a default row (value None); general does not", () => {
    const code = modelPickerOptions("code", settings)
    expect(code[0]?.label).toContain("default (smith default:")
    expect(Option.isNone(code[0]!.value)).toBe(true)
    const general = modelPickerOptions("general", settings)
    expect(general[0]?.label).not.toContain("default")
  })

  test("customRow synthesizes a row only for provider:modelId shapes", () => {
    expect(customRow("opencode:some-new-model")).toHaveLength(1)
    expect(Option.getOrThrow(customRow("a:b")[0]!.value)).toBe("a:b")
    expect(customRow("plain words")).toHaveLength(0)
    expect(customRow(":nope")).toHaveLength(0)
    expect(customRow("nope:")).toHaveLength(0)
  })
})
