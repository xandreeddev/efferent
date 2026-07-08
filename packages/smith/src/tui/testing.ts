import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { createComponent } from "solid-js"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { Deferred, Effect, Layer, Option, Queue, Schema, Scope } from "effect"
import {
  AuthStore,
  EngineSettings,
  Shell,
  ShellResult,
  SettingsStore,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/engine"
import type { SpecDoc } from "@xandreed/engine"
import type { Credential, ModelRole } from "@xandreed/engine"
import { FactoryRun } from "@xandreed/foundry"
import {
  LocalFileSystemLive,
  SqliteConversationStoreLive,
} from "@xandreed/providers"
import { SMITH_LIMIT_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { RefineAgent } from "../refine/session.js"
import { writeSpecDoc } from "../spec/store.js"
import { runEventPump } from "./events/pump.js"
import { makeWorkspaceBody } from "./runtime.js"
import type { TuiServices, WorkspaceSeams } from "./runtime.js"
import { createSmithStore } from "./state/store.js"
import type { SmithStore, SmithTuiContext } from "./state/store.js"
import { App } from "./view/App.js"

/**
 * The TUI test harness — the REAL App over OpenTUI's headless test renderer
 * (no TTY, no terminal handshake; input injected as raw bytes through the
 * production StdinParser; frames captured as plain text). The context is the
 * REAL workspace wiring (`makeWorkspaceBody`) with the scripted seams the
 * scenario packs already use — so what these tests exercise is what ships.
 */

export interface TestTuiOptions {
  /** SpecDocs written to the workspace before boot (the dashboard reads them). */
  readonly specs?: ReadonlyArray<SpecDoc>
  /** FactoryRuns persisted to .foundry/runs before boot. */
  readonly runs?: ReadonlyArray<FactoryRun>
  readonly settings?: EngineSettings
  readonly credentials?: ReadonlyMap<string, Credential>
  readonly seams?: WorkspaceSeams
  readonly width?: number
  readonly height?: number
}

export interface TestTui {
  readonly setup: TestRendererSetup
  readonly store: SmithStore
  readonly ctx: SmithTuiContext
  readonly cwd: string
  /** Render one pass, then capture the frame as plain text. */
  readonly frame: () => Promise<string>
  /** Pump N spinner ticks (the palette/elapsed readouts poll on them). */
  readonly tick: (n?: number) => void
  /** The exit code once the session ended (None while alive). */
  readonly exitCode: Effect.Effect<Option.Option<number>>
  /** Role-setter calls the scripted SettingsStore recorded. */
  readonly setRoleCalls: ReadonlyArray<{ role: ModelRole; selection: Option.Option<string> }>
  readonly dispose: () => Promise<void>
}

const defaultSettings = new EngineSettings({
  model: Option.some("opencode:kimi-k2.6"),
  codeModel: Option.some("opencode:kimi-k2.7-code"),
  fastModel: Option.some("opencode:deepseek-v4-flash"),
})

export const testRunConfig = (cwd: string): SmithRunConfig => ({
  task: "",
  cwd,
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  allowBash: false,
  headless: false,
  testCommand: Option.none(),
  noTest: true,
  configPath: Option.none(),
})

/** A refiner that immediately proposes a fixed spec — the scripted twin. */
export const proposingRefineAgent = (spec: {
  readonly goal: string
  readonly acceptance: ReadonlyArray<string>
  readonly checks: ReadonlyArray<{ readonly name: string; readonly command: string }>
}): RefineAgent => (_cid, _prompt, tools) =>
  tools
    .propose({
      goal: spec.goal,
      acceptance: spec.acceptance,
      constraints: undefined,
      nonGoals: undefined,
      checks: spec.checks,
      maxAttempts: undefined,
      budgetMinutes: undefined,
    })
    .pipe(Effect.asVoid, Effect.orDie)

/** A refiner that NEVER resolves — the stalled-model twin (interruptible). */
export const stalledRefineAgent: RefineAgent = () => Effect.never

export const bootTestTui = async (options: TestTuiOptions = {}): Promise<TestTui> => {
  const cwd = mkdtempSync(join(tmpdir(), "smith-tui-test-"))
  const run = testRunConfig(cwd)
  const setRoleCalls: Array<{ role: ModelRole; selection: Option.Option<string> }> = []
  const credentials =
    options.credentials ??
    new Map<string, Credential>([["opencode", { type: "api_key", key: "test" }]])

  const services = Layer.mergeAll(
    LocalFileSystemLive,
    SqliteConversationStoreLive(join(cwd, ".efferent", "smith.db")),
    Layer.succeed(LanguageModel.LanguageModel, {} as never),
    Layer.succeed(Shell, {
      exec: () => Effect.succeed(new ShellResult({ stdout: "", stderr: "", exitCode: 0 })),
    }),
    Layer.succeed(UtilityLlm, {
      complete: () =>
        Effect.succeed(
          new UtilityCompletion({
            text: "scripted session title",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
          }),
        ),
    }),
    Layer.succeed(SettingsStore, {
      load: Effect.succeed(options.settings ?? defaultSettings),
      setRole: (role: ModelRole, selection: Option.Option<string>) =>
        Effect.sync(() => {
          setRoleCalls.push({ role, selection })
        }),
    }),
    Layer.succeed(AuthStore, {
      all: Effect.succeed(credentials),
      get: (p: string) => Effect.succeed(Option.fromNullable(credentials.get(p))),
      resolveKey: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      remove: () => Effect.void,
    } as never),
  )

  // Fixtures on the REAL workspace fs — the dashboard reads what smith reads.
  const seeded = Effect.gen(function* () {
    yield* Effect.forEach(options.specs ?? [], (doc) => writeSpecDoc(cwd, doc))
    const runsDir = join(cwd, ".foundry", "runs")
    yield* Effect.sync(() => mkdirSync(runsDir, { recursive: true }))
    yield* Effect.forEach(options.runs ?? [], (record) =>
      Effect.sync(() =>
        writeFileSync(
          join(runsDir, `${record.id}.json`),
          JSON.stringify(Schema.encodeSync(FactoryRun)(record)),
        ),
      ),
    )
  })

  const boot = Effect.gen(function* () {
    // Build the layer INTO the harness scope — Effect.provide would close
    // scoped resources (the sqlite handle) the moment boot finished.
    const context = yield* Layer.build(services)
    return yield* Effect.gen(function* () {
      yield* seeded
    const queue = yield* Queue.unbounded<SmithEvent>()
    const publish = (event: SmithEvent) => Queue.offer(queue, event).pipe(Effect.asVoid)
    const rt = yield* Effect.runtime<TuiServices>()
    const store = createSmithStore(run, { general: "g", code: "c", fast: "f" }, "idle")
    const exitDeferred = yield* Deferred.make<number>()
    yield* Effect.forkScoped(runEventPump(queue, store.reduce))
    const ctx = yield* makeWorkspaceBody(run, options.seams ?? {})({
      store,
      publish,
      rt,
      exitDeferred,
    })
      return { ctx, store, exitDeferred }
    }).pipe(Effect.provide(context))
  })

  const scope = Effect.runSync(Scope.make())
  const { ctx, store, exitDeferred } = await Effect.runPromise(Scope.extend(boot, scope))

  const setup = await testRender(() => createComponent(App, { ctx }), {
    width: options.width ?? 170,
    height: options.height ?? 44,
  })

  return {
    setup,
    store,
    ctx,
    cwd,
    frame: async () => {
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
    tick: (n = 1) => {
      Array.from({ length: n }).forEach(() => store.tickSpinner())
    },
    exitCode: Deferred.poll(exitDeferred).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<number>()),
          onSome: (fiberish) => Effect.map(fiberish, Option.some),
        }),
      ),
    ),
    setRoleCalls,
    dispose: async () => {
      setup.renderer.destroy()
      await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never))
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}
