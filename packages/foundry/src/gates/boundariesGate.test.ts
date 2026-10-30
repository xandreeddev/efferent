import { afterAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime, Option, Schema } from "effect"
import * as path from "node:path"
import { LayerConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeBoundariesGate } from "./boundariesGate.js"
import { TsProjectCachedLive } from "./TsProject.port.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/boundaries")
const ws: Workspace = { rootDir, files: [] }

const where = (finding: { readonly location: Option.Option<{ readonly file: string; readonly line: number }> }): string =>
  Option.match(finding.location, { onNone: () => "?", onSome: (l) => `${l.file}:${l.line}` })

const layers = Schema.decodeUnknownSync(LayerConfig)({
  layers: [
    { name: "domain", path: "src/domain/**", canImport: [], externals: ["effect"] },
    {
      name: "adapters",
      path: "src/adapters/**",
      canImport: ["domain"],
      externals: ["node:"],
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
        { name: "adapters", path: "src/adapters/**", canImport: ["domain"], externals: [] },
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

  test("an Effect barrel (effect/ai, formerly @effect/ai) needs its own allowance; core modules ride on effect", async () => {
    const barrelLayers = (externals: ReadonlyArray<string>) => Schema.decodeUnknownSync(LayerConfig)({
      layers: [{ name: "barrels", path: "src/barrels/**", canImport: [], externals }],
    })
    const run = (externals: ReadonlyArray<string>) => Effect.runPromise(
      makeBoundariesGate(barrelLayers(externals), "tsconfig.json").run(ws).pipe(Effect.provide(TsProjectCachedLive)),
    )
    const refused = await run(["effect"])
    expect(refused.map((f) => String(f.rule))).toEqual(["boundaries/illegal-external"])
    expect(refused[0]!.message).toContain("effect/ai")
    expect(await run(["effect", "effect/ai"])).toEqual([])
    expect(await run(["effect", "effect/"])).toEqual([])
  })

  const runOver = (layers: ReadonlyArray<unknown>) =>
    Effect.runPromise(
      makeBoundariesGate(Schema.decodeUnknownSync(LayerConfig)({ layers }), "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )

  test("effect/testing (Effect's test services) and effect/net are barrels too: effect does not admit them", async () => {
    const named = (externals: ReadonlyArray<string>) => runOver([{ name: "named", path: "src/named/**", canImport: [], externals }])
    const refused = await named(["effect"])
    expect(refused.map((f) => `${String(f.rule)} ${f.message}`)).toEqual([
      'boundaries/illegal-external layer "named" must not depend on external "effect/testing"',
      'boundaries/illegal-external layer "named" must not depend on external "effect/net"',
    ])
    expect(await named(["effect", "effect/testing", "effect/net"])).toEqual([])
  })

  test("a dynamic import and an import type are checked like an import clause", async () => {
    const dynamic = (externals: ReadonlyArray<string>) => runOver([{ name: "dynamic", path: "src/dynamic/**", canImport: [], externals }])
    const refused = await dynamic([])
    expect(refused.map((f) => `${where(f)} ${f.message}`)).toEqual([
      'src/dynamic/load.ts:1 layer "dynamic" must not depend on external "node:path"',
      'src/dynamic/load.ts:2 layer "dynamic" must not depend on external "node:os"',
    ])
    expect(await dynamic(["node:"])).toEqual([])
  })

  test("an external none of the layer's files imports fails, so a list only shrinks; a layer is every entry of its name", async () => {
    const findings = await runOver([
      { name: "lib", path: "src/domain/**", canImport: [], externals: ["effect"] },
      { name: "lib", path: "src/barrels/**", canImport: [], externals: ["effect", "effect/ai"] },
      // effect/ai is imported by the barrels entry's file, so only fast-check is unused.
      { name: "lib", path: "src/adapters/**", canImport: [], externals: ["node:", "effect/ai", "fast-check"] },
    ])
    expect(findings.map((f) => `${where(f)} ${String(f.rule)} ${f.message}`)).toEqual([
      '? boundaries/illegal-external layer "lib" lists external "fast-check", which none of its files imports',
    ])
    expect(Option.getOrElse(findings[0]!.fixHint, () => "")).toContain("the list only shrinks")
  })
})

const workspace: Workspace = { rootDir: path.resolve(import.meta.dir, "../../fixtures/boundaries-workspace"), files: [] }

/** Three packages: `app` may import `base`, whose `internal` subpath is restricted; `other` is not
 *  granted. No layer lists a `@fixture/*` external: a workspace package is reached by its layer. */
const workspaceLayers = (appCanImport: ReadonlyArray<string>) => Schema.decodeUnknownSync(LayerConfig)({
  layers: [
    { name: "base", path: "packages/base/src/**", canImport: [], externals: [], restricted: ["internal"] },
    { name: "other", path: "packages/other/src/**", canImport: [], externals: [] },
    { name: "app-tests", path: "packages/app/src/checks/**", canImport: ["app", "base"], externals: [] },
    { name: "app", path: "packages/app/src/**", canImport: appCanImport, externals: [] },
  ],
})

/** One program for every run over the workspace fixture. */
const workspaceRuntime = ManagedRuntime.make(TsProjectCachedLive)
afterAll(() => workspaceRuntime.dispose())

const runWorkspace = (appCanImport: ReadonlyArray<string>) =>
  workspaceRuntime.runPromise(makeBoundariesGate(workspaceLayers(appCanImport), "tsconfig.json").run(workspace))

const findingsIn = async (appCanImport: ReadonlyArray<string>, file: string) =>
  (await runWorkspace(appCanImport)).filter((finding) => where(finding).startsWith(`packages/app/src/${file}:`))

describe("boundaries gate over workspace packages", () => {
  test("the legal imports pass and each refused one is reported once, at its line", async () => {
    const findings = await runWorkspace(["base"])
    expect(findings.map((finding) => `${where(finding)} ${String(finding.rule)}`).toSorted()).toEqual([
      "packages/app/src/escape.ts:1 boundaries/illegal-import",
      "packages/app/src/restricted.ts:1 boundaries/illegal-import",
      "packages/app/src/scaffolding.ts:1 boundaries/illegal-import",
      "packages/app/src/undeclared.ts:1 boundaries/illegal-import",
      "packages/app/src/unexported.ts:1 boundaries/illegal-import",
    ])
  })

  test("an undeclared bare import: a workspace package whose layer canImport does not name", async () => {
    const [finding, ...rest] = await findingsIn(["base"], "undeclared.ts")
    expect(rest).toEqual([])
    expect(finding!.message).toBe('layer "app" must not import layer "other" (@fixture/other)')
    expect(await findingsIn(["base", "other"], "undeclared.ts")).toEqual([])
  })

  test("an unexported subpath fails, and a testing module is reachable from a -tests layer only", async () => {
    const [unexported] = await findingsIn(["base"], "unexported.ts")
    expect(unexported!.message).toBe('"@fixture/base/hidden": @fixture/base does not export "./hidden"')
    const [scaffolding] = await findingsIn(["base"], "scaffolding.ts")
    expect(scaffolding!.message).toContain('does not export "./testing/fixture.testing"')
    expect(await findingsIn(["base"], "checks/")).toEqual([])
  })

  test("a restricted subpath needs <layer>/<subpath> in canImport", async () => {
    const [restricted] = await findingsIn(["base"], "restricted.ts")
    expect(restricted!.message).toBe(
      'layer "app" must not import "@fixture/base/internal": "internal" is a restricted subpath of layer "base"',
    )
    expect(Option.getOrElse(restricted!.fixHint, () => "")).toContain('grant "base/internal"')
    expect(await findingsIn(["base", "base/internal"], "restricted.ts")).toEqual([])
  })

  test("a relative import that leaves its package fails, whatever its layers allow", async () => {
    const [escape, ...rest] = await findingsIn(["base"], "escape.ts")
    expect(rest).toEqual([])
    expect(escape!.message).toBe('relative import "../../base/src/index.js" leaves its package (packages/app)')
  })
})
