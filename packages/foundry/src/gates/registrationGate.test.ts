import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { GateSuiteConfig } from "../domain/Rules.js"
import { makeRegistrationGate } from "./registrationGate.js"

/** A fixture monorepo: `alpha` (a library), `plugin-beta` (a plugin), `site`
 *  (exempt from every registry) and `notes` (no package.json: not a package),
 *  each registered in all five places unless a variant leaves one out. */
interface Variant {
  readonly checked?: ReadonlyArray<string>
  readonly layers?: ReadonlyArray<string>
  readonly names?: ReadonlyArray<string>
  readonly paths?: ReadonlyArray<string>
  readonly plugins?: ReadonlyArray<string>
  readonly firstPartyConst?: string
}

const seedRepo = (variant: Variant = {}): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "foundry-registration-"))
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  ;["alpha", "plugin-beta", "site"].forEach((name) =>
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@demo/${name}`, version: "1.0.0" })),
  )
  mkdirSync(path.join(dir, "packages", "notes"), { recursive: true })
  write(
    "scripts/build.ts",
    `const ignored = ["alpha"]\nconst names = ${JSON.stringify(variant.names ?? ["alpha", "plugin-beta"])} as const\n`,
  )
  write(
    "tsconfig.base.json",
    `// paths for the workspace packages\n${JSON.stringify({
      compilerOptions: {
        paths: Object.fromEntries((variant.paths ?? ["@demo/alpha", "@demo/plugin-beta"]).map((key) => [key, ["x"]])),
      },
    })}\n`,
  )
  const plugins = variant.plugins ?? ["plugin-beta"]
  write(
    "scripts/reference.ts",
    [
      ...plugins.map((name, i) => `import * as p${i} from "@demo/${name}"`),
      'import { helper } from "@demo/alpha"',
      `const ${variant.firstPartyConst ?? "firstParty"}: ReadonlyArray<unknown> = [${plugins.map((_, i) => `p${i}.plugin`).join(", ")}]`,
      "const others = [helper]",
      "",
    ].join("\n"),
  )
  return dir
}

const configFor = (variant: Variant = {}) =>
  Schema.decodeUnknownSync(GateSuiteConfig)({
    tsconfig: "tsconfig.json",
    typecheck: false,
    rules: [{ rule: "local/anything", include: variant.checked ?? ["packages/alpha/src/**", "packages/plugin-beta/src/**"] }],
    boundaries: {
      layers: (variant.layers ?? ["alpha", "plugin-beta"]).map((name) => ({
        name,
        path: `packages/${name}/src/**`,
        canImport: [],
        externals: [],
      })),
    },
    registration: {
      roots: ["packages"],
      exclude: ["packages/site"],
      registries: [
        { source: "rules", hint: 'add "{path}/src/**" to CHECKED' },
        { source: "boundaries" },
        { source: "const", file: "scripts/build.ts", name: "names", entry: "{dir}" },
        { source: "json-keys", file: "tsconfig.base.json", keys: ["compilerOptions", "paths"], entry: "{name}" },
        { source: "const", file: "scripts/reference.ts", name: "firstParty", entry: "{name}", include: ["packages/plugin-*"] },
      ],
    },
  })

const run = (dir: string, config: GateSuiteConfig) =>
  Effect.runPromiseExit(
    Option.match(config.registration, {
      onNone: () => Effect.die("the fixture config arms registration"),
      onSome: (registration) => makeRegistrationGate(config, registration).run({ rootDir: dir, files: [] }),
    }),
  )

const findingsOf = async (variant: Variant) => {
  const exit = await run(seedRepo(variant), configFor(variant))
  expect(exit._tag).toBe("Success")
  return exit._tag === "Success"
    ? exit.value.map((finding) => ({
        rule: String(finding.rule),
        message: finding.message,
        hint: Option.getOrElse(finding.fixHint, () => ""),
      }))
    : []
}

describe("registration gate", () => {
  test("a package registered everywhere passes; exempt packages and folders without package.json are skipped", async () => {
    expect(await findingsOf({})).toEqual([])
  })

  test("missing from the profile's rules (CHECKED): names the package and the uncovered probe", async () => {
    const findings = await findingsOf({ checked: ["packages/plugin-beta/src/**"] })
    expect(findings).toEqual([
      {
        rule: "quality/package-registered",
        message:
          "packages/alpha (@demo/alpha) is gated by none of this profile's rules: no rule's include covers packages/alpha/src/index.ts, so its sources get no rule findings",
        hint: 'add "packages/alpha/src/**" to CHECKED',
      },
    ])
  })

  test("missing from the boundaries layers", async () => {
    const findings = await findingsOf({ layers: ["alpha"] })
    expect(findings.map((f) => f.message)).toEqual([
      "packages/plugin-beta (@demo/plugin-beta) is in none of this profile's boundaries layers: no layer's path covers packages/plugin-beta/src/index.ts, so its imports are never checked",
    ])
    expect(findings[0]!.hint).toBe("add a boundaries layer whose path covers packages/plugin-beta/src/index.ts")
  })

  test("missing from a build script's package list (a top-level const of strings)", async () => {
    // `ignored` also names alpha: only the named const counts.
    const findings = await findingsOf({ names: ["plugin-beta"] })
    expect(findings.map((f) => f.message)).toEqual([
      'packages/alpha (@demo/alpha) is missing from `names` in scripts/build.ts (expected "alpha")',
    ])
  })

  test("missing from a tsconfig's paths (the keys of a JSON object, comments allowed)", async () => {
    const findings = await findingsOf({ paths: ["@demo/alpha"] })
    expect(findings.map((f) => f.message)).toEqual([
      'packages/plugin-beta (@demo/plugin-beta) is missing from compilerOptions.paths in tsconfig.base.json (expected "@demo/plugin-beta")',
    ])
  })

  test("a plugin missing from the plugin list (the modules its elements are imported from); libraries are not asked", async () => {
    const findings = await findingsOf({ plugins: [] })
    expect(findings.map((f) => f.message)).toEqual([
      'packages/plugin-beta (@demo/plugin-beta) is missing from `firstParty` in scripts/reference.ts (expected "@demo/plugin-beta")',
    ])
  })

  test("a registry the config points at a missing const fails closed", async () => {
    const exit = await run(seedRepo({ firstPartyConst: "plugins" }), configFor())
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("scripts/reference.ts declares no top-level array `const firstParty = [...]`")
  })
})
