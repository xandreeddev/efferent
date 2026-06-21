import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { recordLlmCall, recordToolCall, conversationSessionId } from "@xandreed/sdk-core"
import { makeAgentBus } from "../usecases/agentBus.js"
import { readWorkspaceMetrics } from "./metrics.js"
import { FAKE_ROOT_CID, fakeServerLive } from "./fakeAppEnv.js"
import { makeHttpTransport } from "../transport/http/client.js"

describe("readWorkspaceMetrics", () => {
  test("aggregates per-role token spend + agent counts from the global registry + bus", async () => {
    // A unique role isolates the assertion from the process-global, cumulative
    // metric registry (other tests record under main/fast).
    const role = `cp-test-${crypto.randomUUID().slice(0, 8)}`
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordLlmCall(role, "google", "gemini-x", {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadTokens: 5,
        })
        yield* recordToolCall("read_file", true)
        const bus = makeAgentBus()
        yield* bus.markRunning("n1", "agent one")
        return yield* readWorkspaceMetrics({ bus, fleets: 3, startedAt: 0, now: 1234 })
      }),
    )
    expect(result.tokensByRole[role]?.input).toBe(100)
    expect(result.tokensByRole[role]?.output).toBe(20)
    expect(result.tokensByRole[role]?.cache).toBe(5)
    expect(result.fleets).toBe(3)
    expect(result.agentsRunning).toBe(1) // own bus → isolated
    expect(result.toolCallsOk).toBeGreaterThanOrEqual(1) // global counter, monotonic
    expect(result.uptimeMs).toBe(1234)
  })
})

describe("GET /metrics over the wire", () => {
  test("a turn through the daemon shows up in the metrics endpoint", async () => {
    const rootId = conversationSessionId(FAKE_ROOT_CID as never)
    const metrics = await Effect.runPromise(
      Effect.gen(function* () {
        const t = makeHttpTransport("")
        yield* t.send(rootId, "metrics please")
        yield* t
          .subscribe(rootId, 0)
          .pipe(
            Stream.takeUntil((e) => e.event.type === "agent_end"),
            Stream.runDrain,
            Effect.timeout("8 seconds"),
          )
        return yield* t.metrics()
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID))),
    )
    // The fake server hosts one fleet; a turn ran → turns counter advanced.
    expect(metrics.fleets).toBeGreaterThanOrEqual(1)
    expect(metrics.turns).toBeGreaterThanOrEqual(1)
    expect(typeof metrics.uptimeMs).toBe("number")
  })
})
