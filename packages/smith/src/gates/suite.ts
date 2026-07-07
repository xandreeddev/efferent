import { join } from "node:path"
import { Array as Arr, Effect, Option } from "effect"
import {
  ConfigError,
  gatesFromConfig,
  loadConfig,
  makeTypecheckGate,
} from "@xandreed/foundry"
import type { Gate, Pipeline, TsProject } from "@xandreed/foundry"
import { FileSystem } from "@xandreed/sdk-core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import { makeCommandGate } from "./commandGate.js"

export interface GateSuite {
  readonly pipeline: Pipeline<TsProject>
  readonly gateNames: ReadonlyArray<string>
}

/** Decorate a gate so its start is visible on the smith event stream. */
export const withGateEvents = <R>(
  gate: Gate<R>,
  publish: (event: SmithEvent) => Effect.Effect<void>,
): Gate<R> => ({
  ...gate,
  run: (workspace) =>
    publish({ type: "gate_start", gate: String(gate.name) }).pipe(
      Effect.zipRight(gate.run(workspace)),
    ),
})

/**
 * The workspace's gate suite, discovered in precedence order:
 * 1. `--config <f>` — an explicit foundry `GateSuiteConfig` module;
 * 2. `<cwd>/foundry.config.ts` — the workspace's own suite (same file
 *    `foundry check` uses), loaded via foundry's `loadConfig` + `gatesFromConfig`;
 * 3. defaults — a typecheck gate when `tsconfig.json` exists, plus a `bun test`
 *    command gate when `package.json` exists (`--test-cmd` overrides the
 *    command — run through `bash -c` so pipes/env work; `--no-test` suppresses).
 *
 * No discoverable gate at all is a `ConfigError`: a forge run with nothing to
 * verify would accept anything (and the pipeline's gates are non-empty by type).
 */
export const discoverGateSuite = (
  run: SmithRunConfig,
  publish: (event: SmithEvent) => Effect.Effect<void>,
): Effect.Effect<GateSuite, ConfigError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const exists = (rel: string) =>
      fs.exists(join(run.cwd, rel)).pipe(Effect.catchAll(() => Effect.succeed(false)))

    const workspaceConfig = join(run.cwd, "foundry.config.ts")
    const configPath = yield* Option.match(run.configPath, {
      onSome: (path) => Effect.succeed(Option.some(path)),
      onNone: () =>
        Effect.map(exists("foundry.config.ts"), (has) =>
          has ? Option.some(workspaceConfig) : Option.none<string>(),
        ),
    })

    const configured = yield* Option.match(configPath, {
      onNone: () => Effect.succeed<ReadonlyArray<Gate<TsProject>>>([]),
      onSome: (path) =>
        Effect.map(loadConfig(path), ({ config }) => gatesFromConfig(config)),
    })

    const typecheck =
      Option.isNone(configPath) && (yield* exists("tsconfig.json"))
        ? [makeTypecheckGate("tsconfig.json")]
        : []

    const testGate = run.noTest
      ? []
      : yield* Option.match(run.testCommand, {
          onSome: (command) =>
            Effect.succeed([
              makeCommandGate({ name: "test-cmd", argv: ["bash", "-c", command] }),
            ]),
          onNone: () =>
            Effect.map(exists("package.json"), (has) =>
              has ? [makeCommandGate({ name: "bun-test", argv: ["bun", "test"] })] : [],
            ),
        })

    const gates: ReadonlyArray<Gate<TsProject>> = [...configured, ...typecheck, ...testGate]
    if (!Arr.isNonEmptyReadonlyArray(gates)) {
      return yield* Effect.fail(
        new ConfigError({
          path: run.cwd,
          message:
            "no gates discoverable: no foundry.config.ts, no tsconfig.json, no package.json (and no --config/--test-cmd). A forge run with nothing to verify would accept anything.",
        }),
      )
    }
    const wrapped = Arr.map(gates, (gate) => withGateEvents(gate, publish))
    return {
      pipeline: { gates: wrapped, policy: "staged" as const },
      gateNames: gates.map((gate) => String(gate.name)),
    }
  })
