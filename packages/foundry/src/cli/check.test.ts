import { describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { BaselineFile, baselineRefusal } from "../domain/baseline.js"
import { PrivateTextConfig, RuleConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeIdiomGate } from "../gates/idiomGate.js"
import { effectPack, vendoredPackFiles } from "../gates/rules/packs.js"
import { makePrivateTextGate } from "../gates/privateTextGate.js"
import { makeRegistrationGate } from "../gates/registrationGate.js"
import { TsProjectCachedLive } from "../gates/TsProject.port.js"
import { gatesFromConfig, loadConfig, runCheck } from "./check.js"

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")
const REPO_NODE_MODULES = path.join(REPO_ROOT, "node_modules")

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
 *  fixture for library-vs-vendored parity. `errors.ts` declares the error
 *  whose code `violations.ts` compares. */
const seedViolations = (dir: string): void => {
  writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(
    path.join(dir, "src", "errors.ts"),
    [
      'import { Schema } from "effect"',
      'export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { code: Schema.String, message: Schema.String }) {}',
      "",
    ].join("\n"),
  )
  writeFileSync(
    path.join(dir, "src", "violations.ts"),
    [
      'import { Cause, Effect, Option, Schema, Stream } from "effect"',
      'import { StoreError } from "./errors.js"',
      "export const f = (): number => {",
      "  let x = 1",
      "  try {",
      "    x = 2",
      "  } catch {}",
      "  return x as any",
      "}",
      'export const g = (flag: boolean) => (flag ? "x" : undefined)',
      'export const parsed = JSON.parse("{}") as unknown',
      "export const now = Date.now()",
      "export const sorted = [3, 1, 2].sort()",
      'export const home = process.env["HOME"]',
      "export const all = () => Promise.all([])",
      "const value: unknown = 1",
      "export const laundered = value as never as string",
      'class NotFoundError extends Error { readonly _tag = "NotFoundError" }',
      "export const isMissing = (error: unknown) => error instanceof NotFoundError",
      "export const decoded = Schema.decodeUnknownSync(Schema.Number)(1)",
      "export const pretty = { detail: Cause.pretty(Cause.fail(1)) }",
      "export const unchecked = Effect.promise(() => Promise.resolve(1))",
      "export const unbounded = Stream.callback<number>(() => Effect.void)",
      'export const ordered = ["b", "a"].sort((a, b) => a.localeCompare(b))',
      "export const Item = Schema.Struct({ id: Schema.String })",
      "export interface Item { readonly id: string }",
      "export const loop = (xs: ReadonlyArray<number>) => { for (const x of xs) { void x } }",
      "export const tag = (x: { readonly _tag: string }) => { switch (x._tag) { default: return 0 } }",
      'export const role = (x: { readonly role: string }) => (x.role === "a" ? 1 : x.role === "b" ? 2 : 3)',
      "export const swallowed = Effect.fail(1).pipe(Effect.ignore)",
      'export const wrapped = (cause: unknown) => new StoreError({ code: "write", message: String(cause) })',
      'export const busy = (error: StoreError) => error.code === "busy"',
      "export const load = (id: string) => Effect.gen(function* () { return id })",
      "export const both = Effect.all([Effect.succeed(1), Effect.succeed(2)])",
      "export const unwrapped = Option.getOrNull(Option.some(1))",
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
    const idiomGate = gatesFromConfig(config, registry)[0]!
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
    const idiomGate = gatesFromConfig(config, registry)[0]!
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
    const vendoredGate = gatesFromConfig(config, registry)[0]!
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
    // Every rule of the pack fires on the seeded file, so drift in any one shows.
    expect(new Set(libraryFindings.map((f) => String(f.rule)))).toEqual(new Set(ruleIds))
    expect(normalized(vendoredFindings)).toEqual(normalized(libraryFindings))
  })

  test("an unknown pack name is a ConfigError naming the known packs", async () => {
    const exit = await Effect.runPromiseExit(vendoredPackFiles("no-such-pack"))
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("effect, quality")
  })
})

/** A one-rule workspace (`local/no-fixme`) for the baseline flows; `fixme`
 *  seeds the one finding. */
const seedBaselineWorkspace = (options: { readonly policy?: "ratchet" | "empty"; readonly fixme: boolean }): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "foundry-baseline-"))
  writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(path.join(dir, "src", "a.ts"), options.fixme ? "export const a = 1 // FIXME\n" : "export const a = 1\n")
  writeConfig(
    dir,
    [
      "export const customRules = [{",
      '  id: "local/no-fixme", defaultSeverity: "error", description: "no FIXME", fixHint: "fix it",',
      '  check: (ctx) => ctx.sourceFile.text.includes("FIXME") ? [{ node: ctx.sourceFile, message: "FIXME marker" }] : [],',
      "}]",
      "export default {",
      '  tsconfig: "tsconfig.json",',
      '  rules: [{ rule: "local/no-fixme", include: ["src/**"] }],',
      "  typecheck: false,",
      ...(options.policy === undefined ? [] : [`  baseline: "${options.policy}",`]),
      "}",
      "",
    ].join("\n"),
  )
  return dir
}

const writeBaseline = (dir: string, fingerprints: ReadonlyArray<string>): string => {
  const file = path.join(dir, "baseline.json")
  writeFileSync(file, `${JSON.stringify({ version: 1, fingerprints })}\n`)
  return file
}

