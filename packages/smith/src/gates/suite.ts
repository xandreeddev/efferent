import { join } from "node:path"
import { Array as Arr, Effect, Option } from "effect"
import {
  ConfigError,
  gatesFromConfig,
  loadConfig,
  makeTypecheckGate,
} from "@xandreed/foundry"
import type { Gate, Pipeline, TsProject, Workspace, WorkspaceError } from "@xandreed/foundry"
import { FileSystem } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { GateSuiteRequest } from "../spec/toForgeSpec.js"
import { makeCommandGate } from "./commandGate.js"

export interface GateSuite {
  readonly pipeline: Pipeline<TsProject>
  readonly gateNames: ReadonlyArray<string>
  /** The spec's own accept gates, UNwrapped — the red-first probe runs these
   *  against the untouched workspace without gate_start noise. */
  readonly acceptGates: ReadonlyArray<Gate<never>>
}

/**
 * RED-FIRST: the accept gates that already PASS on the untouched workspace.
 * A grep-style check that is green before any work happens is VACUOUS — it
 * cannot measure this spec's work, and an all-vacuous suite would accept a
 * no-op run. TDD's red-first discipline applied to the gate suite. Advisory
 * by design: a crash or an unsnapshottable workspace reads as "not vacuous"
 * (the check is red — exactly what red-first wants), never an error.
 */
export interface AcceptProbe {
  /** Checks already GREEN on the untouched workspace (cannot measure work). */
  readonly vacuous: ReadonlyArray<string>
  /** Checks red for an ENVIRONMENT reason (exit 127 — the tool is missing):
   *  red-first reads them as properly red, but no code change can move them
   *  (the zig run burned 3 attempts against exactly this). Advisory: with
   *  the `.local/bin` parity the coder CAN provision the tool. */
  readonly missingTools: ReadonlyArray<string>
}

/** One probe run of the accept gates against the untouched workspace,
 *  classified. Advisory by design: a crash or an unsnapshottable workspace
 *  reads as "red, runnable" — never an error. */
export const probeAccepts = (
  gates: ReadonlyArray<Gate<never>>,
  snapshot: Effect.Effect<Workspace, WorkspaceError>,
): Effect.Effect<AcceptProbe> =>
  gates.length === 0
    ? Effect.succeed({ vacuous: [], missingTools: [] })
    : snapshot.pipe(
        Effect.flatMap((workspace) =>
          Effect.forEach(gates, (gate) =>
            gate.run(workspace).pipe(
              Effect.map((findings): AcceptProbe => {
                const errors = findings.filter((finding) => finding.severity === "error")
                if (errors.length === 0) return { vacuous: [String(gate.name)], missingTools: [] }
                return errors.some((finding) => String(finding.rule).startsWith("env/"))
                  ? { vacuous: [], missingTools: [String(gate.name)] }
                  : { vacuous: [], missingTools: [] }
              }),
              Effect.orElseSucceed((): AcceptProbe => ({ vacuous: [], missingTools: [] })),
            ),
          ),
        ),
        Effect.map((probes) => ({
          vacuous: probes.flatMap((p) => p.vacuous),
          missingTools: probes.flatMap((p) => p.missingTools),
        })),
        Effect.orElseSucceed((): AcceptProbe => ({ vacuous: [], missingTools: [] })),
      )

export const vacuousAccepts = (
  gates: ReadonlyArray<Gate<never>>,
  snapshot: Effect.Effect<Workspace, WorkspaceError>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(probeAccepts(gates, snapshot), (probe) => probe.vacuous)

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
 * The workspace's gate suite, discovered in precedence order (the request is
 * pre-merged: CLI flags > spec frontmatter — see `gateRequestFromSpec`):
 * 1. an explicit foundry `GateSuiteConfig` module (flag or spec `gates.config`);
 * 2. `<cwd>/foundry.config.ts` — the workspace's own suite (same file
 *    `foundry check` uses), loaded via foundry's `loadConfig` + `gatesFromConfig`;
 * 3. defaults — a typecheck gate when `tsconfig.json` exists, plus a `bun test`
 *    command gate when `package.json` exists (`testCommand` overrides —
 *    run through `bash -c` so pipes/env work; `noTest` suppresses).
 * Plus one rank-2 `accept-<name>` command gate per spec check — the spec's
 * machine-checkable acceptance criteria, enforced.
 *
 * No discoverable gate at all is a `ConfigError`: a forge run with nothing to
 * verify would accept anything (and the pipeline's gates are non-empty by type).
 */
export const discoverGateSuite = (
  request: GateSuiteRequest,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  /** Edge-composed additions (the judge gate) — R already discharged there;
   *  the staged pipeline orders them by rank like any other gate. */
  extraGates: ReadonlyArray<Gate<TsProject>> = [],
): Effect.Effect<GateSuite, ConfigError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const exists = (rel: string) =>
      fs.exists(join(request.cwd, rel)).pipe(Effect.catchAll(() => Effect.succeed(false)))

    const workspaceConfig = join(request.cwd, "foundry.config.ts")
    const configPath = yield* Option.match(request.configPath, {
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

    const testGate = request.noTest
      ? []
      : yield* Option.match(request.testCommand, {
          onSome: (command) =>
            Effect.succeed([
              makeCommandGate({ name: "test-cmd", argv: ["bash", "-c", command] }),
            ]),
          onNone: () =>
            Effect.map(exists("package.json"), (has) =>
              has ? [makeCommandGate({ name: "bun-test", argv: ["bun", "test"] })] : [],
            ),
        })

    // The spec's machine-checkable acceptance: each check is a named command
    // that must exit 0 — a rank-2 gate like any other, fail-closed.
    const acceptGates = request.checks.map((check) =>
      makeCommandGate({
        name: `accept-${check.name}`,
        argv: ["bash", "-c", check.command],
      }),
    )

    const gates: ReadonlyArray<Gate<TsProject>> = [
      ...configured,
      ...typecheck,
      ...testGate,
      ...acceptGates,
      ...extraGates,
    ]
    if (!Arr.isNonEmptyReadonlyArray(gates)) {
      return yield* Effect.fail(
        new ConfigError({
          path: request.cwd,
          message:
            "no gates discoverable: no foundry.config.ts, no tsconfig.json, no package.json (and no --config/--test-cmd, no spec checks). A forge run with nothing to verify would accept anything.",
        }),
      )
    }
    const wrapped = Arr.map(gates, (gate) => withGateEvents(gate, publish))
    return {
      pipeline: { gates: wrapped, policy: "staged" as const },
      gateNames: gates.map((gate) => String(gate.name)),
      acceptGates,
    }
  })
