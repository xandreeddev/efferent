import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import { RuleId } from "../domain/Brands.js"
import { RuleConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeIdiomGate } from "./idiomGate.js"
import { builtinRules } from "./rules/index.js"
import { TsProjectCachedLive } from "./TsProject.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/idioms")
const ws: Workspace = { rootDir, files: [] }

const configFor = (rules: ReadonlyArray<string>, include: ReadonlyArray<string>) =>
  rules.map((rule) =>
    Schema.decodeUnknownSync(RuleConfig)({ rule, include: [...include] }),
  )

const findingsFor = (rules: ReadonlyArray<string>, include: ReadonlyArray<string>) =>
  Effect.runPromise(
    makeIdiomGate(builtinRules, configFor(rules, include), "tsconfig.json")
      .run(ws)
      .pipe(Effect.provide(TsProjectCachedLive)),
  )

const at = (findings: Awaited<ReturnType<typeof findingsFor>>) =>
  findings
    .map((f) => ({
      rule: String(f.rule),
      file: Option.match(f.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
      line: Option.match(f.location, { onNone: () => 0, onSome: (l) => l.line }),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

describe("effect-idioms gate over fixtures", () => {
  test("effect/no-let finds the let, and nothing in clean.ts", async () => {
    const findings = await findingsFor(["effect/no-let"], ["**/*.ts"])
    expect(at(findings)).toEqual([{ rule: "effect/no-let", file: "noLet.ts", line: 2 }])
  })

  test("effect/no-try-catch finds try, throw, and .catch()", async () => {
    const findings = await findingsFor(["effect/no-try-catch"], ["tryCatch.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 2 },
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 10 },
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 13 },
    ])
  })

  test("effect/no-nullable-return is type-aware: declared AND inferred nullable unions", async () => {
    const findings = await findingsFor(["effect/no-nullable-return"], ["nullableReturn.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-nullable-return", file: "nullableReturn.ts", line: 1 },
      { rule: "effect/no-nullable-return", file: "nullableReturn.ts", line: 4 },
    ])
    expect(findings.some((f) => f.message.includes("string | undefined"))).toBe(true)
  })

  test("effect/match-over-tag-switch flags the switch and the ladder, not the single guard", async () => {
    const findings = await findingsFor(["effect/match-over-tag-switch"], ["tagSwitch.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 6 },
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 15 },
    ])
  })

  test("effect/no-as-any flags `as any` and the unknown-laundering chain", async () => {
    const findings = await findingsFor(["effect/no-as-any"], ["asAny.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-as-any", file: "asAny.ts", line: 1 },
      { rule: "effect/no-as-any", file: "asAny.ts", line: 3 },
    ])
  })

  test("effect/branded-id-fields flags unbranded id-shaped fields only", async () => {
    const findings = await findingsFor(["effect/branded-id-fields"], ["unbrandedId.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/branded-id-fields", file: "unbrandedId.ts", line: 4 },
      { rule: "effect/branded-id-fields", file: "unbrandedId.ts", line: 5 },
    ])
  })

  test("effect/no-loop-statements flags every loop kind", async () => {
    const findings = await findingsFor(["effect/no-loop-statements"], ["loops.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-loop-statements", file: "loops.ts", line: 3 },
      { rule: "effect/no-loop-statements", file: "loops.ts", line: 6 },
    ])
  })

  test("effect/no-parallel-interface flags the Schema-shadowing interface only", async () => {
    const findings = await findingsFor(["effect/no-parallel-interface"], ["parallelInterface.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-parallel-interface", file: "parallelInterface.ts", line: 7 },
    ])
  })

  test("clean.ts passes every rule", async () => {
    const findings = await findingsFor(
      builtinRules.map((r) => String(r.id)),
      ["clean.ts"],
    )
    expect(findings).toEqual([])
  })

  test("include/exclude globs scope rules per path", async () => {
    const config = [
      Schema.decodeUnknownSync(RuleConfig)({
        rule: "effect/no-let",
        include: ["**/*.ts"],
        exclude: ["noLet.ts"],
      }),
    ]
    const findings = await Effect.runPromise(
      makeIdiomGate(builtinRules, config, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings).toEqual([])
  })

  test("an unknown rule id in config is a GateCrash (config error, fail-closed)", async () => {
    const config = [
      Schema.decodeUnknownSync(RuleConfig)({ rule: RuleId.make("effect/no-such-rule") }),
    ]
    const exit = await Effect.runPromiseExit(
      makeIdiomGate(builtinRules, config, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
