import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { Scenario } from "./model.js"
import { runPack, scenario } from "./run.js"

/**
 * The k-sample fold: each sample boots its OWN world; the recorded score is
 * the mean, passRate is the all-hard-green fraction, and k=1 stays
 * byte-identical to the unsampled runner (no `samples` field at all).
 */

/** A scenario whose Nth boot passes/fails per the script — the stochastic twin. */
const flaky = (script: ReadonlyArray<boolean>, counter: Ref.Ref<number>): Scenario<{ readonly pass: boolean }> => ({
  name: "flaky",
  modes: ["live"],
  boot: Effect.gen(function* () {
    const n = yield* Ref.getAndUpdate(counter, (x) => x + 1)
    return { pass: script[n % script.length] ?? true }
  }),
  steps: [
    {
      name: "s1",
      act: () => Effect.void,
      checks: [
        {
          name: "scripted",
          severity: "hard",
          run: (world) => Effect.succeed({ pass: world.pass }),
        },
      ],
    },
  ],
})

describe("sampled scenarios (pass@k)", () => {
  test("k=3 over pass/fail/pass → mean 2/3, passRate 2/3, last sample's checks shown", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        return yield* scenario(flaky([true, false, true], counter)).run("live", 0.3, 3)
      }),
    )
    expect(result.status).toBe("ran")
    expect(result.combined).toBeCloseTo(2 / 3, 5)
    expect(result.samples?.count).toBe(3)
    expect(result.samples?.scores).toEqual([1, 0, 1])
    expect(result.samples?.passRate).toBeCloseTo(2 / 3, 5)
    // checks shown are the LAST sample's (a passing one).
    expect(result.checks.every((c) => c.pass)).toBe(true)
  })

  test("k=1 is byte-identical to the unsampled runner — no samples field", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        return yield* scenario(flaky([true], counter)).run("live", 0.3, 1)
      }),
    )
    expect(result.samples).toBeUndefined()
    expect(result.combined).toBe(1)
  })

  test("mode mismatch skips ONCE — no extra sample boots", async () => {
    const { result, boots } = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        const result = yield* scenario(flaky([true], counter)).run("scripted", 0.3, 3)
        const boots = yield* Ref.get(counter)
        return { result, boots }
      }),
    )
    expect(result.status).toBe("skipped")
    expect(boots).toBe(0)
  })

  test("runPack threads Pack.samples to every scenario", async () => {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        return yield* runPack(
          {
            name: "sampled",
            threshold: 0.5,
            samples: 2,
            scenarios: [scenario(flaky([true, false], counter))],
          },
          "live",
        )
      }),
    )
    expect(report.scenarios[0]?.samples?.count).toBe(2)
    expect(report.mean).toBeCloseTo(0.5, 5)
  })
})
