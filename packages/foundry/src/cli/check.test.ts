import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { RuleConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeIdiomGate } from "../gates/idiomGate.js"
import { effectPack, vendoredPackFiles } from "../gates/rules/packs.js"
import { TsProjectCachedLive } from "../gates/TsProject.js"
import { gatesFromConfig, loadConfig } from "./check.js"

const REPO_NODE_MODULES = path.resolve(import.meta.dir, "../../../../node_modules")

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: "esnext",
    target: "esnext",
    moduleResolution: "bundler",
  },
  include: ["src/**/*.ts"],
})

/** A workspace whose src violates several effect rules — the shared golden
 *  fixture for library-vs-vendored parity. */
const seedViolations = (dir: string): void => {
  writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(
    path.join(dir, "src", "violations.ts"),
    [
      "export const f = (): number => {",
      "  let x = 1",
      "  try {",
      "    x = 2",
      "  } catch {}",
      "  return x as any",
      "}",
      'export const g = (flag: boolean) => (flag ? "x" : undefined)',
      "",
    ].join("\n"),
  )
}

const writeConfig = (dir: string, source: string): string => {
  const configPath = path.join(dir, "foundry.config.ts")
  writeFileSync(configPath, source)
  return configPath
}

const normalized = (
  findings: ReadonlyArray<{
    readonly rule: unknown
    readonly message: string
    readonly location: Option.Option<{ readonly file: unknown; readonly line: number }>
  }>,
) =>
  findings
    .map((f) => ({
      rule: String(f.rule),
      message: f.message,
      file: Option.match(f.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
      line: Option.match(f.location, { onNone: () => 0, onSome: (l) => l.line }),
    }))
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
    )

describe("loadConfig — the plug-in registry", () => {
  test("customRules named export: decoded, armed, and firing end-to-end", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-plug-"))
    seedViolations(dir)
    writeFileSync(path.join(dir, "src", "marked.ts"), "// FIXME: later\nexport const a = 1\n")
    const configPath = writeConfig(
      dir,
      [
        "export const customRules = [",
        "  {",
        '    id: "local/no-fixme",',
        '    defaultSeverity: "error",',
        '    description: "FIXME markers are banned",',
        '    fixHint: "fix it or file it — never park it in the source",',
        "    check: (ctx) =>",
        '      ctx.sourceFile.text.includes("FIXME")',
        '        ? [{ node: ctx.sourceFile, message: "FIXME marker" }]',
        "        : [],",
        "  },",
        "]",
        "export default {",
        '  tsconfig: "tsconfig.json",',
        '  rules: [{ rule: "local/no-fixme", include: ["src/**"] }],',
        "  typecheck: false,",
        "}",
        "",
      ].join("\n"),
    )
    const { config, registry, rootDir } = await Effect.runPromise(loadConfig(configPath))
    expect(registry.map((r) => String(r.id))).toEqual(["local/no-fixme"])
    const [idiomGate] = gatesFromConfig(config, registry)
    const findings = await Effect.runPromise(
      idiomGate.run({ rootDir, files: [] }).pipe(Effect.provide(TsProjectCachedLive)),
    )
    // Anchored on the sourceFile node: getStart() skips leading trivia (the
    // FIXME comment itself), so the location is the first real statement.
    expect(normalized(findings)).toEqual([
      { rule: "local/no-fixme", message: "FIXME marker", file: "src/marked.ts", line: 2 },
    ])
  })

  test("a plugged rule that CRASHES reports itself as a finding — fail-closed, not a defect", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-plug-"))
    seedViolations(dir)
    const configPath = writeConfig(
      dir,
      [
        "export const customRules = [",
        "  {",
        '    id: "local/explodes",',
        '    defaultSeverity: "error",',
        '    description: "always crashes",',
        '    fixHint: "n/a",',
        '    check: () => { throw new Error("boom") },',
        "  },",
        "]",
        "export default {",
        '  tsconfig: "tsconfig.json",',
        '  rules: [{ rule: "local/explodes", include: ["src/**"] }],',
        "  typecheck: false,",
        "}",
        "",
      ].join("\n"),
    )
    const { config, registry, rootDir } = await Effect.runPromise(loadConfig(configPath))
    const [idiomGate] = gatesFromConfig(config, registry)
    const findings = await Effect.runPromise(
      idiomGate.run({ rootDir, files: [] }).pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.message.includes("crashed"))).toBe(true)
    expect(findings.every((f) => f.message.includes("boom"))).toBe(true)
  })

  test("bad meta / non-function check / duplicate ids are ConfigErrors that NAME the entry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-plug-"))
    const cases = [
      {
        name: "bad-meta",
        source: 'export const customRules = [{ id: "not a rule id", check: () => [] }]\nexport default { tsconfig: "t.json", rules: [] }\n',
        expects: "customRules[0]",
      },
      {
        name: "no-check",
        source:
          'export const customRules = [{ id: "local/x", defaultSeverity: "error", description: "d", fixHint: "f" }]\nexport default { tsconfig: "t.json", rules: [] }\n',
        expects: "`check` must be a function",
      },
      {
        name: "dup-id",
        source: [
          'const rule = { id: "local/dup", defaultSeverity: "error", description: "d", fixHint: "f", check: () => [] }',
          "export const customRules = [rule, { ...rule }]",
          'export default { tsconfig: "t.json", rules: [] }',
          "",
        ].join("\n"),
        expects: "duplicate rule id(s)",
      },
      {
        name: "bad-pack",
        source: 'export const rulePacks = ["not-a-pack"]\nexport default { tsconfig: "t.json", rules: [] }\n',
        expects: "rulePacks[0]",
      },
    ]
    const results = await Promise.all(
      cases.map(async (c) => {
        const casePath = path.join(dir, c.name)
        mkdirSync(casePath, { recursive: true })
        const configPath = path.join(casePath, "foundry.config.ts")
        writeFileSync(configPath, c.source)
        const exit = await Effect.runPromiseExit(loadConfig(configPath))
        return { name: c.name, expects: c.expects, exit }
      }),
    )
    results.forEach(({ expects, exit }) => {
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("ConfigError")
      expect(String(exit)).toContain(expects)
    })
  })

  test("a data-only config (no named exports) loads with an EMPTY registry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-plug-"))
    const configPath = writeConfig(
      dir,
      'export default { tsconfig: "tsconfig.json", rules: [], typecheck: false }\n',
    )
    const { registry } = await Effect.runPromise(loadConfig(configPath))
    expect(registry).toEqual([])
  })
})

