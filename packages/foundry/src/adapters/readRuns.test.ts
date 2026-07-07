import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { FactoryRun } from "../domain/FactoryRun.js"
import { RunSink } from "../ports/RunSink.js"
import { makeFileRunSink } from "./fileRunSink.js"
import { readRuns } from "./readRuns.js"

const sample = (id: string, endedAt: number): FactoryRun =>
  Schema.decodeUnknownSync(FactoryRun)({
    id,
    spec: { goal: "g", acceptance: ["a"], limits: { maxAttempts: 3, budgetMillis: 1000 } },
    attempts: [
      {
        attempt: 1,
        report: { verdicts: [{ _tag: "pass", gate: "bun-test", durationMs: 1, findings: [] }] },
        filesTouched: [],
        durationMs: 1,
      },
    ],
    outcome: { _tag: "accepted", attempt: 1 },
    startedAt: endedAt - 10,
    endedAt,
  })

describe("readRuns — the memory read", () => {
  test("round-trips what makeFileRunSink wrote, oldest-first; corrupt files are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-runs-"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* RunSink
        yield* sink.persist(sample("00000000-0000-4000-8000-000000000002", 200))
        yield* sink.persist(sample("00000000-0000-4000-8000-000000000001", 100))
      }).pipe(Effect.provide(makeFileRunSink(dir))),
    )
    writeFileSync(join(dir, "corrupt.json"), "{not json")
    writeFileSync(join(dir, "wrong-shape.json"), `{"hello": 1}`)

    const runs = await Effect.runPromise(readRuns(dir))
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.endedAt)).toEqual([100, 200])
  })

  test("a missing directory is an empty history", async () => {
    const runs = await Effect.runPromise(readRuns("/nonexistent/nowhere"))
    expect(runs).toEqual([])
  })
})
