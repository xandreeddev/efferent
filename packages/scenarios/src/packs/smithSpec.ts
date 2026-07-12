import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Ref } from "effect"
import { ConversationId, ConversationStore, Shell, specSlug } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalShellLive,
  McpClientLive,
  SqliteConversationStoreLive,
  UtilityLlmLive,
} from "@xandreed/providers"
import { makeScriptedImplementor } from "@xandreed/foundry"
import {
  loadForgeLessons,
  makeRefineSession,
  renderTrailForDigest,
  runForgeSession,
  runForgeSessionWith,
  SMITH_CODER_PROMPT_VERSION,
  SMITH_LIMIT_DEFAULTS,
  SmithSettingsStoreLive,
} from "@xandreed/smith"
import type { RefineAgent, RefineSession, SmithEvent, SmithRunConfig } from "@xandreed/smith"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { eventCount, eventOrder, eventWhere, fileContains, fileExists } from "../framework/evidence.js"
import { CRITIC_RUBRIC_VERSION, makeTrajectoryCritic } from "../judges/trajectoryCritic.js"
import { generalTierCall } from "../live/llm.js"

/**
 * The smith-spec pack: the refine → lock → forge pipeline as a SCENARIO —
 * the same flow the live battery proved, now a standing regression. The
 * scripted twin runs key-free on every CI push (harness wiring end-to-end:
 * events, files, gate staging); live scenarios ride the same checks with the
 * real model (key-gated) and land with their own PR.
 */

const GOAL = "Create out.txt containing done in the workspace."

interface SmithWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<SmithEvent>
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
  readonly run: SmithRunConfig
  readonly refine: RefineSession
}

const runFor = (cwd: string): SmithRunConfig => ({
  task: GOAL,
  cwd,
  acceptance: ["out.txt exists"],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  headless: true,
  testCommand: Option.none(),
  noTest: true,
  configPath: Option.none(),
  ship: false,
  sandbox: false,
})

/** The refine session's captured context wants the run services even though
 *  the scripted agent never touches the model. */
const stubRunServices = Layer.mergeAll(
  Layer.succeed(LanguageModel.LanguageModel, {} as never),
  Layer.succeed(Shell, {} as never),
  Layer.succeed(ConversationStore, {
    create: () =>
      Effect.succeed(ConversationId.make("00000000-0000-4000-8000-0000005cee01")),
  } as never),
)

/** The scripted refiner: one deterministic propose through the session's own
 *  handlers (the same seam the real agent uses — slug identity included). */
const scriptedRefiner: RefineAgent = (_cid, _prompt, tools) =>
  tools
    .propose({
      goal: GOAL,
      acceptance: ["out.txt exists", "out.txt contains done"],
      constraints: ["touch nothing else"],
      nonGoals: undefined,
      checks: [
        { name: "out-exists", command: "test -f out.txt" },
        { name: "out-content", command: "grep -q done out.txt" },
      ],
      maxAttempts: undefined,
      budgetMinutes: undefined,
    })
    .pipe(Effect.asVoid, Effect.orDie)

const bootSmithWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-smith-"))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  yield* Effect.sync(() => writeFileSync(join(dir, "package.json"), `{ "name": "toy" }`))
  const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
  const publish = (event: SmithEvent) => Ref.update(eventsRef, (all) => [...all, event])
  const refine = yield* makeRefineSession(dir, publish, {
    unattended: true,
    agent: scriptedRefiner,
  }).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(stubRunServices))
  return {
    dir,
    // A sync snapshot accessor for the evidence combinators (Ref reads are sync).
    events: () => Effect.runSync(Ref.get(eventsRef)),
    publish,
    run: runFor(dir),
    refine,
  } satisfies SmithWorld
})

const SLUG = specSlug(GOAL)
const SPEC_REL = `.efferent/specs/${SLUG}.md`

/* ------------------------------------------------------------------ */
/* The LIVE scenario — the selftest, SCORED: real refine → lock → the   */
/* PRODUCTION forge session (judge gate + memory curation ON), with the */
/* trajectory critic grading the implementor's process.                 */
/* ------------------------------------------------------------------ */

const LIVE_TASK =
  "Create src/add.ts exporting a pure function add(a: number, b: number): number returning their sum, and src/add.test.ts covering it with bun:test (describe/test/expect, at least three cases)."

