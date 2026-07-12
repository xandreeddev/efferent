import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { UtilityLlm } from "@xandreed/engine"
import {
  CandidateFact,
  consolidatePrompt,
  ConsolidateOutput,
  extractPrompt,
  ExtractOutput,
  MEMORY_PROMPTS_VERSION,
  MemoryId,
  MemoryRecord,
  stripFences,
} from "@xandreed/smith"
import type { Judge, Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { listCases } from "../live/fixtures.js"
import { generalTierCall, utilityTier } from "../live/llm.js"

/**
 * The MEMORY battery — the goldenEval absorbed: extraction cases score
 * precision/recall via an independent LLM-equivalence judge and one-to-one
 * matching; consolidate cases pin the create/corroborate/update verbs.
 */

const EXTRACT_FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures", "memory-golden")
const CONSOLIDATE_FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures", "consolidate-golden")

const ExpectedFile = Schema.parseJson(
  Schema.Struct({
    expected: Schema.Array(CandidateFact),
    distractors: Schema.Array(Schema.String),
  }),
)
export type MemoryExpected = typeof ExpectedFile.Type

export const readExtractCase = (
  dir: string,
  name: string,
): Effect.Effect<{ readonly transcript: string; readonly expected: MemoryExpected }, unknown> =>
  Effect.gen(function* () {
    const transcript = yield* Effect.try(() =>
      readFileSync(join(dir, name, "transcript.txt"), "utf-8"),
    )
    const expected = yield* Schema.decodeUnknown(ExpectedFile)(
      readFileSync(join(dir, name, "expected.json"), "utf-8"),
    )
    return { transcript, expected }
  })

type Candidates = ReadonlyArray<typeof CandidateFact.Type>

interface ExtractWorld {
  readonly transcript: string
  readonly expected: MemoryExpected
  readonly extracted: Ref.Ref<Option.Option<Candidates>>
  readonly generate: (prompt: string) => Effect.Effect<string, unknown>
  readonly judge: (prompt: string) => Effect.Effect<string, unknown>
}

/** Maximum one-to-one matches in a boolean equivalence matrix. Exhaustive
 *  recursion is appropriate here: golden memory sets are deliberately tiny. */
export const maximumOneToOneMatches = (
  matrix: ReadonlyArray<ReadonlyArray<boolean>>,
): number => {
  const visit = (row: number, used: ReadonlySet<number>): number =>
    row >= matrix.length
      ? 0
      : Math.max(
          visit(row + 1, used),
          ...(matrix[row] ?? []).flatMap((matches, column) =>
            matches && !used.has(column)
              ? [1 + visit(row + 1, new Set([...used, column]))]
              : [],
          ),
        )
  return visit(0, new Set())
}

/** Precision/recall via independent equivalence probes and a one-to-one
 *  alignment. The harmonic mean stays sensitive above historical cutoffs. */
export const extractionFidelityJudge: Judge<ExtractWorld> = {
  name: "extraction-fidelity",
  run: (world) =>
    Effect.gen(function* () {
      const extracted = Option.getOrElse(yield* Ref.get(world.extracted), (): Candidates => [])
      const golden = world.expected.expected
      const equivalent = (a: string, b: string) =>
        world
          .judge(
            `Do these two statements express the SAME workspace fact? Reply with exactly "yes" or "no".\nA: ${a}\nB: ${b}`,
          )
          .pipe(Effect.map((reply) => reply.trim().toLowerCase().startsWith("yes")))
      const matrix = yield* Effect.forEach(extracted, (fact) =>
        Effect.forEach(golden, (expected) =>
          equivalent(fact.statement, expected.statement),
        ),
      )
      const matches = maximumOneToOneMatches(matrix)
      const precision =
        extracted.length === 0 ? (golden.length === 0 ? 1 : 0) : matches / extracted.length
      const recall =
        golden.length === 0
          ? extracted.length === 0
            ? 1
            : 0
          : matches / golden.length
      const score =
        precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
      return {
        score,
        reason: `precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)} · matched ${matches} · extracted ${extracted.length}/${golden.length}`,
      }
    }),
}

const extractScenario = (name: string) =>
  scenario<ExtractWorld>({
    name: `extract:${name}`,
    modes: ["live"],
    boot: Effect.gen(function* () {
      const fixture = yield* readExtractCase(EXTRACT_FIXTURES, name).pipe(Effect.orDie)
      const extracted = yield* Ref.make(Option.none<Candidates>())
      const utility = yield* Layer.build(utilityTier(process.cwd()))
      const generate = (prompt: string) =>
        UtilityLlm.pipe(
          Effect.flatMap((service) => service.complete(prompt)),
          Effect.map((response) => response.text),
          Effect.provide(utility),
        )
      const judge = generalTierCall(process.cwd())
      return { transcript: fixture.transcript, expected: fixture.expected, extracted, generate, judge }
    }),
    steps: [
      {
        name: "extract candidates",
        act: (world) =>
          Effect.gen(function* () {
            const reply = yield* world.generate(extractPrompt(world.transcript))
            const decoded = yield* Schema.decodeUnknown(ExtractOutput)(stripFences(reply)).pipe(
              Effect.option,
            )
            yield* Ref.set(world.extracted, decoded)
          }),
        checks: [
          {
            name: "output decodes to a candidate array",
            severity: "hard",
            run: (world) =>
              Ref.get(world.extracted).pipe(
                Effect.map((extracted) => ({
                  pass: Option.isSome(extracted),
                  ...(Option.isNone(extracted)
                    ? { detail: "undecodable extraction output" }
                    : {}),
                })),
              ),
          },
          {
            name: "no distractor leaked",
            severity: "soft",
            run: (world) =>
              Ref.get(world.extracted).pipe(
                Effect.map((extracted) => {
                  const facts = Option.getOrElse(extracted, (): Candidates => [])
                  const leaked = facts.filter((fact) =>
                    world.expected.distractors.some((d) =>
                      fact.statement.toLowerCase().includes(d.toLowerCase()),
                    ),
                  )
                  return {
                    pass: leaked.length === 0,
                    ...(leaked.length > 0
                      ? { detail: `leaked: ${leaked.map((f) => f.statement.slice(0, 60)).join("; ")}` }
                      : {}),
                  }
                }),
              ),
          },
        ],
      },
    ],
    judges: [extractionFidelityJudge],
  })

/* ------------------------------------------------------------------ */
/* Consolidation — deterministic op-matching                           */
/* ------------------------------------------------------------------ */

const ConsolidateCase = Schema.parseJson(
  Schema.Struct({
    actives: Schema.Array(CandidateFact),
    candidates: Schema.Array(CandidateFact),
    /** Expected op per candidate (1-based index), memory = 1-based active. */
    expected: Schema.Array(
      Schema.Union(
        Schema.Struct({ candidate: Schema.Number, op: Schema.Literal("create") }),
        Schema.Struct({
          candidate: Schema.Number,
          op: Schema.Literal("corroborate", "update"),
          memory: Schema.Number,
        }),
      ),
    ),
  }),
)
export type ConsolidateCaseData = typeof ConsolidateCase.Type

export const readConsolidateCase = (
  dir: string,
  name: string,
): Effect.Effect<ConsolidateCaseData, unknown> =>
  Effect.try(() => readFileSync(join(dir, name, "case.json"), "utf-8")).pipe(
    Effect.flatMap((text) => Schema.decodeUnknown(ConsolidateCase)(text)),
  )

type Verbs = ReadonlyArray<typeof ConsolidateOutput.Type[number]>

interface ConsolidateWorld {
  readonly data: ConsolidateCaseData
  readonly verbs: Ref.Ref<Option.Option<Verbs>>
  readonly complete: (prompt: string) => Effect.Effect<string, unknown>
}

const toRecords = (facts: ReadonlyArray<typeof CandidateFact.Type>): ReadonlyArray<MemoryRecord> =>
  facts.map(
    (fact, index) =>
      new MemoryRecord({
        id: MemoryId.make(`m${index + 1}`),
        topic: fact.topic,
        statement: fact.statement,
        corroboration: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        sources: ["r0"],
      }),
  )

/** Did the model emit the expected op for candidate i (and the right target)? */
export const opMatches = (
  verbs: Verbs,
  expected: ConsolidateCaseData["expected"][number],
): boolean =>
  expected.op === "create"
    ? verbs.some((verb) => verb.op === "create" && verb.candidate === expected.candidate)
    : verbs.some(
        (verb) =>
          verb.op === expected.op &&
          "memory" in verb &&
          verb.memory === expected.memory,
      )

const consolidateScenario = (name: string) =>
  scenario<ConsolidateWorld>({
    name: `consolidate:${name}`,
    modes: ["live"],
    boot: Effect.gen(function* () {
      const data = yield* readConsolidateCase(CONSOLIDATE_FIXTURES, name).pipe(Effect.orDie)
      const verbs = yield* Ref.make(Option.none<Verbs>())
      const utility = yield* Layer.build(utilityTier(process.cwd()))
      const complete = (prompt: string) =>
        UtilityLlm.pipe(
          Effect.flatMap((service) => service.complete(prompt)),
          Effect.map((response) => response.text),
          Effect.provide(utility),
        )
      return { data, verbs, complete }
    }),
    steps: [
      {
        name: "consolidate against the actives",
        act: (world) =>
          Effect.gen(function* () {
            const reply = yield* world.complete(
              consolidatePrompt(toRecords(world.data.actives), world.data.candidates),
            )
            const decoded = yield* Schema.decodeUnknown(ConsolidateOutput)(stripFences(reply)).pipe(
              Effect.option,
            )
            yield* Ref.set(world.verbs, decoded)
          }),
        checks: [
          {
            name: "verbs decode",
            severity: "hard",
            run: (world) =>
              Ref.get(world.verbs).pipe(
                Effect.map((verbs) => ({ pass: Option.isSome(verbs) })),
              ),
          },
          // One SOFT check per expected op — partial credit accrues per
          // candidate instead of one all-or-nothing verdict.
          {
            name: "expected ops emitted",
            severity: "soft",
            run: (world) =>
              Ref.get(world.verbs).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => ({ pass: false, detail: "no verbs decoded" }),
                    onSome: (verbs) => {
                      const missed = world.data.expected.filter(
                        (expected) => !opMatches(verbs, expected),
                      )
                      return {
                        pass: missed.length === 0,
                        ...(missed.length > 0
                          ? {
                              detail: `missed: ${missed
                                .map((m) => `C${m.candidate}→${m.op}`)
                                .join(", ")} (got ${JSON.stringify(verbs)})`,
                            }
                          : {}),
                      }
                    },
                  }),
                ),
              ),
          },
        ],
      },
    ],
  })

export const memoryPack: Pack = {
  name: "memory",
  threshold: 0.9,
  judgeWeight: 0.7,
  // One golden case regressing must not hide behind another's headroom.
  perScenarioRatchet: true,
  perScenarioTolerance: 0.15,
  meta: { "memory-prompts": MEMORY_PROMPTS_VERSION },
  scenarios: [
    ...listCases(EXTRACT_FIXTURES).map(extractScenario),
    ...listCases(CONSOLIDATE_FIXTURES).map(consolidateScenario),
  ],
}
