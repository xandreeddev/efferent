import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { UtilityLlm } from "@xandreed/engine"
import { DIGEST_PROMPT_VERSION, digestPrompt } from "@xandreed/smith"
import type { Judge, Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { listCases } from "../live/fixtures.js"
import { utilityTier } from "../live/llm.js"

/**
 * The DIGEST battery — the compaction handoff is the coder's ONLY memory
 * across a fold, so what it preserves is load-bearing. Labeled transcripts
 * carry the facts a handoff MUST retain (by axis: task / state /
 * verification / dead-end) and the claims it must NOT invent; the judge is a
 * per-fact yes/no probe fold on the fast tier (the goldenEval pattern):
 *   score = clamp(retained/total − 0.25·inventions)
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "smith", "fixtures", "digest-golden")

const ExpectedFile = Schema.parseJson(
  Schema.Struct({
    mustRetain: Schema.Array(
      Schema.Struct({
        axis: Schema.Literal("task", "state", "verification", "dead-end"),
        fact: Schema.NonEmptyString,
      }),
    ),
    mustNotInvent: Schema.Array(Schema.NonEmptyString),
  }),
)
export type DigestExpected = typeof ExpectedFile.Type

export const readDigestCase = (
  dir: string,
  name: string,
): Effect.Effect<
  { readonly transcript: string; readonly prior: Option.Option<string>; readonly expected: DigestExpected },
  unknown
> =>
  Effect.gen(function* () {
    const transcript = yield* Effect.try(() =>
      readFileSync(join(dir, name, "transcript.txt"), "utf-8"),
    )
    const prior = existsSync(join(dir, name, "prior.txt"))
      ? Option.some(readFileSync(join(dir, name, "prior.txt"), "utf-8"))
      : Option.none<string>()
    const expected = yield* Schema.decodeUnknown(ExpectedFile)(
      readFileSync(join(dir, name, "expected.json"), "utf-8"),
    )
    return { transcript, prior, expected }
  })

interface DigestWorld {
  readonly transcript: string
  readonly expected: DigestExpected
  readonly digest: Ref.Ref<string>
  readonly complete: (prompt: string) => Effect.Effect<string, unknown>
}

const probe = (kind: "states" | "claims", digest: string, fact: string): string =>
  `Does the following handoff ${kind === "states" ? "STATE (explicitly or by clear paraphrase)" : "CLAIM"} this fact? Reply with exactly "yes" or "no".\nFACT: ${fact}\n\nHANDOFF:\n${digest}`

/** retained/total − 0.25·inventions, via fast-tier yes/no probes. */
export const factCoverageJudge: Judge<DigestWorld> = {
  name: "fact-coverage",
  run: (world) =>
    Effect.gen(function* () {
      const digest = yield* Ref.get(world.digest)
      const yes = (reply: string) => reply.trim().toLowerCase().startsWith("yes")
      const retained = yield* Effect.forEach(world.expected.mustRetain, (entry) =>
        world.complete(probe("states", digest, entry.fact)).pipe(Effect.map(yes)),
      )
      const invented = yield* Effect.forEach(world.expected.mustNotInvent, (claim) =>
        world.complete(probe("claims", digest, claim)).pipe(Effect.map(yes)),
      )
      const total = Math.max(world.expected.mustRetain.length, 1)
      const missed = world.expected.mustRetain.filter((_, index) => retained[index] !== true)
      const score =
        retained.filter(Boolean).length / total - 0.25 * invented.filter(Boolean).length
      return {
        score,
        reason:
          missed.length === 0 && invented.every((x) => !x)
            ? "all facts retained, nothing invented"
            : `missed: ${missed.map((entry) => `[${entry.axis}] ${entry.fact.slice(0, 60)}`).join("; ") || "none"}${invented.some(Boolean) ? ` · invented ${invented.filter(Boolean).length}` : ""}`,
      }
    }),
}

const digestScenario = (name: string) =>
  scenario<DigestWorld>({
    name,
    modes: ["live"],
    boot: Effect.gen(function* () {
      const fixture = yield* readDigestCase(FIXTURES, name).pipe(Effect.orDie)
      const digest = yield* Ref.make("")
      const utility = yield* Layer.build(utilityTier(process.cwd()))
      const complete = (prompt: string) =>
        UtilityLlm.pipe(
          Effect.flatMap((service) => service.complete(prompt)),
          Effect.map((response) => response.text),
          Effect.provide(utility),
        )
      return { transcript: fixture.transcript, expected: fixture.expected, digest, complete }
    }),
    steps: [
      {
        name: "digest the trail",
        act: (world) =>
          Effect.gen(function* () {
            const fixture = yield* readDigestCase(FIXTURES, name).pipe(Effect.orDie)
            const reply = yield* world.complete(digestPrompt(world.transcript, fixture.prior))
            yield* Ref.set(world.digest, reply.trim())
          }),
        checks: [
          {
            name: "handoff is non-empty",
            severity: "hard",
            run: (world) =>
              Ref.get(world.digest).pipe(
                Effect.map((digest) => ({ pass: digest.length > 0 })),
              ),
          },
          {
            name: "compression happened",
            severity: "soft",
            run: (world) =>
              Ref.get(world.digest).pipe(
                Effect.map((digest) => ({
                  pass: digest.length <= Math.min(world.transcript.length * 0.5 + 500, 8_000),
                  detail: `digest ${digest.length} chars vs transcript ${world.transcript.length}`,
                })),
              ),
          },
        ],
      },
    ],
    judges: [factCoverageJudge],
  })

export const digestPack: Pack = {
  name: "digest",
  threshold: 0.8,
  samples: 2,
  judgeWeight: 0.8,
  // One golden case regressing must not hide behind another's headroom.
  perScenarioRatchet: true,
  perScenarioTolerance: 0.2,
  meta: { "digest-prompt": DIGEST_PROMPT_VERSION },
  scenarios: listCases(FIXTURES).map(digestScenario),
}
