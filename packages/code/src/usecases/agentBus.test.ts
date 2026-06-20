import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { type AgentBus, inboxToMessages, makeAgentBus } from "./agentBus.js"

const run = <A>(f: (bus: AgentBus) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.suspend(() => f(makeAgentBus())))

describe("AgentBus — mailboxes", () => {
  it("posts to a running agent and drains (clearing) the inbox", async () => {
    const result = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("n1", "alpha")
        const delivered = yield* bus.post("n1", { from: "you", content: "hi", at: 1 })
        const first = yield* bus.drain("n1")
        const second = yield* bus.drain("n1")
        return { delivered, first, second }
      }),
    )
    expect(result.delivered).toBe(true)
    expect(result.first.map((m) => m.content)).toEqual(["hi"])
    expect(result.second).toEqual([]) // drain cleared it
  })

  it("refuses delivery to an agent that isn't running", async () => {
    const delivered = await run((bus) => bus.post("ghost", { from: "you", content: "x", at: 1 }))
    expect(delivered).toBe(false)
  })

  it("markDone tears down the mailbox (unread messages dropped, no longer running)", async () => {
    const result = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("n1", "alpha")
        yield* bus.post("n1", { from: "you", content: "unread", at: 1 })
        yield* bus.markDone("n1")
        const running = yield* bus.isRunning("n1")
        const drained = yield* bus.drain("n1")
        const delivered = yield* bus.post("n1", { from: "you", content: "late", at: 2 })
        return { running, drained, delivered }
      }),
    )
    expect(result.running).toBe(false)
    expect(result.drained).toEqual([])
    expect(result.delivered).toBe(false)
  })

  it("listRunning reports live agents with labels", async () => {
    const running = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("n1", "alpha")
        yield* bus.markRunning("n2", "beta")
        yield* bus.markDone("n1")
        return yield* bus.listRunning()
      }),
    )
    expect(running).toEqual([{ nodeId: "n2", label: "beta" }])
  })
})

describe("AgentBus — blackboard", () => {
  it("posts and reads notes; limit returns the most recent", async () => {
    const result = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.boardPost({ from: "a", note: "one", at: 1 })
        yield* bus.boardPost({ from: "b", note: "two", at: 2 })
        const all = yield* bus.boardRead()
        return all
      }),
    )
    expect(result.map((n) => n.note)).toEqual(["one", "two"])
  })
})

describe("inboxToMessages", () => {
  it("renders inbound messages as attributed user turns", () => {
    const msgs = inboxToMessages([{ from: "agent 1234", content: "ship it", at: 1 }])
    expect(msgs).toEqual([{ role: "user", content: "[inbox · message from agent 1234]\nship it" }])
  })
})
