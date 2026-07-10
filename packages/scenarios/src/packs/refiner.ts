import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { snapshotWorkspace } from "@xandreed/foundry"
import { ConversationStore } from "@xandreed/engine"
import type { AgentMessage, SpecDoc } from "@xandreed/engine"
import {
  makeCommandGate,
  makeRefineSession,
  SPEC_REFINER_PROMPT_VERSION,
  vacuousAccepts,
} from "@xandreed/smith"
import type { RefineSession } from "@xandreed/smith"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  SqliteConversationStoreLive,
} from "@xandreed/providers"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { listCases, seedWorkspace } from "../live/fixtures.js"
import { codeTierCall } from "../live/llm.js"
import { makeSpecQualityJudge, SPEC_QUALITY_RUBRIC_VERSION } from "../judges/specQuality.js"

/**
 * The REFINER battery — a real unattended refine session (general tier) over
 * idea+workspace fixtures. The deterministic checks carry the weight —
 * red-first is mechanically verifiable (`vacuousAccepts` over the final
 * draft's checks; propose-time enforcement makes BOUNCES a countable
 * signal) — and the spec-quality judge grades what mechanics can't.
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures", "refiner-golden")

const ExpectFile = Schema.parseJson(
  Schema.Struct({
    /** Needles the draft should name (the refiner explored before proposing). */
    mentions: Schema.Array(Schema.NonEmptyString),
    /** An oversized idea must be staged with explicit non-goals. */
    wantsNonGoals: Schema.Boolean,
    /** The vague-idea protocol: unattended assumptions carry the prefix. */
    wantsAssumptions: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  }),
)
export type RefinerExpect = typeof ExpectFile.Type

export const readRefinerCase = (
  dir: string,
  name: string,
): Effect.Effect<{ readonly idea: string; readonly expect: RefinerExpect }, unknown> =>
  Effect.gen(function* () {
    const idea = yield* Effect.try(() =>
      readFileSync(join(dir, name, "idea.txt"), "utf-8").trim(),
    )
    const expect = yield* Schema.decodeUnknown(ExpectFile)(
      readFileSync(join(dir, name, "expect.json"), "utf-8"),
    )
    return { idea, expect }
  })

/* ------------------------------------------------------------------ */
/* The deterministic check logic — exported PURE so the key-free tests  */
/* prove it without a session.                                          */
/* ------------------------------------------------------------------ */

export const multilineChecks = (doc: SpecDoc): ReadonlyArray<string> =>
  doc.checks.filter((check) => /[\r\n]/.test(check.command)).map((check) => check.name)

/** The final draft's checks re-probed against the untouched workspace —
 *  red-first must hold on the ACCEPTED draft, not just at propose time. */
export const vacuousDraftChecks = (
  doc: SpecDoc,
  dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
  vacuousAccepts(
    doc.checks.map((check) =>
      makeCommandGate({
        name: check.name,
        argv: ["bash", "-c", check.command],
        timeoutMs: 30_000,
      }),
    ),
    snapshotWorkspace(dir),
  )

/** propose_spec rejections in the trail — the enforced red-first probe turns
 *  refiner mistakes into countable bounces. Structural over the trail shape
 *  (only role/toolName/isError are read), so tests need no branded ids. */
export const bounceCount = (
  messages: ReadonlyArray<{
    readonly role: string
    readonly content:
      | string
      | ReadonlyArray<{
          readonly type: string
          readonly toolName?: string | undefined
          readonly isError?: boolean | undefined
        }>
  }>,
): number =>
  messages
    .flatMap((message) =>
      message.role === "tool" && typeof message.content !== "string" ? message.content : [],
    )
    .filter((part) => part.toolName === "propose_spec" && part.isError === true).length

export const mentionsNeedles = (
  doc: SpecDoc,
  needles: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const text = [
    doc.goal,
    ...doc.acceptance,
    ...doc.constraints,
    ...doc.nonGoals,
    ...doc.checks.map((check) => `${check.name} ${check.command}`),
  ]
    .join("\n")
    .toLowerCase()
  return needles.filter((needle) => !text.includes(needle.toLowerCase()))
}

export const hasAssumptionBullet = (doc: SpecDoc): boolean =>
  doc.constraints.some((constraint) => constraint.toLowerCase().startsWith("assumption:"))

/* ------------------------------------------------------------------ */

interface RefinerWorld {
  readonly dir: string
  readonly expect: RefinerExpect
  readonly session: RefineSession
  readonly draft: Ref.Ref<Option.Option<SpecDoc>>
  readonly trail: Effect.Effect<ReadonlyArray<AgentMessage>>
}

const draftOr = <A>(
  world: RefinerWorld,
  onDoc: (doc: SpecDoc) => A | Effect.Effect<A>,
  onNone: A,
): Effect.Effect<A> =>
  Ref.get(world.draft).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(onNone),
        onSome: (doc) => {
          const out = onDoc(doc)
          return Effect.isEffect(out) ? out : Effect.succeed(out)
        },
      }),
    ),
  )

