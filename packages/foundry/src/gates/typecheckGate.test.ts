import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as path from "node:path"
import type { Workspace } from "../ports/Gate.js"
import { makeTypecheckGate } from "./typecheckGate.js"
import { TsProjectCachedLive } from "./TsProject.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/typecheck")
const ws: Workspace = { rootDir, files: [] }

describe("typecheck gate", () => {
  test("surfaces the known TS2322 with its exact location", async () => {
    const findings = await Effect.runPromise(
      makeTypecheckGate("tsconfig.json").run(ws).pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]!
    expect(String(finding.rule)).toBe("ts/2322")
    expect(finding.severity).toBe("error")
    expect(finding.message).toContain("'number' is not assignable to type 'string'")
    expect(
      Option.match(finding.location, { onNone: () => "?", onSome: (l) => `${l.file}:${l.line}` }),
    ).toBe("typeError.ts:1")
  })

  test("a bad tsconfig path is a GateCrash, not a pass", async () => {
    const exit = await Effect.runPromiseExit(
      makeTypecheckGate("no-such-tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
