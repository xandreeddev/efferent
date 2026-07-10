import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EngineSettings } from "@xandreed/engine"
import { SMITH_MODEL_DEFAULTS } from "../../domain/SmithConfig.js"
import { costOf, customRow, fmtCost, modelPickerOptions } from "./modelCatalog.js"

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

describe("costOf + fmtCost", () => {
  test("prices a turn at the family rate; cached reads bill at 10%", () => {
    // kimi-k2: $0.6/M in, $2.5/M out. 1M fresh input + 1M output = $3.10.
    const full = costOf("opencode:kimi-k2.6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
    })
    expect(Option.getOrThrow(full)).toBeCloseTo(3.1, 5)
    // Fully cached input: 10% of the input rate.
    const cached = costOf("opencode:kimi-k2.6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    })
    expect(Option.getOrThrow(cached)).toBeCloseTo(0.06, 5)
  })

  test("an unpriced model is None — never a made-up number", () => {
    expect(
      Option.isNone(
        costOf("nowhere:mystery-model", {
          inputTokens: 1000,
          outputTokens: 1000,
          cacheReadTokens: 0,
        }),
      ),
    ).toBe(true)
  })

  test("fmtCost: three digits under a dime, two above, floored visibly", () => {
    expect(fmtCost(1.239)).toBe("$1.24")
    expect(fmtCost(0.0412)).toBe("$0.041")
    expect(fmtCost(0.0004)).toBe("<$0.001")
  })
})