/** Run `foundry check` with its console captured. */
const check = async (dir: string, options: { readonly baseline: string; readonly update?: boolean; readonly allowGrow?: boolean }) => {
  const out: Array<string> = []
  const log = spyOn(console, "log").mockImplementation((...args: ReadonlyArray<unknown>) => void out.push(args.join(" ")))
  const error = spyOn(console, "error").mockImplementation((...args: ReadonlyArray<unknown>) => void out.push(args.join(" ")))
  const code = await Effect.runPromise(
    runCheck({
      configPath: path.join(dir, "foundry.config.ts"),
      baselinePath: Option.some(options.baseline),
      updateBaseline: options.update === true,
      allowGrow: options.allowGrow === true,
    }).pipe(Effect.provide(TsProjectCachedLive)),
  ).finally(() => {
    log.mockRestore()
    error.mockRestore()
  })
  return { code, output: out.join("\n") }
}

const storedFingerprints = (file: string): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(Schema.fromJsonString(BaselineFile))(readFileSync(file, "utf8")).fingerprints

describe("the baseline policy", () => {
  test("ratchet (the default): a grandfathered finding passes", async () => {
    const dir = seedBaselineWorkspace({ fixme: true })
    const baseline = path.join(dir, "baseline.json")
    expect((await check(dir, { baseline, update: true, allowGrow: true })).code).toBe(0)
    expect(storedFingerprints(baseline).length).toBe(1)
    const result = await check(dir, { baseline })
    expect(result.code).toBe(0)
    expect(result.output).toContain("1 grandfathered · 0 NEW findings")
  })

  test("empty: a baseline holding a fingerprint fails even with nothing left to report", async () => {
    const dir = seedBaselineWorkspace({ policy: "empty", fixme: false })
    const result = await check(dir, { baseline: writeBaseline(dir, ["0badc0de"]) })
    expect(result.code).toBe(1)
    expect(result.output).toContain("[quality/baseline-empty]")
    expect(result.output).toContain("holds 1 fingerprint, but this profile's baseline must stay empty")
  })

  test("empty: the file grandfathers nothing, so a finding it lists still fails as NEW", async () => {
    const dir = seedBaselineWorkspace({ policy: "empty", fixme: true })
    const baseline = path.join(dir, "baseline.json")
    // Mint the finding's fingerprint the only way the CLI allows.
    expect((await check(dir, { baseline, update: true, allowGrow: true })).code).toBe(0)
    const result = await check(dir, { baseline })
    expect(result.code).toBe(1)
    expect(result.output).toContain("0 grandfathered · 1 NEW finding")
    expect(result.output).toContain("[local/no-fixme]")
    expect(result.output).toContain("[quality/baseline-empty]")
  })

  test("empty: an empty baseline on a clean workspace passes", async () => {
    const dir = seedBaselineWorkspace({ policy: "empty", fixme: false })
    const result = await check(dir, { baseline: writeBaseline(dir, []) })
    expect(result.code).toBe(0)
    expect(result.output).not.toContain("quality/baseline-empty")
  })

  test("--update-baseline refuses to grow without --allow-grow", async () => {
    const dir = seedBaselineWorkspace({ policy: "empty", fixme: true })
    const baseline = writeBaseline(dir, [])
    const result = await check(dir, { baseline, update: true })
    expect(result.code).toBe(1)
    expect(result.output).toContain("REFUSING to grow")
    expect(storedFingerprints(baseline)).toEqual([])
  })

  test("--allow-grow warns that an empty-baseline profile, and so CI, refuses the result", async () => {
    const dir = seedBaselineWorkspace({ policy: "empty", fixme: true })
    const result = await check(dir, { baseline: path.join(dir, "baseline.json"), update: true, allowGrow: true })
    expect(result.output).toContain("WARNING: --allow-grow grandfathered 1 NEW finding")
    expect(result.output).toContain("will REFUSE")
    const ratchet = await check(seedBaselineWorkspace({ fixme: true }), {
      baseline: path.join(tmpdir(), `foundry-grow-${Date.now()}.json`),
      update: true,
      allowGrow: true,
    })
    expect(ratchet.output).toContain("WARNING: --allow-grow grandfathered 1 NEW finding")
  })
})

describe("the repository profile", () => {
  test("every package is registered everywhere the profile names", async () => {
    const { config, rootDir } = await Effect.runPromise(loadConfig(path.join(REPO_ROOT, "foundry.config.ts")))
    const registration = Option.getOrThrow(config.registration)
    // The gate is pointed at a non-empty set of lists, the plugin list included.
    expect(registration.registries.length).toBe(5)
    const findings = await Effect.runPromise(makeRegistrationGate(config, registration).run({ rootDir, files: [] }))
    expect(findings.map((f) => f.message)).toEqual([])
  })

  test("the private-text profile names a denylist that git ignores", async () => {
    const { config, rootDir } = await Effect.runPromise(loadConfig(path.join(REPO_ROOT, "foundry.config.ts")))
    const privateText = Option.getOrThrow(config.privateText)
    expect(Option.isSome(privateText.denylist)).toBe(true)
    // Scan nothing, so only the denylist's own check runs.
    const denylistOnly = new PrivateTextConfig({ ...privateText, include: ["no-such-directory/**"] })
    expect(await Effect.runPromise(makePrivateTextGate(denylistOnly).run({ rootDir, files: [] }))).toEqual([])
  })

  test("the committed baseline is empty and the profile refuses one that is not", async () => {
    const { config } = await Effect.runPromise(loadConfig(path.join(REPO_ROOT, "foundry.config.ts")))
    expect(config.baseline).toBe("empty")
    const committed = new Set(storedFingerprints(path.join(REPO_ROOT, ".foundry", "baseline.json")))
    expect(Option.isNone(baselineRefusal(config.baseline, ".foundry/baseline.json", committed))).toBe(true)
    expect(Option.isSome(baselineRefusal(config.baseline, ".foundry/baseline.json", new Set(["0badc0de"])))).toBe(true)
  })
})
