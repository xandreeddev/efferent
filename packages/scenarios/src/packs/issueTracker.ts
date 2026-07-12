import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Option, Ref } from "effect"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalShellLive,
  McpClientLive,
  SqliteConversationStoreLive,
  UtilityLlmLive,
} from "@xandreed/providers"
import {
  makeRefineSession,
  runForgeSession,
  SmithSettingsStoreLive,
  SMITH_LIMIT_DEFAULTS,
} from "@xandreed/smith"
import type { SmithEvent, SmithRunConfig } from "@xandreed/smith"
import type { Check, Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { eventOrder, eventWhere, fileContains, fileExists } from "../framework/evidence.js"

interface IssueTrackerWorld {
  readonly dir: string
  readonly architecturePassed: Ref.Ref<boolean>
  readonly testsPassed: Ref.Ref<boolean>
}

const run = (
  world: IssueTrackerWorld,
  argv: ReadonlyArray<string>,
  result: Ref.Ref<boolean>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], {
        cwd: world.dir,
        stdout: "ignore",
        stderr: "ignore",
      })
      return child.exited
    },
    catch: () => -1,
  }).pipe(
    Effect.flatMap((exit) => Ref.set(result, exit === 0)),
    Effect.orElseSucceed(() => undefined),
  )

const refPassed = (
  name: string,
  select: (world: IssueTrackerWorld) => Ref.Ref<boolean>,
): Check<IssueTrackerWorld> => ({
  name,
  severity: "hard",
  run: (world) =>
    Ref.get(select(world)).pipe(
      Effect.map((pass) => ({ pass, ...(pass ? {} : { detail: `${name} failed` }) })),
    ),
})

interface IssueTrackerLiveWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<SmithEvent>
  readonly act: Effect.Effect<void, unknown>
}

const LIVE_TASK =
  "Add support for reopening a closed issue. Add ReopenIssueInput/Output schemas in src/usecases/reopen-issue.usecase.ts, implement reopenIssue in the paired .usecase.functions.ts file, keep entity behavior in the paired entity functions file, and add tests. Preserve the Effect-native ports-and-adapters architecture."

const liveRun = (cwd: string): SmithRunConfig => ({
  task: LIVE_TASK,
  cwd,
  acceptance: [
    "a closed issue can be reopened through an Effect-native use case",
    "the qualified entity/use-case file roles remain intact",
    "bun test and the package profile pass",
  ],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
  ship: false,
  sandbox: true,
})

const liveServices = (runConfig: SmithRunConfig) =>
  Layer.mergeAll(
    SqliteConversationStoreLive(join(runConfig.cwd, ".efferent", "smith.db")),
    LocalFileSystemLive,
    LocalShellLive,
    LanguageModelLive,
    UtilityLlmLive,
    McpClientLive(runConfig.cwd, homedir()),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LocalAuthStoreLive(runConfig.cwd, homedir()),
        SmithSettingsStoreLive(runConfig, runConfig.cwd, homedir()),
      ),
    ),
  )

const liveScenario = scenario<IssueTrackerLiveWorld>({
  name: "real refine → lock → forge on the issue-tracker architecture",
  modes: ["live"],
  boot: Effect.gen(function* () {
    const parent = mkdtempSync(join(tmpdir(), "scenario-issue-tracker-live-"))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(parent, { recursive: true, force: true })),
    )
    const source = resolve(import.meta.dir, "../../../issue-tracker-example")
    const dir = join(parent, "issue-tracker")
    yield* Effect.sync(() => {
      cpSync(source, dir, { recursive: true })
      symlinkSync(resolve(import.meta.dir, "../../../../node_modules"), join(dir, "node_modules"), "dir")
    })
    const runConfig = liveRun(dir)
    const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
    const publish = (event: SmithEvent) => Ref.update(eventsRef, (events) => [...events, event])
    const services = yield* Layer.build(liveServices(runConfig))
    const act = Effect.gen(function* () {
      const refine = yield* makeRefineSession(dir, publish, { unattended: true }).pipe(
        Effect.provide(services),
      )
      yield* refine.send(LIVE_TASK).pipe(Effect.provide(services))
      const locked = yield* refine.lock.pipe(Effect.provide(services))
      yield* runForgeSession(runConfig, publish, Option.some(locked.doc)).pipe(
        Effect.provide(services),
      )
    })
    return {
      dir,
      events: () => Effect.runSync(Ref.get(eventsRef)),
      act,
    }
  }),
  steps: [
    {
      name: "the real model extends the reference without escaping its architecture",
      act: (world) => world.act,
      checks: [
        eventOrder(["spec_draft", "spec_locked", "forge_start", "attempt_start", "forge_end"]),
        eventWhere<SmithEvent>("production forge accepted", (events) =>
          events.some((event) => event.type === "forge_end" && event.run.outcome._tag === "accepted"),
        ),
        fileExists("src/usecases/reopen-issue.usecase.ts"),
        fileExists("src/usecases/reopen-issue.usecase.functions.ts"),
        fileContains("src/usecases/reopen-issue.usecase.functions.ts", "Effect"),
      ],
    },
    {
      name: "the persisted conversation and artifact exist",
      act: () => Effect.void,
      checks: [
        {
          name: "smith database persisted",
          severity: "hard",
          run: (world) =>
            Effect.sync(() => ({
              pass: existsSync(join(world.dir, ".efferent", "smith.db")),
            })),
        },
      ],
    },
  ],
})

export const issueTrackerPack: Pack = {
  name: "issue-tracker",
  threshold: 1,
  meta: { "reference-architecture": "v1" },
  scenarios: [
    liveScenario,
    scenario<IssueTrackerWorld>({
      name: "reference package enforces and demonstrates the Effect architecture",
      modes: ["scripted"],
      boot: Effect.gen(function* () {
        const dir = join(import.meta.dir, "..", "..", "..", "issue-tracker-example")
        return {
          dir,
          architecturePassed: yield* Ref.make(false),
          testsPassed: yield* Ref.make(false),
        }
      }),
      steps: [
        {
          name: "the reference source exposes the agreed file roles",
          act: () => Effect.void,
          checks: [
            fileExists("src/domain/issue.entity.ts"),
            fileExists("src/domain/issue.entity.functions.ts"),
            fileExists("src/usecases/assign-issue.usecase.ts"),
            fileExists("src/usecases/assign-issue.usecase.functions.ts"),
            fileExists("src/ports/issue-repository.port.ts"),
            fileExists("src/adapters/in-memory-issue-repository.adapter.ts"),
            fileContains("src/usecases/triage-backlog.usecase.functions.ts", "Effect.forEach"),
          ],
        },
        {
          name: "its package-owned profile is green",
          act: (world) =>
            run(
              world,
              ["bun", "../foundry/src/main.ts", "check", "--config", "foundry.config.ts"],
              world.architecturePassed,
            ),
          checks: [refPassed("issue-tracker architecture gates", (world) => world.architecturePassed)],
        },
        {
          name: "its behavior tests are green",
          act: (world) => run(world, ["bun", "test", "src"], world.testsPassed),
          checks: [refPassed("issue-tracker behavior tests", (world) => world.testsPassed)],
        },
      ],
    }),
  ],
}
