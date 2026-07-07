import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import { LayerConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeBoundariesGate } from "./boundariesGate.js"
import { TsProjectCachedLive } from "./TsProject.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/boundaries")
const ws: Workspace = { rootDir, files: [] }

const layers = Schema.decodeUnknownSync(LayerConfig)({
  layers: [
    { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect"] },
    {
      name: "adapters",
      path: "src/adapters/**",
      canImport: ["domain"],
      externals: ["effect", "node:"],
    },
  ],
})

describe("boundaries gate", () => {
  test("finds exactly the one illegal domain→adapters import; legal imports pass", async () => {
    const findings = await Effect.runPromise(
      makeBoundariesGate(layers, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]!
    expect(String(finding.rule)).toBe("boundaries/illegal-import")
    expect(finding.message).toContain('"domain" must not import layer "adapters"')
    expect(
      Option.match(finding.location, { onNone: () => "?", onSome: (l) => `${l.file}:${l.line}` }),
    ).toBe("src/domain/bad.ts:1")
  })

  test("an external not in the layer's allowlist is flagged", async () => {
    const strictLayers = Schema.decodeUnknownSync(LayerConfig)({
      layers: [
        // adapters may no longer use node: — db.ts's node:path import must surface.
        { name: "adapters", path: "src/adapters/**", canImport: ["domain"], externals: ["effect"] },
      ],
    })
    const findings = await Effect.runPromise(
      makeBoundariesGate(strictLayers, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings.map((f) => String(f.rule))).toEqual(["boundaries/illegal-external"])
    expect(findings[0]!.message).toContain("node:path")
  })
})
