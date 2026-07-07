import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import { EvalShapeConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeEvalShapeGate } from "./evalShapeGate.js"
import { TsProjectCachedLive } from "./TsProject.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/evalShape")
const ws: Workspace = { rootDir, files: [] }

const config = Schema.decodeUnknownSync(EvalShapeConfig)({ registry: "registry.ts" })

describe("eval-shape gate", () => {
  test("finds all three structure holes: empty scorers, missing threshold, unregistered suite", async () => {
    const findings = await Effect.runPromise(
      makeEvalShapeGate(config, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    const byRule = findings
      .map((f) => ({
        rule: String(f.rule),
        file: Option.match(f.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
      }))
      .sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))
    expect(byRule).toEqual([
      { rule: "evals/explicit-threshold", file: "noThreshold.eval.ts" },
      { rule: "evals/nonempty-scorers", file: "emptyScorers.eval.ts" },
      { rule: "evals/registered", file: "unregistered.eval.ts" },
    ])
  })

  test("a missing registry is itself a finding — never silently unchecked", async () => {
    const missing = Schema.decodeUnknownSync(EvalShapeConfig)({ registry: "no-such.ts" })
    const findings = await Effect.runPromise(
      makeEvalShapeGate(missing, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings.some((f) => f.message.includes("registry not found"))).toBe(true)
  })
})
