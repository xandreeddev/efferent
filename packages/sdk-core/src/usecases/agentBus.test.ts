import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LanguageModel, Toolkit } from "@effect/ai"
import { runAgentLoop } from "./agentLoop.js"
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

describe("AgentBus — supervision (the async fleet)", () => {
  it("complete records the result, posts to the parent inbox + board, ends the run", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        yield* bus.markRunning("c", "child", { parentKey: "p" })
        yield* bus.complete("c", { status: "ok", summary: "did it", filesChanged: ["a.ts"] })
        const snap = yield* bus.snapshot(["c"])
        const parentInbox = yield* bus.drain("p")
        const board = yield* bus.boardRead()
        const running = yield* bus.isRunning("c")
        return { snap, parentInbox, board, running }
      }),
    )
    expect(r.snap).toEqual([
      { nodeId: "c", label: "child", status: "ok", summary: "did it", filesChanged: ["a.ts"] },
    ])
    expect(r.parentInbox).toHaveLength(1)
    expect(r.parentInbox[0]?.content).toContain("did it")
    expect(r.board).toHaveLength(1)
    expect(r.running).toBe(false)
  })

  it("buffers a completion for an IDLE parent and delivers it when the parent next runs (the auto-resume ping-back)", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        // The parent ran, spawned a child, then ENDED its turn — its mailbox is
        // torn down (the "delegate then report back" pattern).
        yield* bus.markRunning("p", "parent")
        yield* bus.markRunning("c", "child", { parentKey: "p" })
        yield* bus.markDone("p")
        // The child finishes while the parent is idle.
        yield* bus.complete("c", { status: "ok", summary: "found the answer", filesChanged: [] })
        const whileIdle = yield* bus.drain("p") // no live mailbox → nothing yet
        // The daemon's onTopLevelDone auto-resume re-registers the parent's mailbox.
        yield* bus.markRunning("p", "parent")
        const afterResume = yield* bus.drain("p")
        return { whileIdle, afterResume }
      }),
    )
    expect(r.whileIdle).toEqual([]) // an idle parent has no mailbox to read
    // …but the completion was buffered and surfaces on the resume — without this
    // the auto-resumed orchestrator drains nothing and reports no fleet results.
    expect(r.afterResume).toHaveLength(1)
    expect(r.afterResume[0]?.content).toContain("found the answer")
  })

  it("complete is a no-op for an UNKNOWN node — so the stranded-node sweeper must re-register first", async () => {
    // The mid-session sweeper finds a node the bus no longer knows (its fiber
    // wedged, taking its mailbox with it). `complete` alone wouldn't notify the
    // parent — it returns early with no running entry — which is WHY the sweeper
    // does markRunning(parentKey) THEN complete, reusing the normal delivery path.
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        // No prior markRunning("stalled") → complete finds nothing to deliver.
        yield* bus.complete("stalled", { status: "error", summary: "lost", filesChanged: [] })
        const inboxWithoutRegister = yield* bus.drain("p")
        // The sweeper's actual sequence: register the absent node under its
        // parent, THEN complete — now the failure reaches the parent's inbox.
        yield* bus.markRunning("stalled", "worker", { parentKey: "p" })
        yield* bus.complete("stalled", {
          status: "error",
          summary: "[stalled — no longer running]",
          filesChanged: [],
        })
        const inboxAfterRegister = yield* bus.drain("p")
        return { inboxWithoutRegister, inboxAfterRegister }
      }),
    )
    expect(r.inboxWithoutRegister).toEqual([]) // complete on an unknown node delivered nothing
    expect(r.inboxAfterRegister).toHaveLength(1)
    expect(r.inboxAfterRegister[0]?.content).toContain("stalled — no longer running")
  })

  it("childrenOf includes both running and finished children of a parent", async () => {
    const ids = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        yield* bus.markRunning("c1", "one", { parentKey: "p" })
        yield* bus.markRunning("c2", "two", { parentKey: "p" })
        yield* bus.complete("c1", { status: "ok", summary: "s", filesChanged: [] })
        return yield* bus.childrenOf("p")
      }),
    )
    expect([...ids].sort()).toEqual(["c1", "c2"])
  })

  it("awaitChange returns immediately when a watched agent is already finished", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        yield* bus.markRunning("c", "child", { parentKey: "p" })
        yield* bus.complete("c", { status: "ok", summary: "s", filesChanged: [] })
        return yield* bus
          .awaitChange({ waiterKey: "p", watch: ["c"], timeoutMs: 60_000 })
          .pipe(
            Effect.timeoutTo({
              duration: "2 seconds",
              onTimeout: () => "HUNG",
              onSuccess: () => "returned",
            }),
          )
      }),
    )
    expect(r).toBe("returned")
  })

  it("awaitChange wakes when a message lands in the waiter's inbox (never sleeps it out)", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        yield* Effect.forkDaemon(
          Effect.sleep("20 millis").pipe(
            Effect.zipRight(bus.post("p", { from: "you", content: "status?", at: 1 })),
          ),
        )
        return yield* bus
          .awaitChange({ waiterKey: "p", watch: [], timeoutMs: 60_000 })
          .pipe(
            Effect.timeoutTo({
              duration: "2 seconds",
              onTimeout: () => "HUNG",
              onSuccess: () => "woke",
            }),
          )
      }),
    )
    expect(r).toBe("woke")
  })

  it("awaitChange returns at the timeout when nothing happens", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("p", "parent")
        return yield* bus
          .awaitChange({ waiterKey: "p", watch: [], timeoutMs: 30 })
          .pipe(
            Effect.timeoutTo({
              duration: "2 seconds",
              onTimeout: () => "HUNG",
              onSuccess: () => "timedout",
            }),
          )
      }),
    )
    expect(r).toBe("timedout")
  })

  it("interruptAll interrupts every registered fiber (no orphans on teardown)", async () => {
    const interrupted = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("n", "x")
        const fiber = yield* Effect.forkDaemon(Effect.never)
        yield* bus.setFiber("n", fiber)
        yield* bus.interruptAll()
        const exit = yield* Fiber.await(fiber)
        return Exit.isInterrupted(exit)
      }),
    )
    expect(interrupted).toBe(true)
  })

  it("markRunning is idempotent: a re-register keeps the original completion latch", async () => {
    const r = await run((bus) =>
      Effect.gen(function* () {
        yield* bus.markRunning("c", "child", { parentKey: "p" })
        // A parent grabs the completion via awaitChange in the background…
        const waiter = yield* Effect.forkDaemon(
          bus.awaitChange({ waiterKey: "p", watch: ["c"], timeoutMs: 60_000 }),
        )
        yield* Effect.sleep("10 millis")
        // …then runSpawnedAgent re-affirms the registration (no parentKey arg).
        yield* bus.markRunning("c", "child")
        yield* bus.complete("c", { status: "ok", summary: "s", filesChanged: [] })
        const exit = yield* Fiber.await(waiter).pipe(
          Effect.timeoutTo({ duration: "2 seconds", onTimeout: () => "HUNG", onSuccess: () => "woke" }),
        )
        const children = yield* bus.childrenOf("p")
        return { exit, children: [...children] }
      }),
    )
    expect(r.exit).toBe("woke") // re-register didn't replace the latch the waiter holds
    expect(r.children).toEqual(["c"]) // parentKey survived the re-register
  })
})