describe("vendored packs — plain twins of the library", () => {
  test("GOLDEN: the vendored effect pack produces byte-identical findings to the library pack", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-vendor-"))
    seedViolations(dir)
    // The vendored rules import the workspace's own `typescript`.
    symlinkSync(REPO_NODE_MODULES, path.join(dir, "node_modules"), "dir")
    const files = await Effect.runPromise(vendoredPackFiles("effect"))
    expect(files.length).toBeGreaterThan(0)
    files.forEach((file) => {
      const target = path.join(dir, ".efferent", "gates", file.path)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    })
    const ruleIds = effectPack.rules.map((rule) => String(rule.id))
    const configPath = writeConfig(
      dir,
      [
        'import { rules } from "./.efferent/gates/effect/rules.js"',
        "export const customRules = rules",
        "export default {",
        '  tsconfig: "tsconfig.json",',
        `  rules: [${ruleIds.map((id) => `{ rule: "${id}", include: ["src/**"] }`).join(", ")}],`,
        "  typecheck: false,",
        "}",
        "",
      ].join("\n"),
    )
    const { config, registry, rootDir } = await Effect.runPromise(loadConfig(configPath))
    expect(registry.length).toBe(effectPack.rules.length)
    const [vendoredGate] = gatesFromConfig(config, registry)
    const vendoredFindings = await Effect.runPromise(
      vendoredGate.run({ rootDir, files: [] }).pipe(Effect.provide(TsProjectCachedLive)),
    )

    const ws: Workspace = { rootDir: dir, files: [] }
    const libraryConfigs = ruleIds.map((id) =>
      Schema.decodeUnknownSync(RuleConfig)({ rule: id, include: ["src/**"] }),
    )
    const libraryFindings = await Effect.runPromise(
      makeIdiomGate(effectPack.rules, libraryConfigs, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )

    expect(normalized(libraryFindings).length).toBeGreaterThan(3)
    expect(normalized(vendoredFindings)).toEqual(normalized(libraryFindings))
  })

  test("an unknown pack name is a ConfigError naming the known packs", async () => {
    const exit = await Effect.runPromiseExit(vendoredPackFiles("no-such-pack"))
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("effect, quality")
  })
})
