import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { JsonObject, SessionLogEvent } from "../session/session-log.entity.js"
import { modelRequestHeaderOf } from "./model-request.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000a7a7")

const header = (runId: Schema.Json, step: Schema.Json, system: Schema.Json): JsonObject => ({
  version: 1, runId, step, strategyVersion: "window@1", system,
  render: { strategy: "window", currentTurn: 1, currentRun: "run-1", turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8 } },
  through: null, contextFingerprint: "f", tools: [], toolChoice: "auto", model: null, cacheKey: null, callPolicy: null,
})

const prepared = (seq: number, data: JsonObject): SessionLogEvent => ({ session, seq, turn: Option.some(1), kind: "request.prepared", at: 0, data })

/** The header found for step 0 of run-1's run `run` (its first by default), or the code it failed with. */
const found = (events: ReadonlyArray<SessionLogEvent>, run = 0) => Effect.runPromise(modelRequestHeaderOf(events, RunId.make("run-1"), 0, RunOrdinal.make(run)).pipe(
  Effect.match({ onFailure: (error) => error.code, onSuccess: (decoded) => decoded.system }),
))

describe("a request's stored header, found by its run and step", () => {
  test("each run of a turn finds its own header for a step; one stored before runs were counted is the first run's", async () => {
    const runs = [
      prepared(1, header("run-1", 0, "before runs were counted")),
      prepared(2, { ...header("run-1", 0, "second run"), run: 1 }),
    ]
    expect([await found(runs, 0), await found(runs, 1), await found(runs, 2)]).toEqual(["before runs were counted", "second run", "request.missing"])
    expect(await found([...runs, prepared(3, { ...header("run-1", 0, "first run"), run: 0 })], 0)).toBe("first run")
  })

  test("the last header of the run and step is decoded; one of another run or step is not", async () => {
    expect(await found([
      prepared(1, header("run-1", 0, "first")),
      prepared(2, header("run-2", 0, "other run")),
      prepared(3, header("run-1", 0, "retried")),
      prepared(4, header("run-1", 1, "next step")),
    ])).toBe("retried")
    expect(await found([prepared(1, header("run-2", 0, "other run"))])).toBe("request.missing")
  })

  test("a header whose run or step does not decode fails with request.decode, never reads as missing", async () => {
    expect(await found([prepared(1, header(7, 0, "system"))])).toBe("request.decode")
    expect(await found([prepared(1, header("run-1", "0", "system"))])).toBe("request.decode")
  })

  test("only the header found is decoded whole", async () => {
    expect(await found([prepared(1, header("run-2", 0, 42)), prepared(2, header("run-1", 0, "system"))])).toBe("system")
    expect(await found([prepared(1, header("run-1", 0, 42))])).toBe("request.decode")
  })
})
