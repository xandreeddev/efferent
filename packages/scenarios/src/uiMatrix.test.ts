import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { landingReference } from "@xandreed/ui-agent"
import { cappedTrial, containTrialFailure } from "@xandreed/evals/campaign"
import { deriveStageMetrics, failedTrial, scoreInformationArchitecture, scoreRequestRelevance, serverReceiveMs } from "./uiMatrix.js"

describe("the UI matrix deterministic scorers", () => {
  test("localized and inflected copy satisfies semantic concept aliases", () => {
    const page = {
      manifest: { ...landingReference.page, title: "Ricette Italiane" },
      blocks: landingReference.blocks.map((block) => block.kind === "hero" ? { ...block, title: "Ricette italiane per regione", lede: "Cerca ingredienti e ritrova le ricette salvate." } : block),
      complete: true,
    }
    expect(scoreRequestRelevance(page, [["italian", "italia"], ["recipe", "ricett"], ["regional", "region"], ["ingredient"], ["saved", "salvat"]])).toBe(1)
  })

  test("a structurally valid page still fails IA when it chooses the wrong archetype", () => {
    const page = { manifest: landingReference.page, blocks: landingReference.blocks, complete: true }
    expect(scoreInformationArchitecture(page, "landing")).toBe(1)
    expect(scoreInformationArchitecture(page, "application")).toBeLessThan(1)
  })

  test("provider errors and defects become failed trial evidence instead of aborting concurrent work", async () => {
    const candidate = { model: "opencode:test", effort: "low" as const, protocol: "compact-lines" as const }
    const task = { id: "test", prompt: "Build a test page.", archetype: "landing" as const, concepts: [["test"]], screening: true }
    const trials = await Effect.runPromise(Effect.forEach([
      Effect.fail(new Error("provider rejected the request")),
      Effect.die(new Error("SQLite disk I/O error")),
    ], (failure, index) => containTrialFailure((cause) => failedTrial(candidate, task, index + 1, cause), failure), { concurrency: 2 }))

    expect(trials).toHaveLength(2)
    expect(trials.every((trial) => !trial.complete && trial.failures.length === 1)).toBe(true)
    expect(trials.flatMap((trial) => trial.errors).join("\n")).toContain("provider rejected the request")
    expect(trials.flatMap((trial) => trial.errors).join("\n")).toContain("SQLite disk I/O error")
  })

  test("stage metrics attribute wall-clock, usage, and turns per stage — repair intervals accumulate", () => {
    const timeline = [
      { tMs: 5, type: "ui_stage", stage: "turn", phase: "started" },
      { tMs: 10, type: "ui_stage", stage: "planner", phase: "started" },
      { tMs: 4_000, type: "assistant_message", inputTokens: 1_200, outputTokens: 400 },
      { tMs: 4_010, type: "ui_stage", stage: "planner", phase: "settled" },
      { tMs: 4_020, type: "ui_stage", stage: "composer", phase: "started" },
      { tMs: 9_000, type: "assistant_message", inputTokens: 2_000, outputTokens: 900 },
      { tMs: 14_000, type: "assistant_message", inputTokens: 2_900, outputTokens: 850 },
      { tMs: 14_050, type: "ui_stage", stage: "composer", phase: "settled" },
      { tMs: 14_060, type: "ui_stage", stage: "repair", phase: "started" },
      { tMs: 18_000, type: "assistant_message", inputTokens: 3_100, outputTokens: 300 },
      { tMs: 18_010, type: "ui_stage", stage: "repair", phase: "settled" },
      { tMs: 18_020, type: "ui_stage", stage: "repair", phase: "started" },
      { tMs: 20_020, type: "ui_stage", stage: "repair", phase: "settled" },
    ]
    const metrics = new Map(deriveStageMetrics(timeline).map((metric) => [metric.stage, metric]))
    expect(metrics.get("planner")).toEqual({ stage: "planner", wallMs: 4_000, inputTokens: 1_200, outputTokens: 400, turns: 1 })
    expect(metrics.get("composer")).toEqual({ stage: "composer", wallMs: 10_030, inputTokens: 4_900, outputTokens: 1_750, turns: 2 })
    expect(metrics.get("repair")).toEqual({ stage: "repair", wallMs: 5_950, inputTokens: 3_100, outputTokens: 300, turns: 1 })
    expect(serverReceiveMs(timeline)).toEqual(Option.some(5))
    expect(serverReceiveMs([])).toEqual(Option.none())
  })

  test("a trial deadline waits for bounded cleanup and records a failed sample", async () => {
    const candidate = { model: "opencode:test", effort: "low" as const, protocol: "compact-lines" as const }
    const task = { id: "test", prompt: "Build a test page.", archetype: "landing" as const, concepts: [["test"]], screening: true }
    // Browser/provider adapters must bound cleanup; the campaign awaits it rather
    // than leaving a disconnected paid request alive.
    const wedged = Effect.never.pipe(Effect.ensuring(Effect.sleep("20 millis"))) as Effect.Effect<never, unknown>
    const startedAt = Date.now()
    const trial = await Effect.runPromise(containTrialFailure((cause) => failedTrial(candidate, task, 1, cause), cappedTrial(150, wedged)))

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(trial.complete).toBe(false)
    expect(trial.errors.join("\n")).toContain("execution deadline")
  })
})
