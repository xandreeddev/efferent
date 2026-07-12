import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { ConversationId, ConversationStore, Shell, SpecDoc } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalShellLive,
  McpClientLive,
  SqliteConversationStoreLive,
  UtilityLlmLive,
} from "@xandreed/providers"
import { makeScriptedImplementor, vendoredPackFiles } from "@xandreed/foundry"
import {
  makeProfileSession,
  PROFILE_DRAFT_DIR,
  PROFILE_SESSION_PROMPT_VERSION,
  renderTrailForDigest,
  runForgeSession,
  runForgeSessionWith,
  SMITH_CODER_PROMPT_VERSION,
  SMITH_LIMIT_DEFAULTS,
  SmithSettingsStoreLive,
} from "@xandreed/smith"
import type { ProfileAgent, ProfileSession, SmithEvent, SmithRunConfig } from "@xandreed/smith"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { eventWhere, fileContains, fileExists } from "../framework/evidence.js"
import { CRITIC_RUBRIC_VERSION, makeTrajectoryCritic } from "../judges/trajectoryCritic.js"
import { generalTierCall } from "../live/llm.js"
import { seedWorkspace } from "../live/fixtures.js"

/**
 * The PROFILE pack — the quality contract measured end to end.
 *
 * SCRIPTED TWIN (CI, key-free): a scripted profile session arms a custom
 * rule → :lock (config + baseline mint) → a scripted forge where attempt 1
 * violates the armed rule (rejected — the feedback carries the rule the
 * SESSION created: session → plug-in → registry → gate → renderFeedback,
 * proven end to end) and attempt 2 lands clean; the pre-existing violation
 * stays grandfathered throughout.
 *
 * LIVE (keyed): the real coder forges one spec inside a workspace whose
 * effect-pack profile is ARMED — scoring first-attempt-clean (did it WRITE
 * to the bar, or brute-force the gate loop?), acceptance, and the critic.
 */

const REPO_NODE_MODULES = resolve(import.meta.dir, "..", "..", "..", "..", "node_modules")

const NO_FIXME_SOURCE = [
  "export const rules = [",
  "  {",
  '    id: "local/no-fixme",',
  '    defaultSeverity: "error",',
  '    description: "FIXME markers are banned",',
  '    fixHint: "fix it or file it — never park it in the source",',
  "    check: (ctx) =>",
  '      ctx.sourceFile.text.includes("FIX" + "ME")',
  '        ? [{ node: ctx.sourceFile, message: "FIXME marker" }]',
  "        : [],",
  "  },",
  "]",
  "",
].join("\n")

const scriptedProfileAgent: ProfileAgent = (_cid, _prompt, tools) =>
  tools
    .propose({
      customRules: [{ filename: "no-fixme.ts", source: NO_FIXME_SOURCE }],
      rules: [{ rule: "local/no-fixme", include: ["src/**"] }],
      doctrine: "No FIXME markers — fix it or file it.",
    })
    .pipe(Effect.asVoid, Effect.orDie)

interface ProfileWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<SmithEvent>
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
  readonly run: SmithRunConfig
  readonly session: ProfileSession
}

const runFor = (cwd: string, task: string): SmithRunConfig => ({
  task,
  cwd,
  acceptance: [],
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

const stubRunServices = Layer.mergeAll(
  Layer.succeed(LanguageModel.LanguageModel, {} as never),
  Layer.succeed(Shell, {} as never),
  Layer.succeed(ConversationStore, {
    create: () =>
      Effect.succeed(ConversationId.make("00000000-0000-4000-8000-0000005e5510")),
  } as never),
)

const bootProfileWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-profile-"))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  yield* Effect.sync(() => {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          module: "esnext",
          target: "esnext",
          moduleResolution: "bundler",
        },
        include: ["src/**/*.ts"],
      }),
    )
    mkdirSync(join(dir, "src"))
    // The PRE-EXISTING violation — grandfathered at lock, silent forever.
    writeFileSync(join(dir, "src", "legacy.ts"), "// FIXME: legacy debt\nexport const legacy = 1\n")
    symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"), "dir")
  })
  const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
  const publish = (event: SmithEvent) => Ref.update(eventsRef, (all) => [...all, event])
  const session = yield* makeProfileSession(dir, publish, {
    unattended: true,
    agent: scriptedProfileAgent,
  }).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(stubRunServices))
  return {
    dir,
    events: () => Effect.runSync(Ref.get(eventsRef)),
    publish,
    run: runFor(dir, "Add src/feature.ts exporting the feature flag."),
    session,
  } satisfies ProfileWorld
})