describe("AgentBus — delivery into the loop (the inbox protocol, end to end)", () => {
  it("folds a queued mailbox message into the agent's context at the next turn boundary", async () => {
    const bus = makeAgentBus()
    let sawInbox = false
    // A fake model that records what it was actually prompted with — proof the
    // loop fed the inbox message into the context, not just that the bus held it.
    const recordingModel = Layer.succeed(
      LanguageModel.LanguageModel,
      LanguageModel.LanguageModel.of({
        generateText: ({ prompt }: { prompt: unknown }) =>
          Effect.sync(() => {
            const text = JSON.stringify(prompt)
            if (text.includes("inbox · message from backend") && text.includes("use the new API")) {
              sawInbox = true
            }
            return { content: [], text: "ack", finishReason: "stop", usage: undefined }
          }),
        generateObject: () => Effect.die("unused"),
        streamText: () => Effect.die("unused"),
      } as never),
    )

    const program = Effect.gen(function* () {
      // The agent is running with an open mailbox; a sibling posts to it before
      // the turn — exactly the steering path (human or agent → running agent).
      yield* bus.markRunning("worker", "worker")
      yield* bus.post("worker", { from: "backend", content: "use the new API", at: 1 })
      yield* runAgentLoop({
        system: "you are a worker",
        messages: [{ role: "user", content: "do the task" }],
        toolkit: Toolkit.make(),
        maxSteps: 1,
        // The SAME drain hook the root and every sub-agent install.
        hooks: {
          onTransformContext: (messages) =>
            Effect.gen(function* () {
              const inbox = yield* bus.drain("worker")
              return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
            }),
        },
      })
    }).pipe(Effect.provide(recordingModel))

    await Effect.runPromise(program as Effect.Effect<unknown>)
    // The model was prompted WITH the inbox message folded into context…
    expect(sawInbox).toBe(true)
    // …and the mailbox is now empty — drain cleared it, so it's single delivery.
    const remaining = await Effect.runPromise(bus.drain("worker"))
    expect(remaining).toEqual([])
  })
})

describe("inboxToMessages", () => {
  it("renders inbound messages as attributed user turns", () => {
    const msgs = inboxToMessages([{ from: "agent 1234", content: "ship it", at: 1 }])
    expect(msgs).toEqual([{ role: "user", content: "[inbox · message from agent 1234]\nship it" }])
  })
})
