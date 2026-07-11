import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { GateSuiteConfig } from "../domain/Rules.js"
import { effectPack, qualityPack } from "./rules/packs.js"
import { renderQualityBar } from "./renderQualityBar.js"

const decode = (raw: unknown): GateSuiteConfig =>
  Effect.runSync(Schema.decodeUnknown(GateSuiteConfig)(raw))

const registry = [...effectPack.rules, ...qualityPack.rules]

describe("renderQualityBar", () => {
  test("full form: header, one line per ARMED rule with fixHint, boundaries digest", () => {
    const config = decode({
      tsconfig: "tsconfig.json",
      rules: [
        { rule: "effect/no-let", include: ["src/**"] },
        { rule: "quality/no-skipped-tests", include: ["src/**"] },
      ],
      boundaries: {
        layers: [
          { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect"] },
          { name: "cli", path: "src/cli/**", canImport: ["domain"], externals: ["effect"] },
        ],
      },
    })
    const bar = Option.getOrThrow(renderQualityBar(config, registry))
    expect(bar.full).toContain("ARMED")
    expect(bar.full).toContain("write to these rules the first time")
    expect(bar.full).toContain("[effect/no-let] `let` and `var` are banned — fix:")
    expect(bar.full).toContain("[quality/no-skipped-tests]")
    // Unarmed registry rules never appear.
    expect(bar.full).not.toContain("effect/no-try-catch")
    expect(bar.full).toContain("domain may import: (nothing internal)")
    expect(bar.full).toContain("cli may import: domain")
    expect(bar.full.length).toBeLessThanOrEqual(2_500 + 30)
  })

  test("compact form: ids only, capped; judge form: descriptions + the evasion framing", () => {
    const config = decode({
      tsconfig: "tsconfig.json",
      rules: effectPack.rules.map((rule) => ({ rule: String(rule.id), include: ["src/**"] })),
    })
    const bar = Option.getOrThrow(renderQualityBar(config, registry))
    expect(bar.compact).toContain("effect/no-let · ")
    expect(bar.compact).not.toContain("fix:")
    expect(bar.compact.length).toBeLessThanOrEqual(800 + 30)
    expect(bar.judge).toContain("Standing quality contract")
    expect(bar.judge).toContain("do NOT re-litigate style")
    expect(bar.judge).toContain("EVASION")
    expect(bar.judge).toContain("dishonesty")
    expect(bar.judge).not.toContain("fix:")
    expect(bar.judge.length).toBeLessThanOrEqual(1_500 + 30)
  })

  test("byte-stable per config (prompt-cache friendly) and None when nothing is armed", () => {
    const config = decode({
      tsconfig: "tsconfig.json",
      rules: [{ rule: "effect/no-let", include: ["src/**"] }],
    })
    const first = Option.getOrThrow(renderQualityBar(config, registry))
    const second = Option.getOrThrow(renderQualityBar(config, registry))
    expect(second).toEqual(first)

    const empty = decode({ tsconfig: "tsconfig.json", rules: [] })
    expect(Option.isNone(renderQualityBar(empty, registry))).toBe(true)
    // Unknown ids are skipped (the gate itself crashes on them; the renderer
    // is an aid) — a config arming ONLY an unknown rule renders nothing.
    const unknown = decode({
      tsconfig: "tsconfig.json",
      rules: [{ rule: "local/not-in-registry", include: ["src/**"] }],
    })
    expect(Option.isNone(renderQualityBar(unknown, registry))).toBe(true)
  })
})
