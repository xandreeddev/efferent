import { describe, expect, test } from "bun:test"
import {
  cachePercent,
  contextPercent,
  formatTokens,
  gaugeSeverity,
  rolesChip,
} from "./statusBar.js"

describe("context + cache clarity helpers", () => {
  test("contextPercent: whole percent; undefined without a window", () => {
    expect(contextPercent(120_000, 1_000_000)).toBe(12)
    expect(contextPercent(0, 1_000_000)).toBe(0)
    expect(contextPercent(50_000, 0)).toBeUndefined()
  })

  test("gaugeSeverity: ok < 70% ≤ warn < 90% ≤ critical", () => {
    expect(gaugeSeverity(69, 100)).toBe("ok")
    expect(gaugeSeverity(70, 100)).toBe("warn")
    expect(gaugeSeverity(89, 100)).toBe("warn")
    expect(gaugeSeverity(90, 100)).toBe("critical")
    expect(gaugeSeverity(50, 0)).toBe("ok") // unknown window never shouts
  })

  test("cachePercent: share of the last turn's input; clamped; undefined pre-run", () => {
    expect(cachePercent(860, 1000)).toBe(86)
    expect(cachePercent(0, 1000)).toBe(0)
    expect(cachePercent(2000, 1000)).toBe(100)
    expect(cachePercent(500, 0)).toBeUndefined()
  })

  test("rolesChip shows each configured role's model id (legacy utilityModel = cheap)", () => {
    expect(rolesChip({})).toBeUndefined()
    expect(rolesChip({ fastModel: "google:gemini-3.5-flash" })).toBe("fast gemini-3.5-flash")
    expect(rolesChip({ cheapModel: "openai:gpt-5.4-nano" })).toBe("cheap gpt-5.4-nano")
    expect(rolesChip({ utilityModel: "openai:gpt-5.4-nano" })).toBe("cheap gpt-5.4-nano")
    expect(rolesChip({ fastModel: "google:gemini-3.1-flash-lite", cheapModel: "openai:gpt-5.4-nano" })).toBe(
      "fast gemini-3.1-flash-lite · cheap gpt-5.4-nano",
    )
  })

  test("formatTokens stays stable (the gauges depend on it)", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(18_400)).toBe("18k")
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })
})
