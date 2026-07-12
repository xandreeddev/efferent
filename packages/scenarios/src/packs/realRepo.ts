import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { ConversationStore, SpecDoc } from "@xandreed/engine"
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
  renderTrailForDigest,
  runForgeSession,
  SMITH_CODER_PROMPT_VERSION,
  SMITH_LIMIT_DEFAULTS,
  SmithSettingsStoreLive,
} from "@xandreed/smith"
import type { SmithEvent, SmithRunConfig } from "@xandreed/smith"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { CRITIC_RUBRIC_VERSION, makeTrajectoryCritic } from "../judges/trajectoryCritic.js"
import { generalTierCall } from "../live/llm.js"
import { cloneRepoWorkspace } from "../live/cloneWorld.js"

/**
 * The REAL-REPO benchmark: forge ONE bounded spec against a clone of
 * efferent itself, with THE REPO'S OWN quality profile as the oracle — the
 * full repo gate suite (idioms over every checked package, boundaries, the
 * whole test suite) judges the coder's work exactly as CI would judge a
 * human's. HEAVY (a monorepo test run per attempt): never in the default
 * battery expansion; run it by name, k=1.
 */

const EFFERENT_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

const GOAL =
  "Create packages/scenarios/src/framework/median.ts exporting median(values: ReadonlyArray<number>): Option.Option<number> — Option.none for the empty array, the middle value (mean of the two middles for even lengths) otherwise — in this repo's house style (see the armed quality bar and neighbouring framework modules), with a colocated median.test.ts covering empty, odd, and even cases with bun:test."

const liveDoc = Schema.decodeUnknownSync(SpecDoc)({
  slug: "real-repo-median",
  status: "locked",
  created: "2026-07-11T00:00:00.000Z",
  locked: "2026-07-11T00:00:00.000Z",
  goal: GOAL,
  acceptance: [
    "median returns Option.none for [], the middle for odd lengths, the mean of the middles for even lengths",
    "median.test.ts covers all three cases and the repo's gates stay green",
  ],
  constraints: [
    "write to the ARMED quality bar — no let, no loops, no try/catch, absence is Option",
    "touch nothing outside packages/scenarios/src/framework/",
  ],
  nonGoals: ["refactoring existing framework modules"],
  checks: [
    {
      name: "median-tests",
      command: "bun test packages/scenarios/src/framework/median.test.ts",
    },
  ],
  limits: { maxAttempts: 3, budgetMinutes: 20 },
  gates: {},
})

const runFor = (cwd: string): SmithRunConfig => ({
  task: GOAL,
  cwd,
  acceptance: [],
  maxAttempts: 3,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  models: { general: Option.none(), code: Option.none(), fast: Option.none() },
  headless: true,
  testCommand: Option.none(),
  noTest: false,
  // The repo's own suite IS the oracle (root config is not the conventional
  // filename here).
  configPath: Option.some("foundry.repo.config.ts"),
  ship: false,
  sandbox: false,
})

interface RealRepoWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<SmithEvent>
  readonly trail: Effect.Effect<string>
  readonly act: Effect.Effect<void, unknown>
}

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

const liveScenario = scenario<RealRepoWorld>({
  name: "forge one spec against efferent itself — the repo's own profile judges (live, HEAVY)",
  modes: ["live"],
  boot: Effect.gen(function* () {
    const dir = yield* cloneRepoWorkspace(EFFERENT_ROOT)
    const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
    const publish = (event: SmithEvent) => Ref.update(eventsRef, (all) => [...all, event])
    const run: SmithRunConfig = {
      ...runFor(dir),
      configPath: Option.some(join(dir, "foundry.repo.config.ts")),
    }
    const services = liveServices(run)
    const act = runForgeSession(run, publish, Option.some(liveDoc)).pipe(
      Effect.provide(services),
      Effect.asVoid,
    )
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
    } satisfies RealRepoWorld
  }),
  steps: [
    {
      name: "the production forge under the repo's full gate suite",
      act: (world) => world.act,
      checks: [
        {
          name: "the repo profile is ARMED (8 rules)",
          severity: "hard",
          run: (world) =>
            Effect.succeed({
              pass: world
                .events()
                .some(
                  (event) =>
                    event.type === "profile_status" && event.armed && event.rules === 8,
                ),
            }),
        },
        {
          name: "run ACCEPTED under the full repo gates",
          severity: "hard",
          run: (world) =>
            Effect.succeed({
              pass: world
                .events()
                .some(
                  (event) =>
                    event.type === "forge_end" && event.run.outcome._tag === "accepted",
                ),
            }),
        },
        {
          name: "FIRST-ATTEMPT-CLEAN: no effect/* or boundaries/* finding on attempt 1",
          severity: "soft",
          run: (world) => {
            const count = world
              .events()
              .filter((event) => event.type === "gate_report" && event.attempt === 1)
              .flatMap((event) =>
                event.type === "gate_report"
                  ? event.report.verdicts.flatMap((verdict) =>
                      verdict._tag === "skip" ? [] : verdict.findings,
                    )
                  : [],
              )
              .filter(
                (finding) =>
                  String(finding.rule).startsWith("effect/") ||
                  String(finding.rule).startsWith("boundaries/"),
              ).length
            return Effect.succeed({
              pass: count === 0,
              ...(count > 0 ? { detail: `${count} house-style finding(s) on attempt 1` } : {}),
            })
          },
        },
        {
          name: "at most 2 attempts",
          severity: "soft",
          run: (world) =>
            Effect.succeed({
              pass:
                world.events().filter((event) => event.type === "attempt_start").length <= 2,
            }),
        },
      ],
    },
  ],
  judges: [
    makeTrajectoryCritic<RealRepoWorld>({
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
      call: generalTierCall(process.cwd()),
    }),
  ],
})

export const realRepoPack: Pack = {
  name: "real-repo",
  threshold: 0.75,
  tolerance: 0.15,
  meta: {
    "coder-prompt": SMITH_CODER_PROMPT_VERSION,
    "critic-rubric": CRITIC_RUBRIC_VERSION,
    "repo-oracle": "foundry.repo.config.ts",
  },
  scenarios: [liveScenario],
}
