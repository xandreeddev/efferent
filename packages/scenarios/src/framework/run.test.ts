import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { Check, Pack, Scenario } from "./model.js"
import { runPack, runScenario, scenario } from "./run.js"
import { eventCount, eventOrder, fileExists } from "./evidence.js"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface ToyWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<{ readonly type: string }>
  readonly emit: (type: string) => Effect.Effect<void>
}

const bootToy = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-toy-"))
  const ref = yield* Ref.make<ReadonlyArray<{ type: string }>>([])
  return {
    dir,
    events: () => Effect.runSync(Ref.get(ref)),
    emit: (type: string) => Ref.update(ref, (all) => [...all, { type }]),
  } satisfies ToyWorld
})

const alwaysPass: Check<ToyWorld> = {
  name: "always-pass",
  severity: "hard",
  run: () => Effect.succeed({ pass: true }),
}

const toy = (over: Partial<Scenario<ToyWorld>>): Scenario<ToyWorld> => ({
  name: "toy",
  modes: ["scripted"],
  boot: bootToy,
  steps: [{ name: "s1", act: () => Effect.void, checks: [alwaysPass] }],
  ...over,
})

describe("runScenario", () => {
  test("a hard-check failure stops the scenario; remaining steps' checks count as failed", async () => {
    const result = await Effect.runPromise(
      runScenario(
        toy({
          steps: [
            {
              name: "first",
              act: (w) => w.emit("a"),
              checks: [
                {
                  name: "hard-fail",
                  severity: "hard",
                  run: () => Effect.succeed({ pass: false, detail: "nope" }),
                },
              ],
            },
            { name: "second (must be skipped)", act: () => Effect.void, checks: [alwaysPass] },
          ],
        }),
        "scripted",
        0.3,
      ),
    )
    expect(result.status).toBe("ran")
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1]?.detail).toContain("skipped")
    expect(result.detail).toContain("hard check failed")
  })

  test("a soft failure records a finding but the scenario continues", async () => {
    const result = await Effect.runPromise(
      runScenario(
        toy({
          steps: [
            {
              name: "first",
              act: () => Effect.void,
              checks: [
                {
                  name: "soft-fail",
                  severity: "soft",
                  run: () => Effect.succeed({ pass: false, detail: "meh" }),
                },
              ],
            },
            { name: "second", act: () => Effect.void, checks: [alwaysPass] },
          ],
        }),
        "scripted",
        0.3,
      ),
    )
    expect(result.score).toBe(0.5)
    expect(result.detail).toBeUndefined()
  })

  test("mode mismatch skips; an act failure is captured, never thrown", async () => {
    const skipped = await Effect.runPromise(
      runScenario(toy({ modes: ["live"] }), "scripted", 0.3),
    )
    expect(skipped.status).toBe("skipped")

    const crashed = await Effect.runPromise(
      runScenario(
        toy({
          steps: [
            { name: "boom", act: () => Effect.fail("provider down"), checks: [alwaysPass] },
          ],
        }),
        "scripted",
        0.3,
      ),
    )
    expect(crashed.status).toBe("ran")
    expect(crashed.score).toBe(0)
    expect(crashed.checks[0]?.detail).toContain("act failed")
  })

  test("evidence: eventOrder subsequence + eventCount bounds + fileExists", async () => {
    const result = await Effect.runPromise(
      runScenario(
        toy({
          steps: [
            {
              name: "emit",
              act: (w) =>
                w.emit("a").pipe(
                  Effect.zipRight(w.emit("noise")),
                  Effect.zipRight(w.emit("b")),
                  Effect.zipRight(
                    Effect.sync(() => writeFileSync(join(w.dir, "made.txt"), "x")),
                  ),
                ),
              checks: [
                eventOrder(["a", "b"]),
                eventOrder(["b", "a"], "soft"),
                eventCount("noise", { max: 1 }),
                fileExists("made.txt"),
              ],
            },
          ],
        }),
        "scripted",
        0.3,
      ),
    )
    const byName = Object.fromEntries(result.checks.map((c) => [c.check, c.pass]))
    expect(byName["event-order:a→b"]).toBe(true)
    expect(byName["event-order:b→a"]).toBe(false)
    expect(byName["event-count:noise"]).toBe(true)
    expect(byName["file-exists:made.txt"]).toBe(true)
  })
})

describe("runPack", () => {
  test("means fold over RAN scenarios; skipped don't dilute; threshold gates", async () => {
    const pack: Pack = {
      name: "toy-pack",
      threshold: 0.9,
      scenarios: [
        scenario(toy({ name: "passes" })),
        scenario(toy({ name: "live-only", modes: ["live"] })),
      ],
    }
    const report = await Effect.runPromise(runPack(pack, "scripted"))
    expect(report.mean).toBe(1)
    expect(report.passed).toBe(true)
    expect(report.scenarios.map((s) => s.status)).toEqual(["ran", "skipped"])
  })
})
