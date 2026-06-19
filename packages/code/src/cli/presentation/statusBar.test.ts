import { describe, expect, test } from "bun:test"
import {
  cachePercent,
  contextPercent,
  formatTokens,
  gaugeSeverity,
  rolesChip,
  statusHint,
} from "./statusBar.js"

describe("statusHint (status-bar left zone)", () => {
  const base = { busy: false, overlayOpen: false, queuedCount: 0 } as const
  test("rests on '? for shortcuts'", () => {
    expect(statusHint(base)).toBe("? for shortcuts")
  })
  test("a running turn or open overlay offers 'esc to cancel'", () => {
    expect(statusHint({ ...base, busy: true })).toBe("esc to cancel")
    expect(statusHint({ ...base, overlayOpen: true })).toBe("esc to cancel")
  })
  test("a pending queue offers '↑ to edit queued' (over cancel)", () => {
    expect(statusHint({ ...base, busy: true, queuedCount: 2 })).toBe("↑ to edit queued")
  })
  test("composing a :command / /search line reads 'esc to cancel' (not idle)", () => {
    expect(statusHint({ ...base, composing: true })).toBe("esc to cancel")
    // …but a queued message or a live note still win over the composing hint.
    expect(statusHint({ ...base, composing: true, queuedCount: 1 })).toBe("↑ to edit queued")
    expect(statusHint({ ...base, composing: true, note: "theme: efferent" })).toBe("theme: efferent")
  })
  test("a live note wins over everything", () => {
    expect(statusHint({ ...base, busy: true, queuedCount: 1, note: "theme: tokyo-night" })).toBe(
      "theme: tokyo-night",
    )
  })
})

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

  test("rolesChip shows the configured fast role's model id", () => {
    expect(rolesChip({})).toBeUndefined()
    expect(rolesChip({ fastModel: "google:gemini-3.5-flash" })).toBe("fast gemini-3.5-flash")
    expect(rolesChip({ fastModel: "google:gemini-3.1-flash-lite" })).toBe("fast gemini-3.1-flash-lite")
  })

  test("formatTokens stays stable (the gauges depend on it)", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(18_400)).toBe("18k")
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })
})
