import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import { RuleConfig } from "../../domain/Rules.js"
import type { Workspace } from "../../ports/Gate.js"
import { makeIdiomGate } from "../idiomGate.js"
import { TsProjectCachedLive } from "../TsProject.port.js"
import { qualityPack } from "./packs.js"

/** Two packages, `@fixture/lib` and `@fixture/app`, with a script, a guide
 *  and a changelog: `lib`'s exports are used, documented, or neither. */
const rootDir = path.resolve(import.meta.dir, "../../../fixtures/exports")
const ws: Workspace = { rootDir, files: [] }

const findingsFor = (include: ReadonlyArray<string>) =>
  Effect.runPromise(
    makeIdiomGate(
      qualityPack.rules,
      [Schema.decodeUnknownSync(RuleConfig)({ rule: "quality/exports-have-consumers", include: [...include] })],
      "tsconfig.json",
    )
      .run(ws)
      .pipe(Effect.provide(TsProjectCachedLive)),
  )

const at = (findings: Awaited<ReturnType<typeof findingsFor>>) =>
  findings
    .map((f) => ({
      file: Option.match(f.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
      line: Option.match(f.location, { onNone: () => 0, onSome: (l) => l.line }),
      message: f.message,
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

describe("quality/exports-have-consumers", () => {
  test("ships in the quality pack", () => {
    expect(qualityPack.rules.map((rule) => String(rule.id))).toContain("quality/exports-have-consumers")
  })

  test("an export no other package, script or doc code block imports fails, unless it is @public", async () => {
    const findings = at(await findingsFor(["packages/lib/src/index.ts"]))
    const unconsumed = (name: string) =>
      `"${name}" has no first-party consumer: no other package, script or doc code block imports it from "@fixture/lib", and it is not tagged @public`
    expect(findings.filter((f) => f.message.includes("no first-party consumer"))).toEqual([
      // Only the package's own file imports it, by the package's name.
      { file: "packages/lib/src/index.ts", line: 7, message: unconsumed("selfOnly") },
      // Only the changelog shows it.
      { file: "packages/lib/src/index.ts", line: 8, message: unconsumed("changelogged") },
      // Only a shell block shows it.
      { file: "packages/lib/src/index.ts", line: 9, message: unconsumed("fenced") },
      { file: "packages/lib/src/index.ts", line: 10, message: unconsumed("unused") },
      { file: "packages/lib/src/index.ts", line: 20, message: unconsumed("localUnused") },
      { file: "packages/lib/src/index.ts", line: 26, message: unconsumed("Alias") },
    ])
  })

  test("a named, default, namespace-member, import-type or named re-export use counts, from source, scripts or docs", async () => {
    const flagged = (await findingsFor(["packages/lib/src/index.ts"])).map((f) => f.message)
    const named = ["used", "viaNamespace", "viaReexport", "scripted", "documented", "ViaType", "everything", "Shape", "default"]
    expect(named.filter((name) => flagged.some((message) => message.startsWith(`"${name}"`)))).toEqual([])
  })

  test("@public on the statement, the specifier or the declaration excuses an unused export", async () => {
    const flagged = (await findingsFor(["packages/lib/src/index.ts"])).map((f) => f.message)
    expect(["hostApi", "taggedHere", "localPublic"].filter((name) => flagged.some((message) => message.startsWith(`"${name}"`)))).toEqual([])
  })

  test("`export *` in an entry fails", async () => {
    const findings = at(await findingsFor(["packages/lib/src/index.ts"]))
    expect(findings.filter((f) => f.message.includes("export *"))).toEqual([
      {
        file: "packages/lib/src/index.ts",
        line: 18,
        message: '`export *` from "./impl.js" publishes whatever that module exports: an entry names each of its exports',
      },
    ])
  })

  test("a @deprecated export first-party code still imports fails, naming where; an unused one passes", async () => {
    const findings = at(await findingsFor(["packages/lib/src/index.ts"]))
    expect(findings.filter((f) => f.message.includes("@deprecated"))).toEqual([
      // Deprecated on its declaration, imported by the app.
      {
        file: "packages/lib/src/index.ts",
        line: 11,
        message: '"deprecatedAtSource" is @deprecated, but first-party code still imports it from "@fixture/lib": packages/app/src/main.ts:1',
      },
      // Deprecated on the entry's alias, shown by the guide.
      {
        file: "packages/lib/src/index.ts",
        line: 28,
        message: '"oldName" is @deprecated, but first-party code still imports it from "@fixture/lib": docs/guide.md:5',
      },
    ])
    expect(findings.some((f) => f.message.startsWith('"retired"'))).toBe(false)
  })

  test("a subpath entry and a pattern entry are judged by their own specifiers", async () => {
    expect(at(await findingsFor(["packages/lib/src/extra.ts", "packages/lib/src/tools/*.ts"]))).toEqual([
      {
        file: "packages/lib/src/extra.ts",
        line: 2,
        message:
          '"extraUnused" has no first-party consumer: no other package, script or doc code block imports it from "@fixture/lib/extra", and it is not tagged @public',
      },
    ])
  })

  test("a file no exports subpath points at is a finding, not a pass", async () => {
    expect(at(await findingsFor(["packages/lib/src/impl.ts"]))).toEqual([
      {
        file: "packages/lib/src/impl.ts",
        line: 1,
        message: 'packages/lib/src/impl.ts is not an entry of @fixture/lib: no "exports" subpath of its package.json points at it',
      },
    ])
  })

  test("an empty include checks nothing", async () => {
    expect(await findingsFor([])).toEqual([])
  })
})
