import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import {
  ConfigError,
  forge,
  makeFileRunSink,
  snapshotWorkspace,
  Spec,
  TsProjectFreshLive,
} from "@xandreed/foundry"
import type {
  ForgeHooks,
  ForgeResult,
  Implementor,
  ImplementorError,
  WorkspaceError,
} from "@xandreed/foundry"
import type { FileSystem } from "@xandreed/sdk-core"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { makeEfferentImplementorLive } from "../implementor/efferentImplementor.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { discoverGateSuite } from "../gates/suite.js"

/** Map foundry's loop hooks onto the smith event stream. */
export const smithForgeHooks = (
  publish: (event: SmithEvent) => Effect.Effect<void>,
): ForgeHooks => ({
  onAttemptStart: (attempt) => publish({ type: "attempt_start", attempt }),
  onImplemented: (attempt, receipt) =>
    publish({
      type: "implement_end",
      attempt,
      filesTouched: receipt.filesTouched.map(String),
      ref: receipt.ref ?? Option.none(),
    }),
  onReport: (attempt, report, feedback) =>
    publish({ type: "gate_report", attempt, report, feedback }),
})

/** The `Spec`, Schema-decoded so bad flag values surface as `ConfigError`
 *  (a `new Spec(...)` construction would THROW on a bounds violation). */
const buildSpec = (run: SmithRunConfig): Effect.Effect<Spec, ConfigError> =>
  Schema.decodeUnknown(Spec)({
    goal: run.task,
    acceptance: run.acceptance,
    limits: { maxAttempts: run.maxAttempts, budgetMillis: run.budgetMillis },
  }).pipe(
    Effect.mapError(
      (parseError) => new ConfigError({ path: "<flags>", message: String(parseError) }),
    ),
  )

/**
 * One smith forge session over an EXPLICIT implementor Layer — the seam tests
 * use with foundry's scripted implementor (no keys, no LLM). Build the `Spec`
 * from the invocation, discover the workspace's gate suite, and drive
 * foundry's `forge` IN PLACE over `cwd`. Every stage reports onto the smith
 * event stream; the artifact lands in `<cwd>/.foundry/runs/`.
 */
export const runForgeSessionWith = <R>(
  run: SmithRunConfig,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  implementor: Layer.Layer<Implementor, never, R>,
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  R | FileSystem
> =>
  Effect.gen(function* () {
    const spec = yield* buildSpec(run)
    const { gateNames, pipeline } = yield* discoverGateSuite(run, publish)
    yield* publish({ type: "forge_start", spec, gateNames })

    const result = yield* forge({
      spec,
      pipeline,
      workspaceDir: run.cwd,
      snapshot: snapshotWorkspace(run.cwd),
      hooks: smithForgeHooks(publish),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          // Fresh per snapshot: the implementor rewrites files between attempts,
          // a memoized ts.Program would judge attempt N against N-1.
          TsProjectFreshLive,
          implementor,
          makeFileRunSink(join(run.cwd, ".foundry", "runs")),
        ),
      ),
    )
    yield* publish({ type: "forge_end", run: result.run, artifact: result.artifact })
    return result
  }).pipe(
    Effect.tapError((error) =>
      publish({ type: "forge_error", message: String(error) }),
    ),
    Effect.withSpan("smith.session"),
  )

/** The production session: the efferent coder as the Implementor. */
export const runForgeSession = (
  run: SmithRunConfig,
  publish: (event: SmithEvent) => Effect.Effect<void>,
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  ImplementorServices | FileSystem
> => runForgeSessionWith(run, publish, makeEfferentImplementorLive({ cwd: run.cwd, publish }))
