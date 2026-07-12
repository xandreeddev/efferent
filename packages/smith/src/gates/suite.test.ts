import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  fingerprint,
  Finding,
  GateCrash,
  GateName,
  RuleId,
  SourceLocation,
  TsProjectCachedLive,
  withTempWorkspace,
  WorkspaceError,
  WorkspacePath,
  writeWorkspaceFile,
} from "@xandreed/foundry"
import type { Gate } from "@xandreed/foundry"
import { LocalFileSystemLive } from "@xandreed/providers"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { gateRequestFromSpec } from "../spec/toForgeSpec.js"
import { discoverGateSuite, probeAccepts, vacuousAccepts } from "./suite.js"

const runFor = (cwd: string, over: Partial<SmithRunConfig> = {}): SmithRunConfig => ({
  task: "t",
  cwd,
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
  ship: false,
  sandbox: false,
  ...over,
})

const silent = () => Effect.void

const discover = (cwd: string, over: Partial<SmithRunConfig> = {}) =>
  discoverGateSuite(gateRequestFromSpec(runFor(cwd, over), Option.none()), silent).pipe(
    Effect.provide(LocalFileSystemLive),
  )

describe("discoverGateSuite", () => {
  test("tsconfig.json alone → the typecheck gate", async () => {
    const names = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        writeWorkspaceFile(dir, "tsconfig.json", "{}").pipe(
          Effect.flatMap(() => discover(dir)),
          Effect.map((suite) => suite.gateNames),
        ),
      ),
    )
    expect(names).toEqual(["typecheck"])
  })

  test("package.json alone → the bun-test gate", async () => {
    const names = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        writeWorkspaceFile(dir, "package.json", "{}").pipe(
          Effect.flatMap(() => discover(dir)),
          Effect.map((suite) => suite.gateNames),
        ),
      ),
    )
    expect(names).toEqual(["bun-test"])
  })

  test("both present → typecheck then test (rank order comes from the pipeline)", async () => {
    const names = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        writeWorkspaceFile(dir, "tsconfig.json", "{}").pipe(
          Effect.flatMap(() => writeWorkspaceFile(dir, "package.json", "{}")),
          Effect.flatMap(() => discover(dir)),
          Effect.map((suite) => suite.gateNames),
        ),
      ),
    )
    expect(names).toEqual(["typecheck", "bun-test"])
  })

  test("a profile's committed baseline GRANDFATHERS existing findings — only new code gates", async () => {
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
    const CONFIG = [
      "export const customRules = [",
      "  {",
      '    id: "local/no-fixme",',
      '    defaultSeverity: "error",',
      '    description: "FIXME markers are banned",',
      '    fixHint: "fix it",',
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
    ].join("\n")
    const result = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "tsconfig.json", TSCONFIG)
          yield* writeWorkspaceFile(dir, "src/marked.ts", "// FIXME: legacy\nexport const a = 1\n")
          yield* writeWorkspaceFile(dir, "foundry.config.ts", CONFIG)
          // The finding the rule will produce, fingerprinted exactly as the
          // ratchet does (rule + file + normalized line content — the
          // sourceFile anchor lands on line 2, past the comment trivia).
          const grandfathered = new Finding({
            rule: RuleId.make("local/no-fixme"),
            severity: "error",
            message: "FIXME marker",
            location: Option.some(
              new SourceLocation({
                file: WorkspacePath.make("src/marked.ts"),
                line: 2,
                column: 1,
              }),
            ),
            fixHint: Option.none(),
          })
          const fp = fingerprint(grandfathered, Option.some("export const a = 1"))
          yield* writeWorkspaceFile(
            dir,
            ".foundry/baseline.json",
            JSON.stringify({ version: 1, fingerprints: [fp] }),
          )
          const armed = yield* discover(dir)
          const armedFindings = yield* armed.pipeline.gates[0]!
            .run({ rootDir: dir, files: [] })
            .pipe(Effect.provide(TsProjectCachedLive))

          // Same workspace, EMPTY baseline: everything gates again.
          yield* writeWorkspaceFile(
            dir,
            ".foundry/baseline.json",
            JSON.stringify({ version: 1, fingerprints: [] }),
          )
          const bare = yield* discover(dir)
          const bareFindings = yield* bare.pipeline.gates[0]!
            .run({ rootDir: dir, files: [] })
            .pipe(Effect.provide(TsProjectCachedLive))
          return { profile: armed.profile, armedFindings, bareFindings }
        }),
      ),
    )
    expect(Option.getOrThrow(result.profile)).toEqual({ rules: 1, baseline: 1 })
    expect(result.armedFindings).toEqual([])
    expect(result.bareFindings.length).toBe(1)
    expect(result.bareFindings[0]!.message).toBe("FIXME marker")
  })

  test("--test-cmd overrides the auto bun test; --no-test suppresses it", async () => {
    const { custom, suppressed } = await Effect.runPromise(
      withTempWorkspace(tmpdir(), (dir) =>
        Effect.gen(function* () {
          yield* writeWorkspaceFile(dir, "package.json", "{}")
          const custom = yield* discover(dir, {
            testCommand: Option.some("npm run check"),
          })
          yield* writeWorkspaceFile(dir, "tsconfig.json", "{}")
          const suppressed = yield* discover(dir, { noTest: true })
          return { custom: custom.gateNames, suppressed: suppressed.gateNames }
        }),
      ),
    )
    expect(custom).toEqual(["test-cmd"])
    expect(suppressed).toEqual(["typecheck"])
  })

  test("nothing discoverable → ConfigError, never an empty pipeline", async () => {
    const exit = await Effect.runPromiseExit(
      withTempWorkspace(tmpdir(), (dir) => discover(dir)),
    )
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("no gates discoverable")
  })

  test("vacuousAccepts: RED-FIRST names only the already-green checks; crashes read as red", async () => {
    const gate = (name: string, findings: ReadonlyArray<Finding>): Gate<never> => ({
      name: GateName.make(name),
      kind: "test",
      deterministic: true,
      run: () => Effect.succeed(findings),
    })
    const crashing: Gate<never> = {
      name: GateName.make("accept-crashes"),
      kind: "test",
      deterministic: true,
      run: () =>
        Effect.fail(new GateCrash({ gate: GateName.make("accept-crashes"), message: "boom" })),
    }
    const red = new Finding({
      rule: RuleId.make("test/accept-red"),
      severity: "error",
      message: "not built yet",
      location: Option.none(),
      fixHint: Option.none(),
    })
    const snapshot = Effect.succeed({ rootDir: "/tmp/x", files: [] })
    const vacuous = await Effect.runPromise(
      vacuousAccepts(
        [gate("accept-green", []), gate("accept-red", [red]), crashing],
        snapshot,
      ),
    )
    // Only the pre-green check is vacuous; a red or crashing one measures work.
    expect(vacuous).toEqual(["accept-green"])
    // An unsnapshottable workspace is advisory-silent, never an error.
    const silent = await Effect.runPromise(
      vacuousAccepts(
        [gate("accept-green", [])],
        Effect.fail(new WorkspaceError({ message: "gone" })),
      ),
    )
    expect(silent).toEqual([])

    // probeAccepts classifies the ENVIRONMENT class: an env/-ruled finding
    // (the commandGate's exit-127 shape) is a missing tool, not a code-red —
    // the human hears about it BEFORE attempts are spent (the zig run).
    const envFinding = new Finding({
      rule: RuleId.make("env/accept-zig-build"),
      severity: "error",
      message: "ENVIRONMENT: `zig build` exited 127 — its tool is missing from PATH",
      location: Option.none(),
      fixHint: Option.none(),
    })
    const probe = await Effect.runPromise(
      probeAccepts(
        [gate("accept-green", []), gate("accept-red", [red]), gate("accept-zig-build", [envFinding])],
        snapshot,
      ),
    )
    expect(probe.vacuous).toEqual(["accept-green"])
    expect(probe.missingTools).toEqual(["accept-zig-build"])
  })
})
