import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Option, Ref, References, Scheduler, Schema, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import type { Response } from "effect/ai"
import { ConversationId, ConversationMemory, CurrentAgentRun, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, harnessCodeOf, HarnessError, openLogSession, RunId, RunOrdinal, SessionLogMemoryLive, Sessions, ToolRegistry, TurnAdmissionOpen, TurnMemory, TurnToolbox, UserMessage } from "@xandreed/core"
import type { Capability, MemoryPolicy, RunTools } from "@xandreed/core"
import { makeRegistry, toolDiscoveryDefaults, toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { DiscoveryConfig } from "@xandreed/plugin-tool-discovery"
import { TurnLive } from "./turn/turn.adapter.js"
import { recordingTurnWriter } from "./turn/testing.js"
import { Agent } from "./agent.adapter.js"

const memoryPolicy: MemoryPolicy = {
  strategy: { id: "policy-test", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
}
const tool = (name: string) => Tool.make(name, { description: "Exercise tool execution policy.", parameters: Schema.Struct({ n: Schema.Int }), success: Schema.String, failure: Failure, failureMode: "return" })
const A = tool("policy_a")
const B = tool("policy_b")
const W = tool("policy_write")
const capability = (tools: Capability["tools"]) => defineCapability({ id: "policy", version: "1", tools, skills: [defineSkill({ id: "policy", summary: "Exercise policy.", tools: tools.map((entry) => entry.tool.name), always: true })] })
type Registry = Effect.Success<ReturnType<typeof makeRegistry>>

const opened = (registry: Registry, id: string) => Effect.gen(function* () {
  const recorded = yield* recordingTurnWriter({ runId: RunId.make(id), text: "exercise policy" })
  const context = yield* Layer.build(TurnLive({ turn: recorded.writer }).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: memoryPolicy.strategy, open: ({ log, runId }) => openLogSession(log, memoryPolicy, { runId }) })),
    Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: registry.catalog, open: registry.open })),
  ))))
  const tools = yield* Effect.gen(function* () {
    yield* (yield* TurnMemory).persistMessage
    const tools = yield* (yield* TurnToolbox).open
    yield* tools.select(recorded.writer.admitted.userMessage)
    return tools
  }).pipe(Effect.provide(context))
  const call = (name: string, n: number, ordinal = 0) => invoke(tools, name, n).pipe(Effect.provideService(CurrentAgentRun, Option.some({ id: RunId.make(id), turn: 1, ordinal: RunOrdinal.make(ordinal) })))
  return { call, tools, stored: Ref.get(recorded.stored) }
})
const invoke = (tools: RunTools, name: string, n: number): Effect.Effect<{ readonly isFailure: boolean; readonly result: unknown }, unknown> => Effect.gen(function* () {
  const toolkit = yield* tools.toolkit.pipe(Effect.provide(tools.handlers))
  const all = yield* Stream.runCollect(yield* toolkit.handle(name, { n }, `call-${n}`))
  const last = all.at(-1)!
  return { isFailure: last.isFailure, result: last.result }
}) as Effect.Effect<{ readonly isFailure: boolean; readonly result: unknown }, unknown>

const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Logger.layer([])), Effect.timeout("3 seconds")))
const registryOf = (tools: Capability["tools"], options: Partial<DiscoveryConfig> = {}) => makeRegistry({ ...toolDiscoveryDefaults, ...options }, [capability(tools)])
const yields = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { concurrency: 1 })