const refinerScenario = (name: string) =>
  scenario<RefinerWorld>({
    name,
    modes: ["live"],
    boot: Effect.gen(function* () {
      const fixture = yield* readRefinerCase(FIXTURES, name).pipe(Effect.orDie)
      const dir = yield* seedWorkspace(join(FIXTURES, name, "workspace"))
      const draft = yield* Ref.make(Option.none<SpecDoc>())
      // The production refine stack over the seeded workspace; the MODEL
      // resolves from the runner's cwd (the repo carries the config).
      const services = yield* Layer.build(
        Layer.mergeAll(
          LocalFileSystemLive,
          LocalShellLive,
          SqliteConversationStoreLive(join(dir, ".efferent", "smith.db")),
          LanguageModelLive,
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              LocalAuthStoreLive(process.cwd(), homedir()),
              LocalSettingsStoreLive(process.cwd(), homedir()),
            ),
          ),
        ),
      )
      const session = yield* makeRefineSession(dir, () => Effect.void, {
        unattended: true,
      }).pipe(Effect.provide(services))
      const trail = ConversationStore.pipe(
        Effect.flatMap((store) => store.list(session.conversationId)),
        Effect.provide(services),
        Effect.orElseSucceed(() => [] as ReadonlyArray<AgentMessage>),
      )
      return { dir, expect: fixture.expect, session, draft, trail }
    }),
    steps: [
      {
        name: "one unattended refine turn proposes the draft",
        act: (world) =>
          Effect.gen(function* () {
            const fixture = yield* readRefinerCase(FIXTURES, name).pipe(Effect.orDie)
            const draft = yield* world.session.send(fixture.idea)
            yield* Ref.set(world.draft, Option.map(draft, (ref) => ref.doc))
          }),
        checks: [
          {
            name: "a draft exists and decodes",
            severity: "hard",
            run: (world) =>
              Ref.get(world.draft).pipe(
                Effect.map((draft) => ({ pass: Option.isSome(draft) })),
              ),
          },
          {
            name: "the draft carries at least one machine check",
            severity: "hard",
            run: (world) => draftOr(world, (doc) => ({ pass: doc.checks.length >= 1 }), { pass: false }),
          },
          {
            name: "every check command is one line",
            severity: "hard",
            run: (world) =>
              draftOr(
                world,
                (doc) => {
                  const bad = multilineChecks(doc)
                  return { pass: bad.length === 0, ...(bad.length > 0 ? { detail: bad.join(", ") } : {}) }
                },
                { pass: false },
              ),
          },
          {
            name: "red-first holds on the FINAL draft",
            severity: "hard",
            run: (world) =>
              draftOr(
                world,
                (doc) =>
                  vacuousDraftChecks(doc, world.dir).pipe(
                    Effect.map((vacuous) => ({
                      pass: vacuous.length === 0,
                      ...(vacuous.length > 0
                        ? { detail: `already green: ${vacuous.join(", ")}` }
                        : {}),
                    })),
                  ),
                { pass: false },
              ),
          },
          {
            name: "at most 2 red-first bounces on the way",
            severity: "soft",
            run: (world) =>
              world.trail.pipe(
                Effect.map((messages) => {
                  const bounces = bounceCount(messages)
                  return { pass: bounces <= 2, detail: `${bounces} bounce(s)` }
                }),
              ),
          },
          {
            name: "the draft names the workspace facts it explored",
            severity: "soft",
            run: (world) =>
              draftOr(
                world,
                (doc) => {
                  const missing = mentionsNeedles(doc, world.expect.mentions)
                  return {
                    pass: missing.length === 0,
                    ...(missing.length > 0 ? { detail: `missing: ${missing.join(", ")}` } : {}),
                  }
                },
                { pass: false },
              ),
          },
          {
            name: "oversized ideas are staged with non-goals",
            severity: "soft",
            run: (world) =>
              draftOr(
                world,
                (doc) => ({ pass: !world.expect.wantsNonGoals || doc.nonGoals.length > 0 }),
                { pass: false },
              ),
          },
          {
            name: "vague ideas surface assumption: constraints",
            severity: "soft",
            run: (world) =>
              draftOr(
                world,
                (doc) => ({ pass: !world.expect.wantsAssumptions || hasAssumptionBullet(doc) }),
                { pass: false },
              ),
          },
        ],
      },
    ],
    judges: [
      makeSpecQualityJudge<RefinerWorld>({
        doc: (world) =>
          Ref.get(world.draft).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail("no draft to grade"),
                onSome: Effect.succeed,
              }),
            ),
          ),
        call: codeTierCall(process.cwd()),
      }),
    ],
  })

export const refinerPack: Pack = {
  name: "refiner",
  threshold: 0.75,
  samples: 2,
  judgeWeight: 0.4,
  tolerance: 0.1,
  // One golden case regressing must not hide behind another's headroom;
  // per-case is looser than the mean gate (k=2 + a judge = noisier cases).
  perScenarioRatchet: true,
  perScenarioTolerance: 0.2,
  meta: {
    "refiner-prompt": SPEC_REFINER_PROMPT_VERSION,
    "spec-quality-rubric": SPEC_QUALITY_RUBRIC_VERSION,
  },
  scenarios: listCases(FIXTURES).map(refinerScenario),
}