interface SmithLiveWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<SmithEvent>
  readonly trail: Effect.Effect<string>
  /** The whole refine→lock→forge pipeline, assembled at boot, run as the
   *  ONE act (a single scored unit). */
  readonly act: Effect.Effect<void, unknown>
}

const liveRunFor = (cwd: string): SmithRunConfig => ({
  ...runFor(cwd),
  task: LIVE_TASK,
  acceptance: [
    "src/add.ts exports add(a, b) returning the sum",
    "src/add.test.ts covers it and bun test exits 0",
  ],
  noTest: false,
})

/** The production stack (mirrors smith's `smithAppLive`) over a throwaway
 *  workspace — settings resolve smith's model DEFAULTS + the global auth,
 *  exactly like `bun run smith selftest`. */
const liveServices = (run: SmithRunConfig) =>
  Layer.mergeAll(
    SqliteConversationStoreLive(join(run.cwd, ".efferent", "smith.db")),
    LocalFileSystemLive,
    LocalShellLive,
    LanguageModelLive,
    UtilityLlmLive,
    McpClientLive(run.cwd, homedir()),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LocalAuthStoreLive(run.cwd, homedir()),
        SmithSettingsStoreLive(run, run.cwd, homedir()),
      ),
    ),
  )

const liveScenario = scenario<SmithLiveWorld>({
  name: "selftest, scored: real refine → lock → production forge",
  modes: ["live"],
  boot: Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "scenario-smith-live-"))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    )
    yield* Effect.sync(() =>
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "smith-live", type: "module", private: true }, null, 2)}\n`,
      ),
    )
    const run = liveRunFor(dir)
    const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
    const publish = (event: SmithEvent) => Ref.update(eventsRef, (all) => [...all, event])
    const services = yield* Layer.build(liveServices(run))

    // The whole pipeline runs in the ACT (one step = one scored unit); boot
    // only assembles the world.
    const act = Effect.gen(function* () {
      const session = yield* makeRefineSession(dir, publish, { unattended: true }).pipe(
        Effect.provide(services),
      )
      yield* session.send(run.task).pipe(Effect.provide(services))
      const locked = yield* session.lock.pipe(Effect.provide(services))
      yield* runForgeSession(run, publish, Option.some(locked.doc)).pipe(
        Effect.provide(services),
      )
    })
    const trail = ConversationStore.pipe(
      Effect.flatMap((store) =>
        Effect.gen(function* () {
          const sessions = yield* store.listByWorkspace(dir)
          const newest = Option.fromNullable(sessions[0])
          if (Option.isNone(newest)) return "no conversation persisted"
          const messages = yield* store.list(newest.value.id)
          return renderTrailForDigest(messages)
        }),
      ),
      Effect.provide(services),
      Effect.orElseSucceed(() => "trail unavailable"),
    )
    return {
      dir,
      events: () => Effect.runSync(Ref.get(eventsRef)),
      trail,
      act,
    } satisfies SmithLiveWorld
  }),
  steps: [
    {
      name: "refine → lock → forge, end to end on real providers",
      act: (world) => world.act,
      checks: [
        eventOrder(["spec_draft", "spec_locked", "forge_start", "attempt_start", "forge_end"]),
        eventWhere<SmithEvent>("run ACCEPTED with the artifact on disk", (events) =>
          events.some(
            (event) =>
              event.type === "forge_end" &&
              event.run.outcome._tag === "accepted" &&
              existsSync(event.artifact),
          ),
        ),
        eventWhere<SmithEvent>(
          "the judge gate ran (production gates, not the scripted twin)",
          (events) =>
            events.some((event) => event.type === "gate_start" && event.gate === "judge"),
        ),
        eventCount("attempt_start", { max: 3 }),
        // Deliberately NO memory_updated expectation: a trivial selftest task
        // teaches nothing durable, and the extraction prompt's own discipline
        // says an empty answer is correct then. The memory battery owns
        // curation quality.
      ],
    },
  ],
  judges: [
    makeTrajectoryCritic<SmithLiveWorld>({
      transcript: (world) => world.trail,
      outcome: (world) => {
        const end = world
          .events()
          .flatMap((event) => (event.type === "forge_end" ? [event] : []))
        const last = end[end.length - 1]
        return Effect.succeed(
          last === undefined
            ? "unknown (no forge_end)"
            : `${last.run.outcome._tag} after ${last.run.attempts.length} attempt(s)`,
        )
      },
      // GENERAL tier, deliberately NOT the code tier: the implementor runs
      // on codeModel — a critic on the same model grades its own homework
      // (audit). Different model, independent opinion.
      call: generalTierCall(process.cwd()),
    }),
  ],
})

export const smithSpecPack: Pack = {
  name: "smith-spec",
  threshold: 0.95,
  // The live scenario is ONE full forge run (k=1, priciest battery) with a
  // 0.3-weighted critic — a single 4/5 rubric axis moves the mean ~0.024,
  // so the default 0.05 was one opinion away from a false regression.
  tolerance: 0.1,
  meta: {
    "coder-prompt": SMITH_CODER_PROMPT_VERSION,
    "critic-rubric": CRITIC_RUBRIC_VERSION,
  },
  scenarios: [
    liveScenario,
    scenario<SmithWorld>({
      name: "refine → lock → forge (scripted twin)",
      modes: ["scripted"],
      boot: bootSmithWorld,
      steps: [
        {
          name: "refine one turn proposes the draft",
          act: (w) => w.refine.send("build the out.txt writer"),
          checks: [
            fileExists(SPEC_REL),
            fileContains(SPEC_REL, "status: draft"),
            fileContains(SPEC_REL, "out-exists: test -f out.txt"),
            eventOrder(["spec_draft"]),
          ],
        },
        {
          name: "the human lock flips the file to locked",
          act: (w) => w.refine.lock,
          checks: [
            fileContains(SPEC_REL, "status: locked"),
            eventOrder(["spec_draft", "spec_locked"]),
          ],
        },
        {
          name: "forge runs the spec's checks as accept gates (fail → fix → accepted)",
          act: (w) =>
            Effect.gen(function* () {
              const draft = yield* w.refine.currentDraft
              const doc = Option.getOrThrow(draft).doc
              const implementor = makeScriptedImplementor([
                [], // attempts 1 AND 2 write nothing — the accept gates fail
                [], // twice: recurrence is what turns a rejection into a LESSON
                [{ path: "out.txt", content: "done\n" }],
              ])
              yield* runForgeSessionWith(w.run, w.publish, implementor, Option.some(doc)).pipe(
                Effect.provide(LocalFileSystemLive),
                Effect.provide(LocalShellLive),
              )
            }),
          checks: [
            eventOrder([
              "spec_locked",
              "forge_start",
              "attempt_start",
              "gate_report",
              "forge_end",
            ]),
            eventWhere<SmithEvent>("spec checks became accept gates", (events) => {
              const start = events.find((e) => e.type === "forge_start")
              return (
                start !== undefined &&
                start.type === "forge_start" &&
                start.gateNames.includes("accept-out-exists") &&
                start.gateNames.includes("accept-out-content")
              )
            }),
            eventWhere<SmithEvent>("rejected then accepted (the feedback loop ran)", (events) => {
              const end = events.find((e) => e.type === "forge_end")
              return (
                end !== undefined &&
                end.type === "forge_end" &&
                end.run.outcome._tag === "accepted" &&
                end.run.attempts.length === 3 &&
                end.run.attempts[0]?.report.ok === false &&
                end.run.attempts[1]?.report.ok === false
              )
            }),
            fileExists("out.txt"),
            fileContains("out.txt", "done"),
          ],
        },
        {
          name: "the forge history becomes deterministic memory for the NEXT run",
          act: () => Effect.void,
          checks: [
            {
              name: "lessons derived from the rejected attempt",
              severity: "hard",
              run: (w) =>
                loadForgeLessons(w.dir).pipe(
                  Effect.map((lessons) =>
                    Option.match(lessons, {
                      onNone: () => ({
                        pass: false,
                        detail: "no lessons derived from a history with a rejected attempt",
                      }),
                      onSome: (text) => ({
                        pass:
                          text.includes("accept-out-exists") &&
                          text.includes("Lessons from past forge runs"),
                        detail: `lessons text: ${text.slice(0, 160)}`,
                      }),
                    }),
                  ),
                ),
            },
          ],
        },
      ],
    }),
  ],
}