describe("tool policy over real turn services", () => {
  test("tools opened under an outer run do not capture its dynamic identity for later direct calls", () => run(Effect.gen(function* () {
    const registry = yield* registryOf([defineTool({ tool: A, handler: () => Effect.service(CurrentAgentRun).pipe(Effect.map((run) => Option.match(run, { onNone: () => "direct", onSome: (current) => `run ${current.ordinal}` }))) })], { toolPolicy: { [A.name]: { maxCallsPerRun: 1 } } })
    const turn = yield* opened(registry, "captured").pipe(Effect.provideService(CurrentAgentRun, Option.some({ id: RunId.make("outer"), turn: 7, ordinal: RunOrdinal.make(9) })))
    expect((yield* invoke(turn.tools, A.name, 1)).result).toBe("direct")
    expect((yield* turn.call(A.name, 2, 9)).result).toBe("run 9")
    expect((yield* invoke(turn.tools, A.name, 3)).result).toEqual({ error: "ToolCallLimit", message: "This tool may be called at most once per run; use what its earlier calls returned" })
  })))
  test("a synchronously throwing handler is captured under execution policy and trips its breaker", () => run(Effect.gen(function* () {
    const registry = yield* registryOf([defineTool({ tool: A, handler: () => Option.getOrThrowWith(Option.none<Effect.Effect<string>>(), () => new Error("synchronous defect")) })], { toolPolicy: { [A.name]: { breakAfter: 1 } } })
    const turn = yield* opened(registry, "sync-defect")
    expect((yield* turn.call(A.name, 1)).result).toEqual({ error: "ToolDefect", message: "policy_a failed unexpectedly: synchronous defect" })
    expect((yield* turn.call(A.name, 2)).result).toEqual({ error: "ToolTripped", message: "This tool has reached its failure limit for this run; use another tool or report what blocked the task" })
    expect((yield* turn.stored).filter((event) => event.kind === "tool.completed")).toHaveLength(1)
  })))
  test.each(["constructor", "toString", "__proto__"])("registered prototype-like tool names retain numeric budgets and breakers: %s", (name) => run(Effect.gen(function* () {
    const special = tool(name)
    const registry = yield* registryOf([defineTool({ tool: special, handler: ({ n }) => n === 0 ? Effect.die(new Error("broken")) : Effect.succeed("ok") })], { toolPolicy: Object.fromEntries([[name, { maxCallsPerRun: 2, breakAfter: 1 }]]) })
    const turn = yield* opened(registry, `special-${name}`)
    expect((yield* turn.call(name, 1)).result).toBe("ok")
    expect((yield* turn.call(name, 2)).result).toBe("ok")
    expect((yield* turn.call(name, 3)).result).toEqual({ error: "ToolCallLimit", message: "This tool may be called at most 2 times per run; use what its earlier calls returned" })
    yield* turn.call(name, 0, 1)
    expect((yield* turn.call(name, 1, 1)).result).toEqual({ error: "ToolTripped", message: "This tool has reached its failure limit for this run; use another tool or report what blocked the task" })
  })))
  test("Agent runs have separate atomic host budgets while the provider sees each exact result", () => run(Effect.gen(function* () {
    const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.mergeAll(SessionLogMemoryLive, TurnAdmissionOpen))))
    const sessions = Context.get(context, Sessions)
    const address = { owner: "policy-journey", id: ConversationId.make("00000000-0000-4000-8000-000000000025") }
    yield* sessions.create(address)
    const handled = yield* Ref.make<ReadonlyArray<number>>([])
    const host = capability([defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => Effect.service(CurrentAgentRun).pipe(
      Effect.flatMap((run) => Ref.update(handled, (all) => [...all, Option.match(run, { onNone: () => -1, onSome: (current) => current.ordinal })])), Effect.as(`value ${n}`),
    ) })])
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
    const batch = (offset: number): ReadonlyArray<Response.PartEncoded> => [
      ...[1, 2].map((n) => ({ type: "tool-call" as const, id: `call-${offset}-${n}`, name: A.name, params: { n: offset + n }, providerExecuted: false })),
      { type: "finish", reason: "tool-calls", usage },
    ]
    const done: ReadonlyArray<Response.PartEncoded> = [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage }]
    const script = [batch(0), done, batch(2), done]
    const model = yield* LanguageModel.make({
      generateText: (options) => Ref.modify(requests, (all) => [all.length, [...all, JSON.stringify(options.prompt.content)]] as const).pipe(Effect.map((index) => [...(script[index] ?? done)])),
      streamText: () => Stream.die("not scripted"),
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, { plugin: toolDiscoveryPlugin, options: { toolPolicy: { [A.name]: { maxCallsPerRun: 1 } } } }, stepLoopPlugin], capabilities: [host], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 4, toolConcurrency: 2 } })
    const outcome = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "run two independent batches" }), runId: RunId.make("policy-agent") }, services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, model)) }, (turn) => Effect.gen(function* () {
      yield* turn.tools.select(turn.userMessage)
      const first = yield* turn.run({})
      const second = yield* turn.run({})
      expect([first.outcome, second.outcome]).toEqual(["completed", "completed"])
      return { outcome: "completed", reply: Option.some(second.text) } as const
    }))
    expect(outcome.outcome).toBe("completed")
    expect(yield* Ref.get(handled)).toEqual([0, 1])
    const prompts = yield* Ref.get(requests)
    expect(prompts).toHaveLength(4)
    expect(prompts[1]).toContain("value 1")
    expect(prompts[1]).toContain("This tool may be called at most once per run; use what its earlier calls returned")
    expect(prompts[3]).toContain("value 3")
    const records = yield* sessions.read(address)
    expect(records.filter((event) => event.kind === "tool.refused").map((event) => event.data.reason)).toEqual(["run-call-limit", "run-call-limit"])
    expect((yield* entriesOfEvents(records)).flatMap((entry) => entry.body._tag === "ToolResult" ? [Number(entry.body.run)] : [])).toEqual([0, 0, 1, 1])
  })))
  test("per-tool permits span turns, are released on interruption, and do not block a different tool", () => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const active = yield* Ref.make(0)
    const peak = yield* Ref.make(0)
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => Effect.acquireUseRelease(Ref.updateAndGet(active, (x) => x + 1).pipe(Effect.tap((x) => Ref.update(peak, (held) => Math.max(held, x)))), () => n === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : Effect.succeed("a"), () => Ref.update(active, (x) => x - 1)) }),
      defineTool({ tool: B, annotations: { readOnly: true }, handler: () => Effect.succeed("b") }),
    ], { toolPolicy: { [A.name]: { concurrency: 1 } } })
    const first = yield* opened(registry, "first")
    const second = yield* opened(registry, "second")
    const held = yield* first.call(A.name, 1).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const waiting = yield* second.call(A.name, 2).pipe(Effect.forkChild)
    yield* yields
    expect(yield* Ref.get(active)).toBe(1)
    expect((yield* second.call(B.name, 3)).result).toBe("b")
    yield* Fiber.interrupt(held)
    expect((yield* Fiber.join(waiting)).result).toBe("a")
    expect(yield* Ref.get(peak)).toBe(1)
    expect(yield* Ref.get(active)).toBe(0)
  })))

  test.each(["tool", "writer", "reader"] as const)("a queued %s permit wait is interruptible while its holder stays active", (kind) => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const handler = ({ n }: { readonly n: number }) => n === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("held")) : Effect.succeed("next")
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler }),
      defineTool({ tool: W, handler }),
    ], kind === "tool" ? { toolPolicy: { [A.name]: { concurrency: 1 } } } : {})
    const turn = yield* opened(registry, `cancel-${kind}`)
    const other = kind === "tool" ? yield* opened(registry, "other-waiter") : turn
    const holder = yield* turn.call(kind === "reader" ? W.name : A.name, 1).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const waiter = yield* other.call(kind === "writer" ? W.name : A.name, 2).pipe(Effect.forkChild)
    yield* yields
    const interrupted = yield* Ref.make(false)
    const stopping = yield* Fiber.interrupt(waiter).pipe(Effect.andThen(Ref.set(interrupted, true)), Effect.forkChild)
    yield* yields
    const beforeRelease = yield* Ref.get(interrupted)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    yield* Fiber.join(stopping)
    expect(beforeRelease).toBe(true)
    expect((yield* other.call(A.name, 3)).result).toBe("next")
  })))

  test("writers exclude readers and a waiting writer precedes later readers", () => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const order = yield* Ref.make<ReadonlyArray<string>>([])
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => Ref.update(order, (all) => [...all, `r${n}`]).pipe(Effect.andThen(n === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void), Effect.as("read")) }),
      defineTool({ tool: W, handler: () => Ref.update(order, (all) => [...all, "write"]).pipe(Effect.as("written")) }),
    ], { readConcurrency: 2 })
    const turn = yield* opened(registry, "lanes")
    const reader = yield* turn.call(A.name, 1).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const writer = yield* turn.call(W.name, 2).pipe(Effect.forkChild)
    yield* yields
    const late = yield* turn.call(A.name, 3).pipe(Effect.forkChild)
    yield* yields
    expect(yield* Ref.get(order)).toEqual(["r1"])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(reader)
    yield* Fiber.join(writer)
    yield* Fiber.join(late)
    expect(yield* Ref.get(order)).toEqual(["r1", "write", "r3"])
  })))

  test("a nested synchronous child cannot overtake a writer queued behind an earlier reader", () => run(Effect.gen(function* () {
    const holders = yield* Ref.make(0)
    const both = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const order = yield* Ref.make<ReadonlyArray<string>>([])
    const held = yield* Ref.make<Option.Option<RunTools>>(Option.none())
    const nestedResult = yield* Ref.make<Option.Option<unknown>>(Option.none())
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => n < 2 ? Ref.updateAndGet(holders, (x) => x + 1).pipe(
        Effect.flatMap((x) => x === 2 ? Deferred.succeed(both, undefined) : Effect.void), Effect.andThen(Deferred.await(release)), Effect.as("held"))
        : Ref.update(order, (all) => [...all, "nested"]).pipe(Effect.as("nested ran")) }),
      defineTool({ tool: B, annotations: { readOnly: true }, handler: () => Effect.gen(function* () {
        yield* Ref.update(order, (all) => [...all, "queued-reader"])
        const child = yield* invoke(Option.getOrThrow(yield* Ref.get(held)), A.name, 9).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")), Effect.orDie)
        yield* Ref.set(nestedResult, Option.some(child.result))
        return "read"
      }) }),
      defineTool({ tool: W, handler: () => Ref.update(order, (all) => [...all, "writer"]).pipe(Effect.as("write")) }),
    ], { readConcurrency: 2 })
    const turn = yield* opened(registry, "nested-fairness")
    yield* Ref.set(held, Option.some(turn.tools))
    const running = yield* Effect.forEach([0, 1], (n) => turn.call(A.name, n), { concurrency: 2 }).pipe(Effect.forkChild)
    yield* Deferred.await(both)
    const reader = yield* turn.call(B.name, 2).pipe(Effect.forkChild)
    yield* yields
    const writer = yield* turn.call(W.name, 3).pipe(Effect.forkChild)
    yield* yields
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    yield* Fiber.join(reader)
    yield* Fiber.join(writer)
    expect(yield* Ref.get(order)).toEqual(["queued-reader", "writer"])
    expect(yield* Ref.get(nestedResult)).toEqual(Option.some({ error: "ToolConcurrency", message: "This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again" }))
  })))

  test("cancelling a queued writer clears its priority before the reader makes a nested call", () => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const held = yield* Ref.make<Option.Option<RunTools>>(Option.none())
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => n === 1 ? Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)), Effect.andThen(Ref.get(held)), Effect.flatMap((tools) => invoke(Option.getOrThrow(tools), A.name, 9)), Effect.map((result) => String(result.result)), Effect.orDie,
      ) : Effect.succeed("nested okay") }),
      defineTool({ tool: W, handler: () => Effect.succeed("unexpected") }),
    ], { readConcurrency: 2 })
    const turn = yield* opened(registry, "cancel-writer-priority")
    yield* Ref.set(held, Option.some(turn.tools))
    const reader = yield* turn.call(A.name, 1).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const writer = yield* turn.call(W.name, 2).pipe(Effect.forkChild)
    yield* yields
    yield* Fiber.interrupt(writer)
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(reader)).result).toBe("nested okay")
  })))

  test("nested self calls and read-to-write upgrades refuse across Toolkit child fibers without deadlock", () => run(Effect.gen(function* () {
    const held = yield* Ref.make<Option.Option<RunTools>>(Option.none())
    const nested = (name: string) => Ref.get(held).pipe(Effect.flatMap((tools) => invoke(Option.getOrThrow(tools), name, 9)), Effect.map((result) => JSON.stringify(result.result)), Effect.orDie)
    const registry = yield* registryOf([
      defineTool({ tool: A, annotations: { readOnly: true }, handler: () => nested(A.name) }),
      defineTool({ tool: B, annotations: { readOnly: true }, handler: () => nested(W.name) }),
      defineTool({ tool: W, handler: ({ n }) => n === 3 ? nested(B.name) : Effect.succeed("unexpected") }),
    ], { toolPolicy: { [A.name]: { concurrency: 1 } } })
    const turn = yield* opened(registry, "nested")
    yield* Ref.set(held, Option.some(turn.tools))
    const self = yield* turn.call(A.name, 1)
    const upgrade = yield* turn.call(B.name, 2)
    const writeRead = yield* turn.call(W.name, 3)
    expect(self.result).toBe(JSON.stringify({ error: "ToolConcurrency", message: "This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again" }))
    expect(upgrade.result).toBe(JSON.stringify({ error: "ToolConcurrency", message: "This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again" }))
    expect(writeRead.result).toBe(JSON.stringify({ error: "ToolConcurrency", message: "This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again" }))
    const refused = (yield* turn.stored).filter((event) => event.kind === "tool.refused")
    expect(refused.map((event) => event.data.reason)).toEqual(["concurrency", "concurrency", "concurrency"])
    expect(refused.map((event) => event.data.toolCallId)).toEqual(["call-9", "call-9", "call-9"])
  })))

  test("queued calls recheck a breaker after taking permits and preserve the refusal's identity", () => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const registry = yield* registryOf([defineTool({ tool: A, annotations: { readOnly: true }, handler: () => Ref.update(calls, (x) => x + 1).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.die(new Error("broken")))) })], { toolPolicy: { [A.name]: { concurrency: 1, breakAfter: 1 } } })
    const turn = yield* opened(registry, "queued-breaker")
    const first = yield* turn.call(A.name, 1).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const next = yield* turn.call(A.name, 2).pipe(Effect.forkChild)
    yield* yields
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    expect((yield* Fiber.join(next)).result).toEqual({ error: "ToolTripped", message: "This tool has reached its failure limit for this run; use another tool or report what blocked the task" })
    expect(yield* Ref.get(calls)).toBe(1)
    const stored = yield* turn.stored
    expect(stored.filter((event) => event.kind === "tool.completed")).toHaveLength(1)
    expect(stored.filter((event) => event.kind === "tool.refused").map((event) => [event.data.reason, event.data.toolCallId])).toEqual([["tripped", "call-2"]])
  })))

  test("cancellation after an actual defect cannot skip its breaker settlement", () => run(Effect.gen(function* () {
    const parent = new Map<string, () => void>()
    const calls = yield* Ref.make(0)
    const registry = yield* registryOf([defineTool({ tool: A, annotations: { readOnly: true }, handler: ({ n }) => Ref.update(calls, (x) => x + 1).pipe(
      Effect.andThen(n === 54 ? Effect.withFiber(() => {
        queueMicrotask(() => parent.get("interrupt")?.())
        return Effect.die(new Error("actual defect"))
      }) : Effect.succeed("later")),
    ) })], { toolPolicy: { [A.name]: { concurrency: 1, breakAfter: 1 } } })
    const turn = yield* opened(registry, "settlement-cancel")
    const first = yield* Effect.withFiber((fiber) => {
      parent.set("interrupt", () => fiber.interruptUnsafe())
      return turn.call(A.name, 54, 27)
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 27), Effect.forkChild)
    yield* Fiber.await(first)
    expect((yield* turn.call(A.name, 55, 27)).result).toEqual({ error: "ToolTripped", message: "This tool has reached its failure limit for this run; use another tool or report what blocked the task" })
    expect(yield* Ref.get(calls)).toBe(1)
  })))

  test("turn errors and cancellation do not trip a handler breaker", () => run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const registry = yield* registryOf([defineTool({ tool: A, handler: ({ n }) => n === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : n === 1 ? Effect.die(new HarnessError({ code: "store.unavailable", message: "store stopped" })) : Effect.succeed("ok") })], { toolPolicy: { [A.name]: { breakAfter: 1, breakOn: "failures" } } })
    const turn = yield* opened(registry, "unrelated")
    const cancelled = yield* turn.call(A.name, 0).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(cancelled)
    expect((yield* turn.call(A.name, 2)).result).toBe("ok")
    const failed = yield* Effect.exit(turn.call(A.name, 1))
    expect(failed._tag).toBe("Failure")
    expect((yield* turn.call(A.name, 2)).result).toBe("ok")
  })))

  test("unknown policy names and invalid limits fail before any turn opens", () => run(Effect.gen(function* () {
    const unknown = yield* Effect.result(registryOf([], { toolPolicy: { missing: { concurrency: 1 } } }))
    expect(unknown._tag === "Failure" && Option.getOrElse(harnessCodeOf(unknown.failure), () => "none")).toBe("config.options")
    const invalid = yield* Effect.result(registryOf([defineTool({ tool: A, handler: () => Effect.succeed("ok") })], { toolPolicy: { [A.name]: { concurrency: 0 } } }))
    expect(invalid._tag === "Failure" && Option.getOrElse(harnessCodeOf(invalid.failure), () => "none")).toBe("config.options")
  })))
})
