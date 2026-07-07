import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { withTempWorkspace, writeWorkspaceFile } from "@xandreed/foundry"
import { LocalFileSystemLive } from "@xandreed/sdk-adapters"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { gateRequestFromSpec } from "../spec/toForgeSpec.js"
import { discoverGateSuite } from "./suite.js"

const runFor = (cwd: string, over: Partial<SmithRunConfig> = {}): SmithRunConfig => ({
  task: "t",
  cwd,
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  allowBash: false,
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
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
})
