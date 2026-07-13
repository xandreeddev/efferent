import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { landingReference } from "@xandreed/ui-agent"
import { containTrialFailure, scoreInformationArchitecture, scoreRequestRelevance } from "./uiMatrix.js"

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
    ], (failure, index) => containTrialFailure(candidate, task, index + 1, failure), { concurrency: 2 }))

    expect(trials).toHaveLength(2)
    expect(trials.every((trial) => !trial.complete && trial.failures.length === 1)).toBe(true)
    expect(trials.flatMap((trial) => trial.errors).join("\n")).toContain("provider rejected the request")
    expect(trials.flatMap((trial) => trial.errors).join("\n")).toContain("SQLite disk I/O error")
  })
})
