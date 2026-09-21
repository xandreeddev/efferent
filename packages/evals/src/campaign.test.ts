import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Ref } from "effect"
import { cappedTrial, containTrialFailure, grid, runCampaign, trialFileName } from "./campaign.js"
import { mean, percentile, standardDeviation } from "./stats.js"

interface Trial {
  readonly id: string
  readonly ok: boolean
  readonly error: string | null
}

describe("the campaign chassis", () => {
  test("the grid is candidates × tasks × samples, samples 1-based, in that order", () => {
    const cells = grid(["a", "b"], ["x"], 2)
    expect(cells).toEqual([
      { candidate: "a", task: "x", sample: 1 },
      { candidate: "a", task: "x", sample: 2 },
      { candidate: "b", task: "x", sample: 1 },
      { candidate: "b", task: "x", sample: 2 },
    ])
    expect(trialFileName(["opencode:kimi-k2.6", "medium", "Recipe Finder", 1])).toBe(
      "opencode-kimi-k2.6-medium-recipe-finder-1",
    )
  })

  test("failures and deadlines settle as failed rows after bounded cleanup", async () => {
    const failed = (cause: string): Trial => ({ id: "?", ok: false, error: cause })
    const cleaned = await Effect.runPromise(Ref.make(false))
    const wedged = Effect.never.pipe(Effect.ensuring(Effect.sleep("20 millis").pipe(Effect.zipRight(Ref.set(cleaned, true))))) as Effect.Effect<Trial, unknown>
    const startedAt = Date.now()
    const trials = await Effect.runPromise(
      Effect.forEach(
        [
          Effect.fail(new Error("provider rejected the request")) as Effect.Effect<Trial, unknown>,
          Effect.die(new Error("SQLite disk I/O error")) as Effect.Effect<Trial, unknown>,
          cappedTrial(150, wedged),
        ],
        (trial) => containTrialFailure(failed, trial),
        { concurrency: 3 },
      ),
    )
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(await Effect.runPromise(Ref.get(cleaned))).toBe(true)
    expect(trials.every((t) => !t.ok)).toBe(true)
    expect(trials[0]?.error).toContain("provider rejected the request")
    expect(trials[1]?.error).toContain("SQLite disk I/O error")
    expect(trials[2]?.error).toContain("execution deadline")
  })

  test("runCampaign persists every settled trial IMMEDIATELY under trials/ and returns them in cell order", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "campaign-"))
    const trials = await Effect.runPromise(
      runCampaign<string, string, Trial>({
        name: "test-matrix",
        cells: grid(["m1", "m2"], ["t"], 1),
        concurrency: 2,
        capMs: () => 1_000,
        run: (cell) =>
          cell.candidate === "m2"
            ? Effect.fail(new Error("boom"))
            : Effect.succeed({ id: `${cell.candidate}-${cell.task}-${cell.sample}`, ok: true, error: null }),
        failed: (cell, cause) => ({ id: `${cell.candidate}-${cell.task}-${cell.sample}`, ok: false, error: cause }),
        evidenceDir,
        trialVersion: "test-trial-v1",
        trialName: (cell) => trialFileName([cell.candidate, cell.task, cell.sample]),
        describe: (cell) => cell.candidate,
        summarize: (trial) => trial.id,
      }),
    )
    const files = readdirSync(join(evidenceDir, "trials")).sort()
    const persisted = JSON.parse(readFileSync(join(evidenceDir, "trials", "m2-t-1.json"), "utf8")) as {
      version: string
      trial: Trial
    }
    rmSync(evidenceDir, { recursive: true, force: true })
    expect(trials.map((t) => [t.id, t.ok])).toEqual([
      ["m1-t-1", true],
      ["m2-t-1", false],
    ])
    expect(files).toEqual(["m1-t-1.json", "m2-t-1.json"])
    expect(persisted.version).toBe("test-trial-v1")
    expect(persisted.trial.error).toContain("boom")
  })

  test("the descriptive stats: nearest-rank percentile, +Infinity for nothing measured, population sd", () => {
    expect(percentile([], 0.5)).toBe(Number.POSITIVE_INFINITY)
    expect(percentile([30, 10, 20], 0.5)).toBe(20)
    expect(percentile([30, 10, 20], 0.95)).toBe(30)
    expect(mean([])).toBe(0)
    expect(mean([1, 2, 3])).toBe(2)
    expect(standardDeviation([5])).toBe(0)
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2)
  })
})
