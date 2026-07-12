import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import {
  ConfigError,
  deriveLessons,
  fingerprintWorkspace,
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
  Gate,
  Implementor,
  ImplementorError,
  TsProject,
  WorkspaceError,
} from "@xandreed/foundry"
import { FileSystem } from "@xandreed/engine"
import type { AuthStore, SettingsStore, SpecDoc } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalShellLive,
  roleModelView,
  SandboxedShellLive,
} from "@xandreed/providers"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { makeEfferentImplementorLive } from "../implementor/efferentImplementor.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { curateWorkspaceMemory } from "../memory/curate.js"
import { loadWorkspaceMemory } from "../memory/inject.js"
import { makeSmithJudgeGate } from "../gates/judge.js"
import { loadQualityBar } from "../gates/profile.js"
import { discoverGateSuite, probeAccepts } from "../gates/suite.js"
import { gateRequestFromSpec, toForgeSpec } from "../spec/toForgeSpec.js"

/** Map foundry's loop hooks onto the smith event stream. */
export const smithForgeHooks = (
  publish: (event: SmithEvent) => Effect.Effect<void>,
): ForgeHooks => ({
  onAttemptStart: (attempt) => publish({ type: "attempt_start", attempt }),
  // filesTouched is the loop's OBSERVED set (fingerprint diff ∪ receipt
  // claim) — heredoc writes show up here even though the receipt misses them.
  onImplemented: (attempt, receipt, filesTouched) =>
    publish({
      type: "implement_end",
      attempt,
      filesTouched: filesTouched.map(String),
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
  /** Edge-composed gates (the judge) — empty on the scripted test seam. */
  extraGates: (spec: Spec) => ReadonlyArray<Gate<TsProject>> = () => [],
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  R | FileSystem
> =>
  Effect.gen(function* () {
    const spec = yield* buildSpec(run, doc)
    const { gateNames, pipeline, acceptGates, profile } = yield* discoverGateSuite(
      gateRequestFromSpec(run, doc),
      publish,
      extraGates(spec),
    )
    yield* publish({ type: "forge_start", spec, gateNames, doc })
    // The quality-profile status, LOUD either way: an armed bar names its
    // size; an unarmed workspace is told it runs on generic gates only.
    yield* publish({
      type: "profile_status",
      armed: Option.isSome(profile),
      ...Option.getOrElse(profile, () => ({ rules: 0, baseline: 0 })),
    })

    // RED-FIRST, before attempt 1 spends anything: an accept check that is
    // already green on the untouched workspace cannot measure the work, and
    // one that is red because its TOOL IS MISSING (exit 127) is red for a
    // reason no code edit moves — the zig run burned 3 attempts before this
    // probe existed. Warn and proceed — the human can Esc; the coder can
    // provision the tool into .local/bin (on PATH for it AND the gates).
    const probe = yield* probeAccepts(acceptGates, snapshotWorkspace(run.cwd))
    yield* probe.vacuous.length > 0
      ? publish({ type: "vacuous_checks", names: probe.vacuous })
      : Effect.void
    yield* probe.missingTools.length > 0
      ? publish({ type: "missing_tools", names: probe.missingTools })
      : Effect.void

    const result = yield* forge({
      spec,
      pipeline,
      workspaceDir: run.cwd,
      snapshot: snapshotWorkspace(run.cwd),
      fingerprint: fingerprintWorkspace(run.cwd),
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

/** The AGENTS.md convention, in precedence order. */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".efferent/rules.md"]
/** A rules file is standing context, not a wiki — the tail past the cap is
 *  dropped with a visible marker. */
const RULES_CAP_CHARS = 8_000

/**
 * The workspace's standing instruction file — the human's rules reach every
 * brief the way the forge-history lessons do. First existing, non-empty file
 * wins; an unreadable file reads as absent (the rules are an aid, never a
 * reason a run can't start).
 */
export const loadWorkspaceRules = (
  cwd: string,
): Effect.Effect<Option.Option<string>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    return yield* Effect.reduce(RULE_FILES, Option.none<string>(), (found, name) =>
      Option.isSome(found)
        ? Effect.succeed(found)
        : fs.exists(join(cwd, name)).pipe(
            Effect.flatMap((has) => (has ? fs.read(join(cwd, name)) : Effect.succeed(""))),
            Effect.map((text) => {
              const body = text.trim()
              if (body.length === 0) return Option.none<string>()
              const clipped =
                body.length <= RULES_CAP_CHARS
                  ? body
                  : `${body.slice(0, RULES_CAP_CHARS)}\n[…rules clipped…]`
              return Option.some(
                `## Workspace rules (${name} — the human's standing instructions; obey them)\n${clipped}`,
              )
            }),
            Effect.catchAll(() => Effect.succeed(Option.none<string>())),
          ),
    )
  })

/** The production session: the efferent coder as the Implementor, with the
 *  workspace's forge-history lessons folded into the attempt-1 brief. The
 *  implementor's LanguageModel is scoped to the CODE role (`codeModel ??
 *  model`) via the role view — the coder runs on the code model while the
 *  refiner stays general and the utility tier stays fast. */
export const runForgeSession = (
  run: SmithRunConfig,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  doc: Option.Option<SpecDoc> = Option.none(),
  /** The TUI's mid-turn steering seam — queued text lands at the coder's
   *  next step (absent in headless mode; there is no queue to drain). */
  pendingInput?: () => Effect.Effect<Option.Option<string>>,
): Effect.Effect<
  ForgeResult,
  ConfigError | ImplementorError | WorkspaceError,
  ImplementorServices | FileSystem | SettingsStore | AuthStore
> =>
  Effect.gen(function* () {
    const lessons = yield* loadForgeLessons(run.cwd)
    const rules = yield* loadWorkspaceRules(run.cwd)
    const memory = yield* loadWorkspaceMemory(run.cwd)
    // The ARMED quality bar, once per session: full+compact to the coder's
    // briefs, the judge form to the judge — every stage works to the same
    // contract the gates enforce.
    const doctrine = yield* loadQualityBar(run.cwd, gateRequestFromSpec(run, doc).configPath)

    // The JUDGE (default ON; spec opts out): a one-shot GENERAL-tier call,
    // deliberately distinct from the CODE-role implementor so the model
    // does not grade its own work,
    // closed over the ambient services HERE so the gate stays R = never and
    // the scripted seam stays LLM-free.
    const services = yield* Effect.context<SettingsStore | AuthStore>()
    const judgeCall = (prompt: string) =>
      LanguageModel.generateText({ prompt }).pipe(
        Effect.map((response) => response.text),
        Effect.provide(
          LanguageModelLive.pipe(Layer.provide(Layer.succeedContext(services))),
        ),
      )
    const judgeGates = (spec: Spec): ReadonlyArray<Gate<TsProject>> =>
      gateRequestFromSpec(run, doc).judge
        ? [
            makeSmithJudgeGate({
              spec,
              doc,
              call: judgeCall,
              doctrine: Option.map(doctrine, (bar) => bar.judge),
            }),
          ]
        : []

    const result = yield* runForgeSessionWith(
      run,
      publish,
      makeEfferentImplementorLive({
        cwd: run.cwd,
        publish,
        doc,
        lessons,
        rules,
        doctrine,
        memory,
        ...(pendingInput !== undefined ? { pendingInput } : {}),
      }).pipe(
        Layer.provide(LanguageModelLive.pipe(Layer.provide(roleModelView("code")))),
        // The SANDBOX applies to the coder's Bash ONLY: gates run the
        // human's own commands and :ship needs the real HOME (gh/ssh) —
        // both stay on the app-level local shell.
        Layer.provide(run.sandbox ? SandboxedShellLive(run.cwd) : LocalShellLive),
      ),
      doc,
      judgeGates,
    )
    // MEMORY v2 curation rides the PRODUCTION session only — deliberately
    // outside runForgeSessionWith, which is the scripted (LLM-free) test seam.
    yield* curateWorkspaceMemory({ cwd: run.cwd, run: result.run, publish })
    return result
  })
