import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { AgentSubAgentEndEvent } from "../entities/AgentHooks.js"
import type { ContextReturn, ContextTreeStore } from "../ports/ContextTreeStore.js"
import { makeAgentBus } from "./agentBus.js"
import { finalizeRun } from "./finalizeRun.js"

const nodeId = "11111111-1111-1111-1111-111111111111" as ContextNodeId

/** A store stub that records every recordReturn call. */
const recordingStore = () => {
  const calls: Array<{ id: string; result: ContextReturn }> = []
  const store = {
    recordReturn: (id: ContextNodeId, result: ContextReturn) =>
      Effect.sync(() => void calls.push({ id: id as string, result })),
  } as unknown as ContextTreeStore["Type"]
  return { calls, store }
}

describe("finalizeRun — the ONE terminal path", () => {
  test("records + completes + emits, in that order, with the honest outcome", async () => {
    const { calls, store } = recordingStore()
    const bus = makeAgentBus()
    const events: AgentSubAgentEndEvent[] = []
    const once = Ref.unsafeMake(false)

    await Effect.runPromise(
      Effect.gen(function* () {
        // Register a parent + the child so the completion has somewhere to go.
        yield* bus.markRunning("parent", "the lead")
        yield* bus.markRunning(nodeId, "worker", { parentKey: "parent" })
        yield* finalizeRun({
          nodeId,
          label: "worker",
          store,
          bus,
          hooks: {
            onSubAgentEnd: (e) => Effect.sync(() => void events.push(e)),
          },
          once,
          outcome: {
            status: "partial",
            summary: "half done",
            filesChanged: ["a.ts"],
            reason: { kind: "budget" },
          },
        })
      }),
    )

    // 1. The durable record, with the typed reason.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.result.status).toBe("partial")
    expect(calls[0]?.result.stopReason).toEqual({ kind: "budget" })
    // 2. The bus completion reached the parent's inbox with the honest verb.
    const inbox = await Effect.runPromise(bus.drain("parent"))
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.content).toContain("finished (partial — stopped early)")
    // 3. The terminal event fired with outcome + reason (and legacy ok=true —
    //    a partial is still a usable deliverable).
    expect(events).toHaveLength(1)
    expect(events[0]?.outcome).toBe("partial")
    expect(events[0]?.reason).toBe("budget")
    expect(events[0]?.ok).toBe(true)
  })

  test("double finalize is a no-op: the FIRST outcome wins, no second record/event", async () => {
    const { calls, store } = recordingStore()
    const bus = makeAgentBus()
    const events: AgentSubAgentEndEvent[] = []
    const once = Ref.unsafeMake(false)
    const base = {
      nodeId,
      label: "worker",
      store,
      bus,
      hooks: {
        onSubAgentEnd: (e: AgentSubAgentEndEvent) => Effect.sync(() => void events.push(e)),
      },
      once,
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* bus.markRunning(nodeId, "worker")
        yield* finalizeRun({
          ...base,
          outcome: {
            status: "ok",
            summary: "done",
            filesChanged: [],
            reason: { kind: "completed" },
          },
        })
        // The exit finalizer races in with a would-be kill — must no-op.
        yield* finalizeRun({
          ...base,
          outcome: {
            status: "killed",
            summary: "[interrupted]",
            filesChanged: [],
            reason: { kind: "interrupt", by: "shutdown" },
          },
        })
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.result.status).toBe("ok")
    expect(events).toHaveLength(1)
    expect(events[0]?.outcome).toBe("ok")
  })

  test("is infallible: a throwing store/hook never breaks the finalize", async () => {
    const bus = makeAgentBus()
    const once = Ref.unsafeMake(false)
    const dyingStore = {
      recordReturn: () => Effect.die("store exploded"),
    } as unknown as ContextTreeStore["Type"]

    // Must complete without failing — teardown can never throw.
    const r = await Effect.runPromise(
      Effect.gen(function* () {
        yield* bus.markRunning("parent", "the lead")
        yield* bus.markRunning(nodeId, "worker", { parentKey: "parent" })
        yield* finalizeRun({
          nodeId,
          label: "worker",
          store: dyingStore,
          bus,
          hooks: {
            onSubAgentEnd: () =>
              Effect.die("hook exploded") as Effect.Effect<void, never, never>,
          },
          once,
          outcome: {
            status: "error",
            summary: "boom",
            filesChanged: [],
            reason: { kind: "error", error: "Boom" },
          },
        })
        // The bus completion still happened despite the dying store/hook:
        // the run is off the bus and the parent got the failure line.
        const running = yield* bus.isRunning(nodeId)
        const inbox = yield* bus.drain("parent")
        return { running, inbox }
      }),
    )
    expect(r.running).toBe(false)
    expect(r.inbox).toHaveLength(1)
    expect(r.inbox[0]?.content).toContain("boom")
  })

  test("notes ride the summary into record, inbox, and event", async () => {
    const { calls, store } = recordingStore()
    const bus = makeAgentBus()
    const events: AgentSubAgentEndEvent[] = []
    const once = Ref.unsafeMake(false)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* bus.markRunning(nodeId, "worker")
        yield* finalizeRun({
          nodeId,
          label: "worker",
          store,
          bus,
          hooks: { onSubAgentEnd: (e) => Effect.sync(() => void events.push(e)) },
          once,
          outcome: {
            status: "ok",
            summary: "done",
            filesChanged: [],
            reason: { kind: "completed" },
            notes: ["[failover: kimi → glm after quota]"],
          },
        })
      }),
    )
    expect(calls[0]?.result.summary).toContain("[failover: kimi → glm after quota]")
    expect(events[0]?.summary).toContain("[failover: kimi → glm after quota]")
  })
})
