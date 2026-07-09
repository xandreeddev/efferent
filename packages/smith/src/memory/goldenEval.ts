import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { UtilityLlm } from "@xandreed/engine"
import {
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
  UtilityLlmLive,
} from "@xandreed/providers"
import { extractPrompt } from "./curate.js"
import { MemoryTopic } from "./domain.js"

/**
 * The memory GOLDEN-SET eval — manual, keyed, never CI-gated (the selftest
 * pattern): run the extraction prompt on the REAL fast tier over labeled
 * transcripts and score precision/recall against hand-written expectations.
 * Targets that guide prompt iteration: precision ≥ 0.8, recall ≥ 0.6.
 *
 *   bun packages/smith/src/memory/goldenEval.ts
 */

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "memory-golden")

const CandidateFact = Schema.Struct({ topic: MemoryTopic, statement: Schema.String })
const ExtractOutput = Schema.parseJson(Schema.Array(CandidateFact))
const Expected = Schema.parseJson(
  Schema.Struct({
    expected: Schema.Array(CandidateFact),
    distractors: Schema.Array(Schema.String),
  }),
)

const stripFences = (text: string): string => {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced?.[1] ?? trimmed
}

const judgePrompt = (extracted: string, expected: string): string =>
  `Do these two statements express the SAME workspace fact? Reply with exactly "yes" or "no".\nA: ${extracted}\nB: ${expected}`

const program = Effect.gen(function* () {
  const utility = yield* UtilityLlm
  const cases = readdirSync(FIXTURES)

  const scores = yield* Effect.forEach(cases, (name) =>
    Effect.gen(function* () {
      const transcript = readFileSync(join(FIXTURES, name, "transcript.txt"), "utf-8")
      const golden = yield* Schema.decodeUnknown(Expected)(
        readFileSync(join(FIXTURES, name, "expected.json"), "utf-8"),
      )
      const response = yield* utility.complete(extractPrompt(transcript))
      const extracted = yield* Schema.decodeUnknown(ExtractOutput)(
        stripFences(response.text),
      ).pipe(Effect.orElseSucceed(() => []))

      const equivalent = (a: string, b: string) =>
        utility
          .complete(judgePrompt(a, b))
          .pipe(Effect.map((r) => r.text.trim().toLowerCase().startsWith("yes")))

      const matchedPerExtracted = yield* Effect.forEach(extracted, (fact) =>
        Effect.reduce(golden.expected, false, (hit, expect) =>
          hit ? Effect.succeed(true) : equivalent(fact.statement, expect.statement),
        ),
      )
      const matchedPerExpected = yield* Effect.forEach(golden.expected, (expect) =>
        Effect.reduce(extracted, false, (hit, fact) =>
          hit ? Effect.succeed(true) : equivalent(fact.statement, expect.statement),
        ),
      )
      const truePositives = matchedPerExtracted.filter(Boolean).length
      const precision = extracted.length === 0 ? 1 : truePositives / extracted.length
      const recall =
        golden.expected.length === 0
          ? extracted.length === 0
            ? 1
            : 0
          : matchedPerExpected.filter(Boolean).length / golden.expected.length
      const leaked = extracted.filter((fact) =>
        golden.distractors.some((d) => fact.statement.toLowerCase().includes(d.toLowerCase())),
      ).length

      console.log(
        `${name}: precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)} · extracted ${extracted.length} · distractors leaked ${leaked}`,
      )
      return { precision, recall }
    }),
  )

  const meanP = scores.reduce((s, x) => s + x.precision, 0) / Math.max(scores.length, 1)
  const meanR = scores.reduce((s, x) => s + x.recall, 0) / Math.max(scores.length, 1)
  console.log(`\nmean precision ${meanP.toFixed(2)} (target ≥ 0.80) · mean recall ${meanR.toFixed(2)} (target ≥ 0.60)`)
  return meanP >= 0.8 && meanR >= 0.6 ? 0 : 1
})

const services = UtilityLlmLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive(process.cwd(), homedir()),
      LocalSettingsStoreLive(process.cwd(), homedir()),
    ),
  ),
)

const code = await Effect.runPromise(
  program.pipe(
    Effect.provide(services),
    Effect.catchAll((error) => Effect.sync(() => {
      console.error(`golden eval failed: ${String(error)}`)
      return 2
    })),
  ),
)
process.exit(code)
