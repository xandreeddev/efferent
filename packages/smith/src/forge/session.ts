import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import {
  ConfigError,
  deriveLessons,
  forge,
  makeFileRunSink,
  readRuns,
  renderLessons,
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
import type { AuthStore, FileSystem, SettingsStore, SpecDoc } from "@xandreed/engine"
import { LanguageModelLive, roleModelView } from "@xandreed/providers"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { makeEfferentImplementorLive } from "../implementor/efferentImplementor.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { discoverGateSuite, vacuousAccepts } from "../gates/suite.js"
import { gateRequestFromSpec, toForgeSpec } from "../spec/toForgeSpec.js"

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

/** The `Spec`, Schema-decoded so bad values surface as `ConfigError` (a
 *  `new Spec(...)` construction would THROW on a bounds violation). A locked
 *  SpecDoc wins over the flag path. */
const buildSpec = (
  run: SmithRunConfig,
  doc: Option.Option<SpecDoc>,
): Effect.Effect<Spec, ConfigError> =>
  Option.match(doc, {
    onSome: toForgeSpec,
    onNone: () =>
      Schema.decodeUnknown(Spec)({
        goal: run.task,
        acceptance: run.acceptance,
        limits: { maxAttempts: run.maxAttempts, budgetMillis: run.budgetMillis },
      }).pipe(
        Effect.mapError(
          (parseError) => new ConfigError({ path: "<flags>", message: String(parseError) }),
        ),
      ),
  })

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
  doc: Option.Option<SpecDoc> = Option.none(),
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  R | FileSystem
> =>
  Effect.gen(function* () {
    const spec = yield* buildSpec(run, doc)
    const { gateNames, pipeline, acceptGates } = yield* discoverGateSuite(
      gateRequestFromSpec(run, doc),
      publish,
    )
    yield* publish({ type: "forge_start", spec, gateNames, doc })

    // RED-FIRST, before attempt 1 spends anything: an accept check that is
    // already green on the untouched workspace cannot measure the work.
    // Warn and proceed — the human watching can Esc and tighten the spec.
    const vacuous = yield* vacuousAccepts(acceptGates, snapshotWorkspace(run.cwd))
    yield* vacuous.length > 0
      ? publish({ type: "vacuous_checks", names: vacuous })
      : Effect.void

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

/** Rendered forge-history lessons for a workspace — `None` when the history
 *  is empty or carries no recurring rejections. */
export const loadForgeLessons = (cwd: string): Effect.Effect<Option.Option<string>> =>
  readRuns(join(cwd, ".foundry", "runs")).pipe(
    Effect.map((runs) => {
      const rendered = renderLessons(deriveLessons(runs))
      return rendered.length > 0 ? Option.some(rendered) : Option.none<string>()
    }),
  )

/** The production session: the efferent coder as the Implementor, with the
 *  workspace's forge-history lessons folded into the attempt-1 brief. The
 *  implementor's LanguageModel is scoped to the CODE role (`codeModel ??
 *  model`) via the role view — the coder runs on the code model while the
 *  refiner stays general and the utility tier stays fast. */
export const runForgeSession = (
  run: SmithRunConfig,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  doc: Option.Option<SpecDoc> = Option.none(),
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  ImplementorServices | FileSystem | SettingsStore | AuthStore
> =>
  Effect.flatMap(loadForgeLessons(run.cwd), (lessons) =>
    runForgeSessionWith(
      run,
      publish,
      makeEfferentImplementorLive({ cwd: run.cwd, publish, doc, lessons }).pipe(
        Layer.provide(LanguageModelLive.pipe(Layer.provide(roleModelView("code")))),
      ),
      doc,
    ),
  )