const scriptedTwin = scenario<ProfileWorld>({
  name: "profile session → armed custom rule → forge bounce → clean accept (scripted twin)",
  modes: ["scripted"],
  boot: bootProfileWorld,
  steps: [
    {
      name: "the session proposes; the dry-run counts the pre-existing violation",
      act: (world) => world.session.send("set up the quality profile"),
      checks: [
        fileExists(`${PROFILE_DRAFT_DIR}/draft.json`),
        fileContains(`${PROFILE_DRAFT_DIR}/draft.json`, "local/no-fixme"),
        fileExists(`${PROFILE_DRAFT_DIR}/gates/no-fixme.ts`),
      ],
    },
    {
      name: "the human locks — config, project-owned rules, grandfathering baseline",
      act: (world) => world.session.lock,
      checks: [
        fileExists("foundry.config.ts"),
        fileExists(".efferent/gates/index.ts"),
        fileExists(".efferent/gates/no-fixme.ts"),
        fileContains(".efferent/rules.md", "No FIXME markers"),
        fileContains(".foundry/baseline.json", '"fingerprints":["'),
      ],
    },
    {
      name: "the forge enforces the SESSION's rule: violation bounces, fix lands, legacy stays silent",
      act: (world) =>
        runForgeSessionWith(
          world.run,
          world.publish,
          makeScriptedImplementor([
            [
              {
                path: "src/feature.ts",
                content: "// FIXME: wire the flag\nexport const feature = true\n",
              },
            ],
            [{ path: "src/feature.ts", content: "export const feature = true\n" }],
          ]),
        ).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(LocalShellLive)),
      checks: [
        eventWhere<SmithEvent>("profile_status is ARMED with the minted baseline", (events) =>
          events.some(
            (event) =>
              event.type === "profile_status" &&
              event.armed &&
              event.rules === 1 &&
              event.baseline >= 1,
          ),
        ),
        eventWhere<SmithEvent>(
          "attempt 1 bounced on the armed rule AT THE NEW FILE",
          (events) =>
            events.some(
              (event) =>
                event.type === "gate_report" &&
                event.attempt === 1 &&
                event.report.verdicts.some(
                  (verdict) =>
                    verdict._tag === "fail" &&
                    verdict.findings.some(
                      (finding) =>
                        String(finding.rule) === "local/no-fixme" &&
                        Option.match(finding.location, {
                          onNone: () => false,
                          onSome: (location) => String(location.file) === "src/feature.ts",
                        }),
                    ),
                ),
            ),
        ),
        eventWhere<SmithEvent>(
          "the GRANDFATHERED violation never surfaced",
          (events) =>
            !events.some(
              (event) =>
                event.type === "gate_report" &&
                event.report.verdicts.some(
                  (verdict) =>
                    verdict._tag !== "skip" &&
                    verdict.findings.some((finding) =>
                      Option.match(finding.location, {
                        onNone: () => false,
                        onSome: (location) => String(location.file) === "src/legacy.ts",
                      }),
                    ),
                ),
            ),
        ),
        eventWhere<SmithEvent>("accepted on attempt 2", (events) =>
          events.some(
            (event) =>
              event.type === "forge_end" &&
              event.run.outcome._tag === "accepted" &&
              event.run.outcome.attempt === 2,
          ),
        ),
      ],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* The LIVE house-style scenario: the real coder forges ONE spec inside */
/* a workspace whose effect-pack profile is ARMED — did it WRITE to the */
/* bar, or brute-force the gate loop?                                   */
/* ------------------------------------------------------------------ */

const FIXTURE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "smith",
  "fixtures",
  "house-style-golden",
  "workspace",
)

const LIVE_GOAL =
  "Create src/clamp.ts exporting clamp(value: number, min: number, max: number): number in this workspace's house style (see src/greeting.ts and the armed quality bar), and src/clamp.test.ts covering the bounds and the passthrough case with bun:test."

const liveDoc = Schema.decodeUnknownSync(SpecDoc)({
  slug: "house-style-clamp",
  status: "locked",
  created: "2026-07-11T00:00:00.000Z",
  locked: "2026-07-11T00:00:00.000Z",
  goal: LIVE_GOAL,
  acceptance: [
    "clamp returns min below the range, max above it, and the value inside it",
    "src/clamp.test.ts covers all three cases and bun test exits 0",
  ],
  constraints: [
    "write to the ARMED quality bar — errors are values, state is a fold, absence is Option",
  ],
  nonGoals: ["touching src/greeting.ts"],
  checks: [{ name: "clamp-tests", command: "bun test src/clamp.test.ts" }],
  limits: { maxAttempts: 3, budgetMinutes: 15 },
  gates: {},
})

interface ProfileLiveWorld {
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

const firstAttemptEffectFindings = (events: ReadonlyArray<SmithEvent>): number =>
  events
    .filter((event) => event.type === "gate_report" && event.attempt === 1)
    .flatMap((event) =>
      event.type === "gate_report"
        ? event.report.verdicts.flatMap((verdict) =>
            verdict._tag === "skip" ? [] : verdict.findings,
          )
        : [],
    )
    .filter((finding) => String(finding.rule).startsWith("effect/")).length

const liveScenario = scenario<ProfileLiveWorld>({
  name: "house-style forge on an ARMED workspace (live)",
  modes: ["live"],
  boot: Effect.gen(function* () {
    const dir = yield* seedWorkspace(FIXTURE)
    yield* Effect.sync(() => {
      symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"), "dir")
      // The fixture's config plugs ".efferent/gates/index.js" — vendor the
      // effect pack exactly as the profile session's lock would.
      mkdirSync(join(dir, ".efferent", "gates"), { recursive: true })
    })
    const files = yield* vendoredPackFiles("effect")
    yield* Effect.sync(() => {
      files.forEach((file) => {
        const target = join(dir, ".efferent", "gates", file.path)
        mkdirSync(join(dir, ".efferent", "gates", "effect"), { recursive: true })
        writeFileSync(target, file.content)
      })
      writeFileSync(
        join(dir, ".efferent", "gates", "index.ts"),
        'export { rules } from "./effect/rules.js"\n',
      )
    })
    const eventsRef = yield* Ref.make<ReadonlyArray<SmithEvent>>([])
    const publish = (event: SmithEvent) => Ref.update(eventsRef, (all) => [...all, event])
    const run: SmithRunConfig = { ...runFor(dir, LIVE_GOAL), noTest: false }
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
    } satisfies ProfileLiveWorld
  }),
  steps: [
    {
      name: "the production forge over the armed profile",
      act: (world) => world.act,
      checks: [
        {
          name: "profile_status: 6 rules armed",
          severity: "hard",
          run: (world) =>
            Effect.succeed({
              pass: world
                .events()
                .some(
                  (event) =>
                    event.type === "profile_status" && event.armed && event.rules === 6,
                ),
            }),
        },
        {
          name: "run ACCEPTED",
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
          name: "FIRST-ATTEMPT-CLEAN: no effect/* finding on attempt 1 (wrote to the bar)",
          severity: "soft",
          run: (world) => {
            const count = firstAttemptEffectFindings(world.events())
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
    makeTrajectoryCritic<ProfileLiveWorld>({
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

export const profilePack: Pack = {
  name: "profile",
  threshold: 0.8,
  tolerance: 0.1,
  meta: {
    "coder-prompt": SMITH_CODER_PROMPT_VERSION,
    "profile-session-prompt": PROFILE_SESSION_PROMPT_VERSION,
    "critic-rubric": CRITIC_RUBRIC_VERSION,
    "profile-fixture": "house-style-golden@v1",
  },
  scenarios: [scriptedTwin, liveScenario],
}
