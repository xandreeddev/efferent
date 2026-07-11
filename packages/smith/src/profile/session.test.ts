import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { ConversationId, ConversationStore, FileSystem, Shell } from "@xandreed/engine"
import { LocalFileSystemLive } from "@xandreed/providers"
import { discoverGateSuite } from "../gates/suite.js"
import { gateRequestFromSpec } from "../spec/toForgeSpec.js"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { lockProfile, makeProfileSession, PROFILE_DRAFT_DIR } from "./session.js"
import type { ProfileAgent } from "./session.js"

const REPO_NODE_MODULES = resolve(import.meta.dir, "../../../../node_modules")

const stubServices = Layer.mergeAll(
  Layer.succeed(LanguageModel.LanguageModel, {} as never),
  Layer.succeed(Shell, {} as never),
  Layer.succeed(ConversationStore, {
    create: () =>
      Effect.succeed(ConversationId.make("00000000-0000-4000-8000-00000000f11e")),
  } as never),
  LocalFileSystemLive,
)

const NO_FIXME_SOURCE = [
  "export const rules = [",
  "  {",
  '    id: "local/no-fixme",',
  '    defaultSeverity: "error",',
  '    description: "FIXME markers are banned",',
  '    fixHint: "fix it or file it",',
  "    check: (ctx) =>",
  '      ctx.sourceFile.text.includes("FIX" + "ME")',
  '        ? [{ node: ctx.sourceFile, message: "FIXME marker" }]',
  "        : [],",
  "  },",
  "]",
  "",
].join("\n")

const scriptedAgent: ProfileAgent = (_cid, _prompt, tools) =>
  tools
    .propose({
      packs: ["quality"],
      customRules: [{ filename: "no-fixme.ts", source: NO_FIXME_SOURCE }],
      rules: [
        { rule: "quality/no-skipped-tests", include: ["src/**"] },
        { rule: "quality/no-empty-catch", include: ["src/**"] },
        { rule: "local/no-fixme", include: ["src/**"] },
      ],
      checks: [{ name: "always-green", command: "true" }],
      doctrine: "Prefer composition over inheritance; services take deps through the constructor.",
    })
    .pipe(Effect.asVoid, Effect.orDie)

const seedWorld = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "smith-profile-"))
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        module: "esnext",
        target: "esnext",
        moduleResolution: "bundler",
      },
      include: ["src/**/*.ts"],
    }),
  )
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "marked.ts"), "// FIXME: legacy\nexport const a = 1\n")
  writeFileSync(
    join(dir, "src", "parked.ts"),
    'declare const test: { skip: (n: string, f: () => void) => void }\ntest.skip("parked", () => {})\n',
  )
  // The vendored/custom rule modules import the workspace's own typescript.
  symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"), "dir")
  return dir
}

const runFor = (cwd: string): SmithRunConfig => ({
  task: "t",
  cwd,
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  allowBash: false,
  headless: true,
  testCommand: Option.none(),
  noTest: true,
  configPath: Option.none(),
  ship: false,
  sandbox: false,
})

describe("the profile session — propose (dry-run) → lock (arm)", () => {
  test("END-TO-END: scripted proposal dry-runs with real counts; lock arms the whole contract", async () => {
    const dir = seedWorld()
    const program = Effect.gen(function* () {
      const session = yield* makeProfileSession(dir, () => Effect.void, {
        unattended: true,
        agent: scriptedAgent,
      })
      const draft = yield* session.send("set up the profile")
      const summary = Option.getOrThrow(draft)
      // Real per-rule counts from the DRY-RUN against the seeded world.
      expect(summary.rules).toEqual([
        { rule: "quality/no-skipped-tests", findings: 1 },
        { rule: "quality/no-empty-catch", findings: 0 },
        { rule: "local/no-fixme", findings: 1 },
      ])
      expect(summary.checks).toEqual([{ name: "always-green", status: "green" }])
      expect(existsSync(join(dir, PROFILE_DRAFT_DIR, "draft.json"))).toBe(true)

      const report = yield* session.lock
      return report
    }).pipe(Effect.provide(stubServices))
    const report = await Effect.runPromise(program)

    // The armed write-set: config + vendored pack + custom module + doctrine
    // + baseline + the authoring skill; the draft is gone.
    expect(report.rules).toBe(3)
    expect(report.checks).toBe(1)
    expect(report.rulesFileWritten).toBe(true)
    expect(report.grandfathered).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(dir, "foundry.config.ts"))).toBe(true)
    expect(existsSync(join(dir, ".efferent", "gates", "quality", "rules.ts"))).toBe(true)
    expect(existsSync(join(dir, ".efferent", "gates", "no-fixme.ts"))).toBe(true)
    expect(existsSync(join(dir, ".efferent", "gates", "index.ts"))).toBe(true)
    expect(readFileSync(join(dir, ".efferent", "rules.md"), "utf8")).toContain(
      "composition over inheritance",
    )
    expect(existsSync(join(dir, ".foundry", "baseline.json"))).toBe(true)
    expect(existsSync(join(dir, ".efferent", "skills", "gate-rule-authoring.md"))).toBe(true)
    expect(existsSync(join(dir, PROFILE_DRAFT_DIR))).toBe(false)

    // The LOCKED workspace discovered by the forge path: profile armed, the
    // grandfathered findings never gate.
    const suite = await Effect.runPromise(
      discoverGateSuite(gateRequestFromSpec(runFor(dir), Option.none()), () => Effect.void).pipe(
        Effect.provide(LocalFileSystemLive),
      ),
    )
    const profile = Option.getOrThrow(suite.profile)
    expect(profile.rules).toBe(3)
    expect(profile.baseline).toBe(report.grandfathered)
    expect(suite.gateNames).toContain("always-green")
  })

  test("lock REFUSES without a draft, and never overwrites an existing config", async () => {
    const dir = seedWorld()
    const noDraft = await Effect.runPromise(
      Effect.either(lockProfile(dir).pipe(Effect.provide(LocalFileSystemLive))),
    )
    expect(noDraft._tag).toBe("Left")
    expect(noDraft._tag === "Left" ? noDraft.left.error : "?").toBe("NoDraft")

    // A draft exists but the workspace already carries a committed profile.
    mkdirSync(join(dir, PROFILE_DRAFT_DIR), { recursive: true })
    writeFileSync(
      join(dir, PROFILE_DRAFT_DIR, "draft.json"),
      JSON.stringify({ rules: [] }),
    )
    writeFileSync(join(dir, "foundry.config.ts"), "export default {}\n")
    const exists = await Effect.runPromise(
      Effect.either(lockProfile(dir).pipe(Effect.provide(LocalFileSystemLive))),
    )
    expect(exists._tag).toBe("Left")
    expect(exists._tag === "Left" ? exists.left.error : "?").toBe("ConfigExists")
  })

  test("an existing AGENTS.md wins the precedence chain — lock never writes rules.md beside it", async () => {
    const dir = seedWorld()
    writeFileSync(join(dir, "AGENTS.md"), "# House rules\nAlready here.\n")
    const program = Effect.gen(function* () {
      const session = yield* makeProfileSession(dir, () => Effect.void, {
        unattended: true,
        agent: scriptedAgent,
      })
      yield* session.send("set up")
      return yield* session.lock
    }).pipe(Effect.provide(stubServices))
    const report = await Effect.runPromise(program)
    expect(report.rulesFileWritten).toBe(false)
    expect(existsSync(join(dir, ".efferent", "rules.md"))).toBe(false)
  })
})
