import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Option, Ref, References, Schema, Scope, Stream } from "effect"
import {
  ConversationId,
  CurrentPromptCacheKey,
  describeModel,
  DecisionRecord,
  defineCapability,
  defineHostEvent,
  definePlugin,
  defineSkill,
  defineTool,
  Failure,
  HarnessError,
  IntentMatcher,
  Media,
  MediaFingerprint,
  mediaFromBase64,
  mediaLabel,
  onTool,
  RunContext,
  replayModelRequest,
  SessionLog,
  SessionLogError,
  SessionLogMemoryLive,
  Sessions,
  StepLoop,
  subscribeAll,
  TaskActivity,
  TaskExecutor,
  Tasks,
  TurnAdmissionOpen,
  TurnEvents,
  TurnMemory,
  tokenUsage,
  TurnTasks,
  turnUsageOf,
  UserMessage,
  UtilityCompletion,
  UtilityLlm,
  zeroUsage,
} from "@xandreed/core"
import type { LogEntry, Plugin, SessionLogEvent, Turn, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { runSteps, stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksLive, tasksDefaults } from "@xandreed/plugin-tasks"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig, AgentPluginEntry } from "./agent.adapter.js"
import { Stamp, Tally } from "./testing.port.js"

/* ── the host's definitions: thin tools with views, skills and sections ── */

const Item = Schema.Struct({ id: Schema.String, detail: Schema.String })
const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ items: Schema.Array(Item) }),
  failure: Failure,
  failureMode: "return",
})
const Deliver = Tool.make("deliver", {
  description: "Deliver the final answer.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})

const found = (items: ReadonlyArray<typeof Item.Type>) => items.map((item) => `FOUND ${item.id}: ${item.detail}`).join("\n")
const host = defineCapability({
  id: "test-host", version: "1",
  tools: [
    defineTool({
      tool: Lookup,
      handler: ({ query }) => Effect.succeed({ items: ["a", "b", "c"].map((suffix) => ({ id: `record-${query}-${suffix}`, detail: `${query} ${suffix} `.repeat(20) })) }),
      view: {
        version: "1",
        render: (result) => found(result.items),
        compact: (result) => `(earlier lookup found ${result.items.map((item) => item.id).join(", ")})`,
        subjects: (result) => result.items.map((item) => ({ kind: "record", id: item.id, label: Option.none(), data: Option.none() })),
        digest: {
          _tag: "Select", version: "1", instructions: "Keep the records the request needs.",
          items: (result) => result.items.map((item) => ({ key: item.id, text: item.detail })),
          render: (result, _params, keep) => found(result.items.filter((item) => keep.includes(item.id))),
        },
      },
      annotations: { readOnly: true },
    }),
    defineTool({ tool: Deliver, handler: () => Effect.succeed(true) }),
  ],
  skills: [
    defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true }),
    defineSkill({ id: "delivery", summary: "Deliver a final answer.", instructions: "Deliver once, with the record id.", tools: ["deliver"] }),
  ],
  promptSections: [
    { id: "persona", version: "1", tier: "session", order: 0, render: () => Effect.succeed(Option.some("SESSION persona: a test agent.")) },
    { id: "rules", version: "1", tier: "static", order: 5, render: () => Effect.succeed(Option.some("STATIC rules.")) },
  ],
})

/* ── a scripted provider that records every request it receives ── */

interface Seen {
  readonly tools: ReadonlyArray<string>
  readonly prompt: string
  readonly toolChoice: unknown
  readonly cacheKey: Option.Option<string>
}
const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const cacheKey = yield* Effect.service(CurrentPromptCacheKey)
      const index = yield* Ref.modify(seen, (all): [number, ReadonlyArray<Seen>] => [all.length, [...all, {
        tools: options.tools.map((tool) => tool.name), prompt: JSON.stringify(options.prompt.content), toolChoice: options.toolChoice, cacheKey,
      }]])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { seen, model }
})

/* ── agents, sessions and turns ── */

const conversation = ConversationId.make("00000000-0000-4000-8000-000000000001")
const utilityText = (text: string) => Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })),
}))

const define = (memory: Plugin | AgentPluginEntry, extra: Partial<AgentConfig> = {}) => Agent.define({
  plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin, ...(extra.plugins ?? [])],
  capabilities: [host, ...(extra.capabilities ?? [])],
  turnServices: [LanguageModel.LanguageModel, ...(extra.turnServices ?? [])],
  limits: { streaming: false, maxSteps: 6 },
  cacheKeyPrefix: "agent",
  ...(extra.budgetTokens === undefined ? {} : { budgetTokens: extra.budgetTokens }),
})

/** One session over a session log (in memory unless given), and its stored events. */
const sessionOver = (log: Layer.Layer<SessionLog> = SessionLogMemoryLive) => Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(log, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: "test", id: conversation })
  const address = { id: conversation, owner: "test" }
  return { sessions, address, stored: sessions.read(address).pipe(Effect.orDie) }
})
type Journal = Effect.Success<ReturnType<typeof sessionOver>>
const inMemorySession = sessionOver()
const inputFor = (journal: Journal, runId: string, text: string, model: LanguageModel.LanguageModel, services: Context.Context<never> = Context.empty()) => ({
  turn: { session: journal.address, userMessage: new UserMessage({ text }), runId },
  services: Context.merge(Context.merge(Context.make(LanguageModel.LanguageModel, model), services), Context.make(Sessions, journal.sessions)),
})
const named = (events: ReadonlyArray<SessionLogEvent>, name: string) => events.filter((event) => event.kind === name)
const body = (event: SessionLogEvent | undefined) => event?.data.body as Record<string, unknown> | undefined

/** The ordinary answer: select tools, react to delivery, run until delivered. */
const answer = (policy: TurnPolicy = {}) => (turn: Turn): Effect.Effect<TurnOutcome, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const delivered = yield* Ref.make(Option.none<string>())
  yield* subscribeAll(turn.events, [onTool(Deliver, ({ input }) => Ref.set(delivered, Option.some(input.text)))])
  yield* turn.tools.select(turn.userMessage)
  const result = yield* turn.run({
    step: (step) => Effect.succeed({ context: Option.some(`step ${step.stepIndex}`), toolChoice: Option.none() }),
    completion: () => Ref.get(delivered).pipe(Effect.map((text) => ({ complete: Option.isSome(text), awaiting: [], facts: {} }))),
    limits: { requireCompletion: true },
    ...policy,
  })
  return { outcome: result.outcome, reply: Option.orElse(yield* Ref.get(delivered), () => Option.some(result.text)) }
})

/* ── a per-turn host service, built by the turn's layer against RunContext ── */

const tallyLayer = Layer.effect(Tally, Effect.gen(function* () {
  const run = yield* RunContext
  return { runId: run.runId, seen: yield* Ref.make<ReadonlyArray<string>>([]) }
}))
const tallied = (tally: typeof Tally.Service, text: string) => Ref.update(tally.seen, (all) => [...all, `${text}@${tally.runId}`])
const Note = Tool.make("note", {
  description: "Take a note.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})
const noting = defineCapability({
  id: "test-noting", version: "1",
  tools: [defineTool({ tool: Note, handler: ({ text }) => Tally.pipe(Effect.flatMap((tally) => tallied(tally, `tool:${text}`)), Effect.as(true)) })],
  skills: [defineSkill({ id: "noting", summary: "Take notes.", tools: ["note"], always: true })],
})

/** A session log whose store is slow, and stops storing at one event kind when asked to. */
const slowLog = (failOn: Option.Option<string>): Layer.Layer<SessionLog> => Layer.effect(SessionLog, Effect.gen(function* () {
  const inner = yield* SessionLog
  return SessionLog.of({
    ...inner,
    commit: (id, commit) => Effect.sleep("1 millis").pipe(Effect.andThen(commit.events.some((event) => Option.contains(failOn, event.kind))
      ? Effect.fail(new SessionLogError({ code: "store.down", message: "store unavailable" }))
      : inner.commit(id, commit))),
  })
})).pipe(Layer.provide(SessionLogMemoryLive))

const lookupThenDeliver = [call("c1", "lookup", { query: "alpha" }), call("c2", "load_skill", { skills: ["delivery"] }), call("c3", "deliver", { text: "record-alpha-a" })]

describe("Agent.turn", () => {
  test("a turn runs the loop, grows tools in activation order and journals every event", async () => {
    const { outcome, seen, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), answer())
      return { outcome, seen: yield* Ref.get(seen), events: yield* journal.stored }
    })))
    // The turn's usage is its provider calls' usage summed: 100 in and 10 out each.
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("record-alpha-a"), usage: tokenUsage({ inputTokens: 100 * seen.length, outputTokens: 10 * seen.length }), pending: 0 })
    expect(seen.map((request) => request.tools)).toEqual([
      ["load_skill", "lookup", "recall_context"],
      ["load_skill", "lookup", "recall_context"],
      ["load_skill", "lookup", "recall_context", "deliver"],
    ])
    const system = seen[0]!.prompt
    expect(system.indexOf("STATIC rules.")).toBeLessThan(system.indexOf("SESSION persona"))
    expect(system).toContain("delivery: Deliver a final answer.")
    expect(seen[2]!.prompt).toContain("FOUND record-alpha-a")
    expect(seen[2]!.prompt).toContain("Deliver once, with the record id.")
    expect(seen[2]!.prompt).toContain("step 2")
    expect(seen[2]!.prompt).not.toContain("step 1")
    expect(seen.every((request) => Option.contains(request.cacheKey, `agent:${conversation}`))).toBe(true)
    const names = events.map((event) => event.kind).filter((name) => !name.startsWith("memory."))
    expect(names[0]).toBe("turn.started")
    expect(named(events, "turn.started")[0]?.data).toMatchObject({ runId: "run-1", origin: "user", userMessage: { text: "find alpha" }, entry: "run-1:0" })
    // The user's message is stored once: the turn's start is memory's TurnStarted.
    expect(events.filter((event) => JSON.stringify(event.data).includes("find alpha")).map((event) => event.kind)).toEqual(["turn.started"])
    expect(names.at(-1)).toBe("turn.ended")
    expect(named(events, "tool.completed").map((event) => event.data.tool)).toEqual(["lookup", "load_skill", "deliver"])
    // A completed tool keeps neither its input nor its result: memory has the call and its result.
    expect(named(events, "tool.completed").every((event) => !("result" in event.data) && !("encoded" in event.data) && !("input" in event.data))).toBe(true)
    expect(named(events, "memory.tool-result").map((event) => body(event)?.toolName)).toEqual(["lookup", "load_skill", "deliver"])
    expect(named(events, "context.built")).toHaveLength(3)
    expect(named(events, "memory.skills").map((event) => body(event)?.skills)).toContainEqual(["delivery"])
    expect(events.every((event) => Option.contains(event.turn, 1))).toBe(true)
    const order = names.filter((name) => ["step.started", "tool.started", "tool.completed", "step.ended", "completion.evaluated"].includes(name))
    expect(order.slice(0, 5)).toEqual(["step.started", "tool.started", "tool.completed", "step.ended", "completion.evaluated"])
    expect(named(events, "turn.ended")).toHaveLength(1)
  })

  test("a quick reply is a recorded turn without the loop", async () => {
    const { outcome, seen, events, transcript } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([])
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("Hello there."))
      const transcript = yield* agent.turn(inputFor(journal, "run-2", "again", model), (turn) =>
        turn.memory.transcript("reference").pipe(Effect.flatMap((messages) => turn.reply(JSON.stringify(messages)))))
      return { outcome, seen: yield* Ref.get(seen), events: yield* journal.stored, transcript }
    })))
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("Hello there."), usage: zeroUsage, pending: 0 })
    expect(seen).toHaveLength(0)
    expect(named(events, "turn.reply").map(body)).toContainEqual({ outcome: "completed", reply: "Hello there." })
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["completed", "completed"])
    expect(Option.getOrElse(transcript.reply, () => "")).toContain("Hello there.")
  })

  test("a failing turn fails with its error, records its reply failed and ends failed, exactly once", async () => {
    const { exit, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const exit = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "fail", model), () => Effect.fail(new HarnessError({ code: "host.failed", message: "no" }))))
      return { exit, events: yield* journal.stored }
    })))
    expect(exit._tag === "Failure" ? exit.failure.code : "none").toBe("host.failed")
    expect(named(events, "turn.reply").map((event) => body(event)?.outcome)).toEqual(["failed"])
    // The stored end carries the error's own code and message.
    expect(named(events, "turn.ended").map((event) => [event.data.reason, event.data.failure])).toEqual([["failed", { code: "host.failed", message: "no" }]])
  })

  test("a failing subscriber's code is the one the stored turn.ended carries", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted(lookupThenDeliver)
      yield* Effect.result(agent.turn(inputFor(journal, "run-1", "find alpha", model), (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe(Option.liftPredicate((event) => event._tag === "tool.completed"), () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "broken" })))
        return yield* answer()(turn)
      })))
      return yield* journal.stored
    })))
    expect(named(events, "turn.ended").map((event) => event.data.failure)).toEqual([{ code: "reaction.failed", message: "broken" }])
  })

  test("a successful turn whose end the store refuses fails, and is not reported completed", async () => {
    const { exit, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* sessionOver(slowLog(Option.some("turn.ended")))
      const { model } = yield* scripted([])
      const exit = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("Hello there.")))
      return { exit, events: yield* journal.stored }
    })))
    expect(exit._tag === "Failure" ? exit.failure.code : "none").toBe("session.log")
    expect(named(events, "turn.reply").map((event) => body(event)?.outcome)).toEqual(["completed"])
    expect(named(events, "turn.ended")).toHaveLength(0)
  })

  test("a turn whose end the store refuses once is ended again by its scope with the same ending, not turn.unended", async () => {
    const refusingOnce = Layer.effect(SessionLog, Effect.gen(function* () {
      const inner = yield* SessionLog
      const refused = yield* Ref.make(false)
      return SessionLog.of({
        ...inner,
        commit: (id, commit) => (commit.events.some((event) => event.kind === "turn.ended") ? Ref.getAndSet(refused, true) : Effect.succeed(true)).pipe(
          Effect.flatMap((before) => before ? inner.commit(id, commit) : Effect.fail(new SessionLogError({ code: "store.busy", message: "try again" })))),
      })
    })).pipe(Layer.provide(SessionLogMemoryLive))
    const ended = (use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* sessionOver(refusingOnce)
      const { model } = yield* scripted([])
      const exit = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "hello", model), use))
      const stored = named(yield* journal.stored, "turn.ended").map((event) => [event.data.reason, event.data.failure ?? null])
      return { code: exit._tag === "Failure" ? exit.failure.code : "none", stored }
    })))
    expect(await ended(() => Effect.fail(new HarnessError({ code: "host.failed", message: "no" }))))
      .toEqual({ code: "host.failed", stored: [["failed", { code: "host.failed", message: "no" }]] })
    // The turn fails (its end was refused), and the record its scope stores says how its body ended.
    expect(await ended((turn) => turn.reply("Hello there."))).toEqual({ code: "session.log", stored: [["completed", null]] })
  })

  test("a failed turn whose end the store keeps refusing is logged with its ids, and let go of: under process ownership the next turn begins", async () => {
    const logged: Array<readonly [string, unknown, unknown]> = []
    const capture = Logger.layer([Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      logged.push([[options.message].flat().join(" "), annotations["efferent.run.id"], annotations["efferent.turn"]])
    })])
    const { codes, ended } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const refusing = yield* Ref.make(true)
      const inner = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
      const log = SessionLog.of({
        ...inner,
        commit: (id, commit) => Ref.get(refusing).pipe(Effect.flatMap((refuse) => refuse && commit.events.some((event) => event.kind === "turn.ended")
          ? Effect.fail(new SessionLogError({ code: "store.busy", message: "the store is busy" }))
          : inner.commit(id, commit))),
      })
      const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
        Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))), Sessions)
      yield* sessions.create({ owner: "test", id: conversation })
      const journal: Journal = { sessions, address: { id: conversation, owner: "test" }, stored: sessions.read({ id: conversation, owner: "test" }).pipe(Effect.orDie) }
      const agent = yield* define(memoryWindowPlugin)
      const { model } = yield* scripted([])
      const first = yield* Effect.flip(agent.turn(inputFor(journal, "run-1", "hello", model), () => Effect.fail(new HarnessError({ code: "host.failed", message: "no" }))))
      yield* Ref.set(refusing, false)
      const second = yield* agent.turn(inputFor(journal, "run-2", "again", model), (turn) => turn.reply("Hello again."))
      const ended = named(yield* journal.stored, "turn.ended").map((event) => [Option.getOrNull(event.turn), event.data.reason])
      return { codes: [first.code, second.outcome], ended }
    })).pipe(Effect.provide(capture)))
    expect(codes).toEqual(["host.failed", "completed"])
    expect(ended).toEqual([[1, "interrupted"], [2, "completed"]])
    expect(logged).toContainEqual(["the failed turn's end was not stored: session.log: the store is busy", "run-1", 1])
  })

  test("a failing subscriber fails the turn, not the tool call", async () => {
    const { exit, seen } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const exit = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "find alpha", model), (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe(Option.liftPredicate((event) => event._tag === "tool.completed"), () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "broken" })))
        return yield* answer()(turn)
      })))
      return { exit, seen: yield* Ref.get(seen) }
    })))
    expect(exit._tag === "Failure" ? exit.failure.code : "none").toBe("reaction.failed")
    expect(seen).toHaveLength(1)
  })

  test("interrupting a turn interrupts its tasks and records the failure", async () => {
    const { interrupted, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const fiber = yield* Effect.forkChild(agent.turn(inputFor(journal, "run-1", "wait", model), (turn) => Effect.gen(function* () {
        yield* turn.tasks.fork("slow", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Ref.set(interrupted, true))))
        return yield* Effect.never
      })))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return { interrupted: yield* Ref.get(interrupted), events: yield* journal.stored }
    })))
    expect(interrupted).toBe(true)
    expect(named(events, "turn.reply").map((event) => body(event)?.outcome)).toEqual(["failed"])
    expect(named(events, "turn.ended").map((event) => [event.data.reason, (event.data.failure as Record<string, unknown> | null)?.code])).toEqual([["interrupted", "turn.interrupted"]])
  })

  test("tasks are joined before the reply", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const Prepared = defineHostEvent("page.prepared", Schema.Struct({ id: Schema.String }))
      yield* agent.turn(inputFor(journal, "run-1", "prepare", model), (turn) => Effect.gen(function* () {
        yield* turn.tasks.fork("page", Effect.sleep("20 millis").pipe(Effect.andThen(Prepared.publish(turn.events, { id: "p1" }))))
        return yield* turn.reply("preparing")
      }))
      return yield* journal.stored
    })))
    const names = events.map((event) => event.kind)
    expect(names.indexOf("page.prepared")).toBeGreaterThan(-1)
    expect(names.indexOf("page.prepared")).toBeLessThan(names.indexOf("turn.reply"))
  })

  test("a subscriber's state is visible to the next step", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "deliver", { text: "x" })])
      yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), (turn) => Effect.gen(function* () {
        const known = yield* Ref.make<ReadonlyArray<string>>([])
        yield* subscribeAll(turn.events, [onTool(Lookup, ({ result }) => Ref.set(known, result.items.map((item) => item.id)))])
        yield* turn.tools.select(turn.userMessage)
        yield* turn.tools.activate(["delivery"])
        const result = yield* turn.run({
          step: () => Ref.get(known).pipe(Effect.map((ids) => ({ context: Option.some(`KNOWN [${ids.join(", ")}]`), toolChoice: Option.none() }))),
          stepContext: "system",
        })
        return { outcome: result.outcome, reply: Option.some(result.text) }
      }))
      return yield* Ref.get(seen)
    })))
    expect(seen[0]!.prompt).toContain("KNOWN []")
    expect(seen[1]!.prompt).toContain("KNOWN [record-alpha-a, record-alpha-b, record-alpha-c]")
  })

  test("a forced tool choice and a planned first batch follow the policy", async () => {
    const { seen, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([call("c1", "deliver", { text: "planned" })])
      yield* agent.turn(inputFor(journal, "run-1", "plan it", model), answer({
        initial: { calls: [{ name: "lookup", params: { query: "alpha" } }], skills: ["delivery"] },
        step: (step) => Effect.succeed({ context: Option.none(), toolChoice: step.stepIndex === 1 ? Option.some({ tool: "deliver" }) : Option.none() }),
      }))
      return { seen: yield* Ref.get(seen), events: yield* journal.stored }
    })))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.toolChoice).toEqual({ tool: "deliver" })
    expect(seen[0]!.prompt).toContain("FOUND record-alpha-a")
    expect(named(events, "step.started")[0]?.data).toMatchObject({ step: 0, planned: true })
  })

  test("the matcher from the turn's services seeds skills and records its decision", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { turnServices: [] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([call("c1", "deliver", { text: "done" })])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "keyword", version: "1",
        match: ({ userMessage }) => Effect.succeed({ skills: userMessage.text.includes("deliver") ? ["delivery"] : [], probabilities: Option.none(), abstained: false }),
      }))
      yield* agent.turn(inputFor(journal, "run-1", "please deliver", model, matcher), answer())
      return yield* journal.stored
    })))
    const decision = named(events, "decision.recorded")[0]?.data.record
    expect(decision).toMatchObject({ family: "skill-selection", selection: "delivery", applied: "delivery", validation: "accepted" })
    expect(Schema.decodeUnknownResult(DecisionRecord)(decision)._tag).toBe("Success")
  })

  test("the turn's layer is built per turn and provided to use, tools and subscriptions alike", async () => {
    const replies = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { capabilities: [noting] })
      const journal = yield* inMemorySession
      const turnWith = (runId: string) => Effect.gen(function* () {
        const { model } = yield* scripted([call("c1", "note", { text: "x" }), stop("done")])
        const outcome = yield* agent.turn({ ...inputFor(journal, runId, "take a note", model), layer: tallyLayer }, (turn) => Effect.gen(function* () {
          const tally = yield* Tally
          yield* tallied(tally, "use")
          yield* subscribeAll(turn.events, [onTool(Note, ({ input }) => Tally.pipe(Effect.flatMap((same) => tallied(same, `subscriber:${input.text}`))))])
          yield* turn.tasks.fork("tally", Tally.pipe(Effect.flatMap((same) => tallied(same, "task"))))
          yield* turn.tasks.await(["tally"])
          yield* turn.tools.select(turn.userMessage)
          yield* turn.run({})
          return { outcome: "completed" as const, reply: Option.some((yield* Ref.get(tally.seen)).join(",")) }
        }))
        return Option.getOrElse(outcome.reply, () => "")
      })
      return [yield* turnWith("run-1"), yield* turnWith("run-2")]
    })))
    expect(replies).toEqual([
      "use@run-1,task@run-1,tool:x@run-1,subscriber:x@run-1",
      "use@run-2,task@run-2,tool:x@run-2,subscriber:x@run-2",
    ])
  })

  test("matching skills writes nothing; applying the match activates and records it", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { turnServices: [] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "keyword", version: "1",
        match: ({ userMessage }) => Effect.succeed({ skills: userMessage.text.includes("deliver") ? ["delivery"] : [], probabilities: Option.none(), abstained: false }),
      }))
      const observed = yield* Ref.make({ matched: [] as ReadonlyArray<string>, recorded: false, wroteOnMatch: -1, activeBefore: [] as ReadonlyArray<string>, activeAfter: [] as ReadonlyArray<string> })
      yield* agent.turn(inputFor(journal, "run-1", "please deliver", model, matcher), (turn) => Effect.gen(function* () {
        yield* turn.flush
        const before = (yield* journal.stored).length
        const match = yield* turn.tools.match(turn.userMessage)
        yield* turn.flush
        const wroteOnMatch = (yield* journal.stored).length - before
        const activeBefore = yield* turn.tools.active
        yield* turn.tools.apply(match)
        yield* Ref.set(observed, { matched: match.skills, recorded: Option.isSome(match.record), wroteOnMatch, activeBefore, activeAfter: yield* turn.tools.active })
        return yield* turn.reply("ok")
      }))
      return { ...(yield* Ref.get(observed)), events: yield* journal.stored }
    })))
    expect(outcome.matched).toEqual(["delivery"])
    expect(outcome.recorded).toBe(true)
    expect(outcome.wroteOnMatch).toBe(0)
    expect(outcome.activeBefore).not.toContain("deliver")
    expect(outcome.activeAfter).toContain("deliver")
    expect(named(outcome.events, "decision.recorded").map((event) => event.data.record)).toEqual([
      expect.objectContaining({ family: "skill-selection", selection: "delivery", applied: "delivery", validation: "accepted" }),
    ])
  })

  test("background subscribers handle events in order and are drained before the reply", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* sessionOver(slowLog(Option.none()))
      const { model } = yield* scripted([])
      const Noted = defineHostEvent("item.noted", Schema.Struct({ n: Schema.Number }))
      const Handled = defineHostEvent("item.handled", Schema.Struct({ n: Schema.Number }))
      yield* agent.turn(inputFor(journal, "run-1", "note", model), (turn) => Effect.gen(function* () {
        yield* Noted.on((item) => Effect.sleep("3 millis").pipe(Effect.andThen(Handled.publish(turn.events, item))), { mode: "background" })(turn.events)
        yield* Effect.forEach([1, 2, 3], (n) => Noted.publish(turn.events, { n }), { discard: true })
        return yield* turn.reply("noted")
      }))
      return yield* journal.stored
    })))
    const names = events.map((event) => event.kind)
    expect(named(events, "item.handled").map((event) => event.data.n)).toEqual([1, 2, 3])
    expect(names.lastIndexOf("item.handled")).toBeLessThan(names.indexOf("turn.reply"))
    expect(names.at(-1)).toBe("turn.ended")
  })

  test("a session log that stops storing fails the turn", async () => {
    const { exit, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* sessionOver(slowLog(Option.some("tool.completed")))
      const { model } = yield* scripted(lookupThenDeliver)
      const exit = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "find alpha", model), answer()))
      return { exit, events: yield* journal.stored }
    })))
    expect(exit._tag === "Failure" ? exit.failure.code : "none").toBe("session.log")
    expect(named(events, "tool.completed")).toHaveLength(0)
    expect(named(events, "turn.reply")).toHaveLength(0)
  })

  test("swapping the memory strategy is one config entry", async () => {
    const { events, third } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define({ plugin: memorySummaryPlugin, options: { triggerRatio: 0.1, keepRatio: 0.05, cooldownTurns: 0 } }, { budgetTokens: 1_500 })
      const journal = yield* inMemorySession
      const utility = utilityText("SUMMARY of earlier turns")
      const turnWith = (runId: string, text: string, script: ReadonlyArray<Part>) => Effect.gen(function* () {
        const { seen, model } = yield* scripted(script)
        yield* agent.turn(inputFor(journal, runId, text, model, utility), answer())
        return yield* Ref.get(seen)
      })
      yield* turnWith("run-1", "find alpha", lookupThenDeliver)
      yield* turnWith("run-2", "find beta", [call("d1", "lookup", { query: "beta" }), call("d2", "load_skill", { skills: ["delivery"] }), call("d3", "deliver", { text: "record-beta-a" })])
      const third = yield* turnWith("run-3", "deliver gamma", [call("e1", "load_skill", { skills: ["delivery"] }), call("e2", "deliver", { text: "gamma" })])
      return { events: yield* journal.stored, third }
    })))
    expect(new Set(named(events, "context.built").map((event) => event.data.strategy))).toEqual(new Set(["summary"]))
    expect(third[0]!.prompt).toContain("SUMMARY of earlier turns")
  })

  test("a select digest keeps whole items, so the ids an answer cites survive", async () => {
    const { seen, entries } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define({ plugin: memoryWindowPlugin, options: { digestOnWriteChars: 1 } }, { plugins: [memoryDigestPlugin], turnServices: [UtilityLlm] })
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const captured = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const digester = utilityText("- record-alpha-b\nrecord-unknown")
      yield* agent.turn(inputFor(journal, "run-1", "which record is b?", model, digester), (turn) =>
        answer()(turn).pipe(Effect.tap(() => turn.memory.entries.pipe(Effect.flatMap((all) => Ref.set(captured, all))))))
      return { seen: yield* Ref.get(seen), entries: yield* Ref.get(captured) }
    })))
    const result = entries.find((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === "lookup")
    const digest = entries.find((entry) => entry.body._tag === "ToolDigest")
    expect(digest?.body).toMatchObject({ _tag: "ToolDigest", entry: result?.id, mode: "select", keep: ["record-alpha-b"], trigger: "write" })
    expect(seen[1]!.prompt).toContain("FOUND record-alpha-b")
    expect(seen[1]!.prompt).not.toContain("FOUND record-alpha-a")
  })

  test("runtime plugins build once across turns; session plugins build per turn", async () => {
    const counts = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const runtimeBuilds = yield* Ref.make(0)
      const sessionBuilds = yield* Ref.make(0)
      const counter = (id: string, scope: "runtime" | "session", ref: Ref.Ref<number>) => definePlugin({
        id, version: "1", scope, config: Schema.Struct({}), defaults: {}, provides: [],
        layer: () => Layer.effectDiscard(Ref.update(ref, (value) => value + 1)),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [counter("test/runtime-counter", "runtime", runtimeBuilds), counter("test/session-counter", "session", sessionBuilds)] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      yield* Effect.forEach(["run-1", "run-2", "run-3"], (runId) => agent.turn(inputFor(journal, runId, "hi", model), (turn) => turn.reply("hello")))
      return { runtime: yield* Ref.get(runtimeBuilds), session: yield* Ref.get(sessionBuilds) }
    })))
    expect(counts).toEqual({ runtime: 1, session: 3 })
  })

  test("session lifecycle plugins subscribe after TurnLive and finalize after each turn", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const plugin = definePlugin({
        id: "test/lifecycle", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext, TurnEvents], provides: [],
        layer: () => Layer.effectDiscard(Effect.gen(function* () {
          const run = yield* RunContext
          const events = yield* TurnEvents
          yield* Ref.update(seen, (all) => [...all, `open:${run.runId}`])
          yield* events.subscribe((event) => event._tag === "turn.started" ? Option.some(event) : Option.none(),
            () => Ref.update(seen, (all) => [...all, `started:${run.runId}`]))
          yield* Effect.addFinalizer(() => Ref.update(seen, (all) => [...all, `close:${run.runId}`]))
        })),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [plugin] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      yield* Effect.forEach(["run-1", "run-2"], (runId) => agent.turn(inputFor(journal, runId, "hello", model), (turn) => turn.reply("hello")))
      return yield* Ref.get(seen)
    })))
    expect(observed).toEqual(["open:run-1", "started:run-1", "close:run-1", "open:run-2", "started:run-2", "close:run-2"])
  })

  test("durable request replay uses its original memory position after later turns", async () => {
    const { seen, requests, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const described = describeModel(model, { provider: "scripted", model: "fixture-v1", settings: { temperature: 0.25 } })
      yield* agent.turn(inputFor(journal, "run-1", "find alpha", described), answer())
      yield* agent.turn(inputFor(journal, "run-2", "later", described), (turn) => turn.reply("later response"))
      const events = yield* journal.stored
      // Diagnostics are deliberately absent: reconstruction depends on protocol and memory facts.
      const retained = events.filter((event) => event.kind !== "context.built" && event.kind !== "step.usage")
      const requests = yield* Effect.forEach([0, 1, 2], (step) => replayModelRequest(retained, "run-1", step))
      return { seen: yield* Ref.get(seen), requests, events }
    })))
    expect(requests.map((request) => JSON.stringify(request.prompt.content))).toEqual(seen.map((request) => request.prompt))
    expect(requests.map((request) => request.tools.map((tool) => tool.name))).toEqual(seen.map((request) => [...request.tools]))
    expect(requests[0]?.model).toEqual(Option.some({ provider: "scripted", model: "fixture-v1", settings: { temperature: 0.25 } }))
    expect(named(events, "request.prepared")).toHaveLength(3)
    expect(requests[0]?.prompt.content.some((message) => JSON.stringify(message).includes("later response"))).toBe(false)
  })

  test.each(["system", "messages", "tools", "model", "toolChoice"] as const)("a changed %s request fails before the provider dispatch, naming it", async (changed) => {
    const { result, calls } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { seen, model } = yield* scripted([stop("should not run")])
      const original = describeModel(model, { provider: "scripted", model: "fixture-v1", settings: { temperature: 0.25 } })
      const changedModel = describeModel(model, { provider: "scripted", model: "fixture-v2", settings: { temperature: 0.75 } })
      const alteredLoop = definePlugin({
        id: "test/altered-loop", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [StepLoop],
        layer: () => Layer.succeed(StepLoop, {
          id: "altered", version: "1", run: (request) => runSteps({
            ...request,
            ...(changed === "tools" ? { tools: { ...request.tools, toolkit: Toolkit.make(...Object.values(request.tools.toolkit.tools).map((tool) =>
              tool.name === "lookup" ? tool.setParameters(Schema.Struct({ query: Schema.Int })) : tool)) } } : {}),
            plan: (info) => request.plan(info).pipe(Effect.map((plan) => ({
              ...plan,
              ...(changed === "messages" ? { messages: [{ role: "user" as const, content: "unrecorded input" }] } : {}),
              ...(changed === "model" ? { model: Option.some(changedModel) } : {}),
              ...(changed === "system" ? { system: "unrecorded system" } : {}),
              ...(changed === "toolChoice" ? { toolChoice: Option.some({ tool: "lookup" }) } : {}),
            }))),
          }),
        }),
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, alteredLoop], capabilities: [host],
        turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 1 },
      })
      const journal = yield* inMemorySession
      const result = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "find alpha", original), answer()))
      return { result, calls: (yield* Ref.get(seen)).length }
    })))
    expect(result._tag).toBe("Failure")
    expect(result._tag === "Failure" ? [result.failure.code, result.failure.message.split(":")[0]] : "success").toEqual(["request.diverged", changed])
    expect(calls).toBe(0)
  })

  test("a dispatch check reads from storage only the turn's events, each once", async () => {
    const { reads, started, stored } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<{ readonly after: number; readonly count: number }>>([])
      const counted = Layer.effect(SessionLog, Effect.gen(function* () {
        const inner = yield* SessionLog
        return SessionLog.of({
          ...inner,
          read: (id, query) => inner.read(id, query).pipe(Effect.tap((events) => query.kinds.includes("request.prepared")
            ? Ref.update(reads, (all) => [...all, { after: query.after, count: events.length }])
            : Effect.void)),
        })
      })).pipe(Layer.provide(SessionLogMemoryLive))
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* sessionOver(counted)
      const { model } = yield* scripted([...lookupThenDeliver, ...lookupThenDeliver])
      yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), answer())
      yield* Ref.set(reads, [])
      yield* agent.turn(inputFor(journal, "run-2", "find alpha again", model), answer())
      const second = (yield* journal.stored).filter((event) => Option.contains(event.turn, 2))
      return { reads: yield* Ref.get(reads), started: second[0]?.seq ?? 0, stored: second.length }
    })))
    // One read per step: the first from the turn's start (memory has the history), then after the last event seen.
    expect(reads).toHaveLength(3)
    expect(reads[0]?.after).toBe(started - 1)
    expect(reads.every((read, index) => index === 0 || read.after >= reads[index - 1]!.after + reads[index - 1]!.count)).toBe(true)
    expect(reads.reduce((sum, read) => sum + read.count, 0)).toBeLessThanOrEqual(stored)
  })

  test("a memory write reacting to context.built reaches the next step instead of failing this one", async () => {
    const { outcome, seen } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const noteOnBuild = definePlugin({
        id: "test/note-on-build", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [TurnMemory, TurnEvents], provides: [],
        layer: () => Layer.effectDiscard(Effect.gen(function* () {
          const memory = yield* TurnMemory
          const events = yield* TurnEvents
          yield* events.subscribe((event) => event._tag === "context.built" ? Option.some(event) : Option.none(),
            (event) => memory.context({ id: `built-${event.step}`, version: "1", text: `BUILT NOTE ${event.step}` }))
        })),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [noteOnBuild] })
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), answer())
      return { outcome, seen: yield* Ref.get(seen) }
    })))
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("record-alpha-a"), usage: tokenUsage({ inputTokens: 100 * seen.length, outputTokens: 10 * seen.length }), pending: 0 })
    expect(seen).toHaveLength(3)
    expect(seen[0]!.prompt).not.toContain("BUILT NOTE 0")
    expect(seen[1]!.prompt).toContain("BUILT NOTE 0")
  })

  test("a turn-dependent plugin's context recorded at activation follows the turn's message", async () => {
    const { seen, sections } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const noting = definePlugin({
        id: "test/note-at-activation", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [TurnMemory], provides: [],
        layer: () => Layer.effectDiscard(TurnMemory.pipe(Effect.flatMap((memory) => memory.context({ id: "note", version: "1", text: "PLUGIN NOTE" })))),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [noting] })
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([stop("one"), stop("two")])
      yield* Effect.forEach(["run-1", "run-2"], (runId) => agent.turn(inputFor(journal, runId, `hello ${runId}`, model), (turn) =>
        turn.run({}).pipe(Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })))))
      const events = yield* journal.stored
      return { seen: yield* Ref.get(seen), sections: named(events, "memory.section").map((event) => [event.data.entry, Option.getOrNull(event.turn)]) }
    })))
    expect(sections).toEqual([["run-1:1", 1], ["run-2:1", 2]])
    expect(seen.map((request) => request.prompt.includes("PLUGIN NOTE"))).toEqual([true, true])
  })

  test("the host's layer is built with the turn-dependent plugins' services", async () => {
    const reply = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stamping = definePlugin({
        id: "test/stamp", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext], provides: [Stamp],
        layer: () => Layer.effect(Stamp, RunContext.pipe(Effect.map((run) => ({ label: `stamped ${run.runId}` })))),
      })
      const hostLayer = Layer.effect(Tally, Effect.gen(function* () {
        const stamp = yield* Stamp
        return { runId: stamp.label, seen: yield* Ref.make<ReadonlyArray<string>>([]) }
      }))
      const agent = yield* define(memoryWindowPlugin, { plugins: [stamping] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const outcome = yield* agent.turn({ ...inputFor(journal, "run-1", "hello", model), layer: hostLayer }, () =>
        Tally.pipe(Effect.map((tally): TurnOutcome => ({ outcome: "completed", reply: Option.some(tally.runId) }))))
      return outcome.reply
    })))
    expect(reply).toEqual(Option.some("stamped run-1"))
  })

  test("a turn-dependent plugin finalizes while the turn's services are open: what it publishes and forks then is stored before the end", async () => {
    const { kinds, finalized } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const finalized = yield* Ref.make("not run")
      const closing = definePlugin({
        id: "test/closing", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext, TurnEvents, TurnTasks], provides: [],
        layer: () => Layer.effectDiscard(Effect.gen(function* () {
          const run = yield* RunContext
          const events = yield* TurnEvents
          const tasks = yield* TurnTasks
          yield* Effect.addFinalizer(() => Effect.gen(function* () {
            yield* events.publish({ _tag: "host", name: "plugin.closed", data: {} })
            yield* tasks.fork("closing", events.publish({ _tag: "host", name: "plugin.task", data: {} }))
            yield* run.flush
          }).pipe(Effect.exit, Effect.flatMap((exit) => Ref.set(finalized, exit._tag))))
        })),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [closing] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("hello"))
      return { kinds: (yield* journal.stored).map((event) => event.kind), finalized: yield* Ref.get(finalized) }
    })))
    expect(finalized).toBe("Success")
    expect(kinds.at(-1)).toBe("turn.ended")
    expect(kinds).toContain("plugin.closed")
    expect(kinds).toContain("plugin.task")
  })

  test.each([false, true])("host finalizer tasks settle before the reply with turn-dependent plugins (%p)", async (late) => {
    const { outcome, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const closing = definePlugin({
        id: "test/host-dependency", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext], provides: [], layer: () => Layer.empty,
      })
      const hostLayer = Layer.effectDiscard(Effect.gen(function* () {
        const tasks = yield* TurnTasks
        const events = yield* TurnEvents
        yield* Effect.addFinalizer(() => tasks.fork("host-closing", Effect.sleep("20 millis").pipe(
          Effect.andThen(events.publish({ _tag: "host", name: "host.task", data: {} })),
        )))
      }))
      const agent = yield* define(memoryWindowPlugin, { plugins: late ? [closing] : [] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const outcome = yield* agent.turn({ ...inputFor(journal, "run-1", "hello", model), layer: hostLayer }, (turn) => turn.reply("hello"))
      return { outcome, events: yield* journal.stored }
    })))
    const names = events.map((event) => event.kind)
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("hello"), usage: zeroUsage, pending: 0 })
    expect(names.indexOf("host.task")).toBeGreaterThan(-1)
    expect(names.indexOf("host.task")).toBeLessThan(names.indexOf("turn.reply"))
    expect(named(events, "turn.reply").map(body)).toEqual([{ outcome: "completed", reply: "hello" }])
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])
  })

  test.each([false, true])("a failed host finalizer task records only a failed reply with turn-dependent plugins (%p)", async (late) => {
    const { result, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const closing = definePlugin({
        id: "test/host-dependency", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext], provides: [], layer: () => Layer.empty,
      })
      const hostLayer = Layer.effectDiscard(TurnTasks.pipe(Effect.flatMap((tasks) => Effect.addFinalizer(() =>
        tasks.fork("host-closing", Effect.sleep("20 millis").pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "host.cleanup", message: "cleanup failed" }))))),
      ))))
      const agent = yield* define(memoryWindowPlugin, { plugins: late ? [closing] : [] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const result = yield* Effect.result(agent.turn({ ...inputFor(journal, "run-1", "hello", model), layer: hostLayer }, (turn) => turn.reply("hello")))
      return { result, events: yield* journal.stored }
    })))
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe("host.cleanup")
    expect(named(events, "turn.reply").map(body)).toEqual([{ outcome: "failed", reply: null }])
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["failed"])
  })

  test("a failed turn-dependent plugin finalizer task records only a failed reply", async () => {
    const { result, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const closing = definePlugin({
        id: "test/failing-closing", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [TurnTasks], provides: [],
        layer: () => Layer.effectDiscard(TurnTasks.pipe(Effect.flatMap((tasks) => Effect.addFinalizer(() =>
          tasks.fork("plugin-closing", Effect.sleep("20 millis").pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "plugin.cleanup", message: "cleanup failed" }))))),
        )))),
      })
      const agent = yield* define(memoryWindowPlugin, { plugins: [closing] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const result = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("hello")))
      return { result, events: yield* journal.stored }
    })))
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe("plugin.cleanup")
    expect(named(events, "turn.reply").map(body)).toEqual([{ outcome: "failed", reply: null }])
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["failed"])
  })

  test.each([false, true])("body, host and plugin scopes close in order before the final outcome (%p)", async (fails) => {
    const { order, result, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (label: string) => Ref.update(seen, (all) => [...all, label])
      const observerScope = yield* Effect.scope
      const closing = definePlugin({
        id: "test/scoped-closing", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
        requires: [RunContext], provides: [Stamp],
        layer: () => Layer.effect(Stamp, Effect.gen(function* () {
          yield* Effect.addFinalizer(() => note("plugin.closed"))
          return { label: "open" }
        })),
      })
      const hostLayer = Layer.effectDiscard(Effect.gen(function* () {
        yield* Stamp
        const tasks = yield* TurnTasks
        const events = yield* TurnEvents
        yield* Effect.addFinalizer(() => note("host.closed").pipe(
          Effect.andThen(events.publish({ _tag: "host", name: "host.closed", data: {} })),
          Effect.andThen(tasks.fork("host-closing", Effect.sleep("10 millis").pipe(
            Effect.andThen(note("host.task")),
            Effect.andThen(fails ? Effect.fail(new HarnessError({ code: "host.cleanup", message: "cleanup failed" })) : Effect.void),
          ))),
          Effect.orDie,
        ))
      }))
      const agent = yield* define(memoryWindowPlugin, { plugins: [closing] })
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const result = yield* Effect.result(agent.turn({ ...inputFor(journal, "run-1", "hello", model), layer: hostLayer }, (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe((event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(),
          (event) => note(`outcome:${event.outcome}`)).pipe(Scope.provide(observerScope))
        yield* turn.events.subscribe((event) => event._tag === "host" && event.name === "host.closed" ? Option.some(event) : Option.none(),
          () => note("body.subscription.after-close"))
        yield* Effect.addFinalizer(() => note("body.closed"))
        return yield* turn.reply("hello")
      })))
      return { order: yield* Ref.get(seen), result, events: yield* journal.stored }
    })))
    expect(order).toEqual(["body.closed", "host.closed", "host.task", "plugin.closed", `outcome:${fails ? "failed" : "completed"}`])
    expect(result._tag === "Failure" ? result.failure.code : "completed").toBe(fails ? "host.cleanup" : "completed")
    expect(named(events, "turn.reply").map((event) => body(event)?.outcome)).toEqual([fails ? "failed" : "completed"])
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual([fails ? "failed" : "completed"])
  })

  test("durable request replay refuses events that do not rebuild the request's context", async () => {
    const { complete, partial } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([...lookupThenDeliver, stop("later")])
      yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), answer())
      yield* agent.turn(inputFor(journal, "run-2", "later", model), (turn) =>
        turn.run({}).pipe(Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
      const events = yield* journal.stored
      // A fork's own log without its parent's history: the second turn's events alone.
      const own = events.filter((event) => Option.contains(event.turn, 2))
      return {
        complete: yield* Effect.result(replayModelRequest(events, "run-2", 0)),
        partial: yield* Effect.result(replayModelRequest(own, "run-2", 0)),
      }
    })))
    expect(complete._tag).toBe("Success")
    expect(partial._tag === "Failure" ? [partial.failure.code, partial.failure.message.split(":")[0]] : "success").toEqual(["request.diverged", "context"])
  })

  test.each([false, true])("a failed dispatch check fails the step, streamed (%p) or not, without a fallback call or a second check", async (streaming) => {
    const { result, checks, calls } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const checks = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const model = yield* LanguageModel.make({
        generateText: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(stop("done") as never)),
        streamText: () => Stream.unwrap(Ref.update(calls, (count) => count + 1).pipe(Effect.as(Stream.fromIterable([
          { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "done" }, { type: "text-end", id: "t" },
          { type: "finish", reason: "stop", usage },
        ] as never)))),
      })
      const checkedLoop = definePlugin({
        id: "test/checked-loop", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [StepLoop],
        layer: () => Layer.succeed(StepLoop, {
          id: "checked", version: "1", run: (request) => runSteps({
            ...request,
            // A store read that fails once: the check never passed, so no provider may run.
            dispatch: () => Ref.updateAndGet(checks, (count) => count + 1).pipe(Effect.flatMap((count) => count === 1
              ? Effect.fail(new HarnessError({ code: "session.log", message: "store unavailable" }))
              : Effect.void)),
          }),
        }),
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, checkedLoop], capabilities: [host],
        turnServices: [LanguageModel.LanguageModel], limits: { streaming, maxSteps: 2 },
      })
      const journal = yield* inMemorySession
      const result = yield* Effect.result(agent.turn(inputFor(journal, "run-1", "hello", model), (turn) =>
        turn.run({}).pipe(Effect.map((run): TurnOutcome => ({ outcome: run.outcome, reply: Option.some(run.text) })))))
      return { result, checks: yield* Ref.get(checks), calls: yield* Ref.get(calls) }
    })))
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe("session.log")
    expect({ checks, calls }).toEqual({ checks: 1, calls: 0 })
  })
})

describe("a turn's metadata", () => {
  test("meta given to Agent.turn is stored in turn.started, published on the bus and shown on RunContext.admitted and Turn.admitted", async () => {
    const { seen, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const seen = yield* Ref.make<ReadonlyArray<unknown>>([])
      const note = (label: string, value: unknown) => Ref.update(seen, (all) => [...all, [label, value]])
      // turn.started is published once the host's layer is built: a subscription made there sees it.
      const observer = Layer.effectDiscard(TurnEvents.pipe(Effect.flatMap((events) =>
        events.subscribe((event) => event._tag === "turn.started" ? Option.some(event.meta) : Option.none(), (meta) => note("bus", meta)))))
      const input = inputFor(journal, "run-1", "hello", model)
      yield* agent.turn({ ...input, turn: { ...input.turn, meta: { request: "req-1", tenant: "acme" } }, layer: observer }, (turn) => Effect.gen(function* () {
        yield* note("run", (yield* RunContext).admitted.meta)
        yield* note("turn", turn.admitted.meta)
        return yield* turn.reply("Hello there.")
      }))
      yield* agent.turn(inputFor(journal, "run-2", "again", model), (turn) => note("none", turn.admitted.meta).pipe(Effect.andThen(turn.reply("Again."))))
      return { seen: yield* Ref.get(seen), events: yield* journal.stored }
    })))
    const meta = { request: "req-1", tenant: "acme" }
    expect(seen).toEqual([["bus", meta], ["run", meta], ["turn", meta], ["none", {}]])
    expect(named(events, "turn.started").map((event) => event.data.meta ?? null)).toEqual([meta, null])
  })

  test("a retry with other meta is the same turn: it fails with turn.duplicate", async () => {
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const input = inputFor(journal, "run-1", "hello", model)
      yield* agent.turn({ ...input, turn: { ...input.turn, key: "client-1", meta: { attempt: 1 } } }, (turn) => turn.reply("Hello there."))
      return yield* Effect.result(agent.turn({ ...input, turn: { ...input.turn, runId: "run-2", key: "client-1", meta: { attempt: 2 } } }, (turn) => turn.reply("Hello again.")))
    })))
    expect(exit._tag === "Failure" ? exit.failure.code : "none").toBe("turn.duplicate")
  })
})

describe("resuming a turn", () => {
  test("a cancelled turn is resumed: resumes is on the turn, RunContext, the bus and the stored turn.started, the key is resume:<n>, and a retry is turn.duplicate", async () => {
    const { seen, started, retried } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      yield* journal.sessions.begin(journal.address, { _tag: "User", userMessage: new UserMessage({ text: "find alpha" }), runId: "run-1", key: "run-1", command: {} })
      yield* journal.sessions.cancel(journal.address, 1)
      const seen = yield* Ref.make<ReadonlyArray<unknown>>([])
      const note = (label: string, value: unknown) => Ref.update(seen, (all) => [...all, [label, value]])
      const observer = Layer.effectDiscard(TurnEvents.pipe(Effect.flatMap((events) =>
        events.subscribe((event) => event._tag === "turn.started" ? Option.some(event.resumes ?? null) : Option.none(), (resumes) => note("bus", resumes)))))
      const input = inputFor(journal, "run-2", "Continue.", model)
      const resumed = { ...input, turn: { ...input.turn, resumes: 1 }, layer: observer }
      yield* agent.turn(resumed, (turn) => Effect.gen(function* () {
        yield* note("run", (yield* RunContext).admitted.resumes ?? null)
        yield* note("turn", [turn.admitted.resumes ?? null, turn.admitted.key, turn.turn])
        return yield* turn.reply("Resumed.")
      }))
      const retried = yield* Effect.flip(agent.turn({ ...resumed, turn: { ...resumed.turn, runId: "run-3" } }, (turn) => turn.reply("Again.")))
      const started = named(yield* journal.stored, "turn.started").map((event) => [event.data.key, event.data.resumes ?? null])
      return { seen: yield* Ref.get(seen), started, retried: retried.code }
    })))
    expect(seen).toEqual([["bus", 1], ["run", 1], ["turn", [1, "resume:1", 2]]])
    expect(started).toEqual([["run-1", null], ["resume:1", 1]])
    expect(retried).toBe("turn.duplicate")
  })

  test("an interrupted turn keeps a failed reply with no text; the turn resuming it sees its message and nothing for that reply", async () => {
    const { replies, prompt } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const first = yield* scripted([])
      const waiting = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(agent.turn(inputFor(journal, "run-1", "find alpha", first.model), () =>
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(waiting)
      yield* Fiber.interrupt(fiber)
      const second = yield* scripted([stop("found it")])
      const input = inputFor(journal, "run-2", "Continue where you stopped.", second.model)
      yield* agent.turn({ ...input, turn: { ...input.turn, resumes: 1 } }, (turn) =>
        turn.run({}).pipe(Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
      const replies = named(yield* journal.stored, "turn.reply").map((event) => [Option.getOrNull(event.turn), body(event)?.outcome, body(event)?.reply ?? null])
      return { replies, prompt: (yield* Ref.get(second.seen))[0]?.prompt ?? "" }
    })))
    expect(replies).toEqual([[1, "failed", null], [2, "completed", "found it"]])
    expect(prompt.indexOf("find alpha")).toBeGreaterThan(-1)
    expect(prompt.indexOf("find alpha")).toBeLessThan(prompt.indexOf("Continue where you stopped."))
    // The failed reply has no text: no assistant message stands for it.
    expect(prompt).toContain("\"role\":\"user\"")
    expect(prompt).not.toContain("\"role\":\"assistant\"")
  })

  test("a turn that cannot be resumed fails with turn.not-resumable, naming the turn and why", async () => {
    const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("Hello there."))
      const resume = (turn: number, runId: string) => {
        const input = inputFor(journal, runId, "Continue.", model)
        return Effect.flip(agent.turn({ ...input, turn: { ...input.turn, resumes: turn } }, (next) => next.reply("Resumed.")))
      }
      // `resumes` is typed only as a number: a host's `Number(query.resumes)` may be anything, and the turn fails, it does not die.
      return yield* Effect.forEach([[1, "run-2"], [9, "run-3"], [1.5, "run-4"], [Number.NaN, "run-5"]] as const, ([turn, runId]) =>
        resume(turn, runId).pipe(Effect.map((error) => [error.code, error.message])))
    })))
    expect(failures).toEqual([
      ["turn.not-resumable", `turn 1 of session ${conversation} cannot be resumed (finished)`],
      ["turn.not-resumable", `turn 9 of session ${conversation} cannot be resumed (missing)`],
      ["turn.not-resumable", `turn 1.5 of session ${conversation} cannot be resumed (missing)`],
      ["turn.not-resumable", `turn NaN of session ${conversation} cannot be resumed (missing)`],
    ])
  })
})

describe("a turn's images", () => {
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

  test.each([["inline", true], ["none", false]] as const)("an image-only message reaches the first request as a file part, normalised; step-0 dispatch passes its check; a later turn sends it again with media %p (%p)", async (media, again) => {
    const { outcome, seen, events, replayed, pixel } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define({ plugin: memoryWindowPlugin, options: { media } })
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([stop("a pixel"), stop("still a pixel")])
      const pixel = yield* mediaFromBase64(pixelPng, { name: "pixel.png" })
      const careless = { ...pixel, mediaType: "image/webp" as const, bytes: 9, fingerprint: MediaFingerprint.make("ffffffffffffffff") }
      const input = inputFor(journal, "run-1", "replaced below", model)
      const outcome = yield* agent.turn({ ...input, turn: { ...input.turn, userMessage: new UserMessage({ text: "", attachments: [careless] }) } }, (turn) =>
        turn.run({ limits: { requireCompletion: false } }).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
      yield* agent.turn(inputFor(journal, "run-2", "and now?", model), (turn) =>
        turn.run({ limits: { requireCompletion: false } }).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
      const events = yield* journal.stored
      const replayed = yield* replayModelRequest(events, "run-1", 0)
      return { outcome, seen: yield* Ref.get(seen), events, replayed, pixel }
    })))
    expect([outcome.outcome, outcome.reply]).toEqual(["completed", Option.some("a pixel")])
    expect(named(events, "turn.started")[0]?.data.userMessage).toEqual({ text: "", attachments: [pixel] })
    const first = JSON.parse(seen[0]?.prompt ?? "[]") as ReadonlyArray<{ readonly role: string; readonly content: unknown }>
    expect(first.at(1)).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png", data: pixelPng, fileName: "pixel.png" }] })
    expect(JSON.stringify(replayed.prompt.content)).toBe(seen[0]?.prompt ?? "")
    // `inline` (the default) sends an earlier turn's image again; `none` shows it as its label line.
    expect(seen[1]?.prompt.includes(JSON.stringify(mediaLabel(pixel)).slice(1, -1))).toBe(!again)
    expect(seen[1]?.prompt.includes(pixelPng)).toBe(again)
  })

  test("an attachment that is not an image fails the turn before it begins (turn.attachment-rejected)", async () => {
    const { error, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([])
      const pixel = yield* mediaFromBase64(pixelPng)
      const input = inputFor(journal, "run-1", "look", model)
      const error = yield* Effect.flip(agent.turn({ ...input, turn: { ...input.turn, userMessage: new UserMessage({ text: "look", attachments: [{ ...pixel, data: "aGVsbG8gd29ybGQ=" }] }) } }, (turn) => turn.reply("never")))
      return { error, events: yield* journal.stored }
    })))
    expect(error.code).toBe("turn.attachment-rejected")
    expect(error.message).toContain("UnsupportedType")
    expect(events).toEqual([])
  })
})

/* ── images a tool returns ── */

const Screenshot = Tool.make("screenshot", {
  description: "Take a screenshot of the page.",
  parameters: Schema.Struct({ page: Schema.String }),
  success: Schema.Struct({ page: Schema.String, image: Media }),
  failure: Failure,
  failureMode: "return",
})
const screenshotPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const screenshots = defineCapability({
  id: "test-screenshots", version: "1",
  tools: [defineTool({
    tool: Screenshot,
    handler: ({ page }) => mediaFromBase64(screenshotPng, { name: `${page}.png` }).pipe(
      Effect.map((image) => ({ page, image })),
      Effect.orDie,
    ),
    view: { version: "1", render: (result) => `Screenshot of ${result.page}.` },
    annotations: { readOnly: true },
  })],
  skills: [defineSkill({ id: "screens", summary: "Take screenshots.", tools: ["screenshot"], always: true })],
})

/** A scripted model that refuses the request it is sent as call `refuse`, as Anthropic refuses an image it cannot read. */
const refusing = (script: ReadonlyArray<Part>, refuse: number) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(seen, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.flatMap((index) => index === refuse
        ? Effect.fail(AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidRequestError({ description: "messages.2.content.0.image.source.base64: image exceeds 5 MB maximum" }) }))
        : Effect.succeed((script[index - (index > refuse ? 1 : 0)] ?? stop("done")) as never)),
    ),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { seen, model }
})

describe("images a tool returns", () => {
  const run = (model: LanguageModel.LanguageModel) => Effect.gen(function* () {
    const agent = yield* define(memoryWindowPlugin, { capabilities: [screenshots] })
    const journal = yield* inMemorySession
    const outcome = yield* agent.turn(inputFor(journal, "run-1", "how does the home page look?", model), (turn) =>
      turn.tools.select(turn.userMessage).pipe(
        Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
        Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
      ))
    return { outcome, events: yield* journal.stored, replayed: yield* replayModelRequest(yield* journal.stored, "run-1", 1) }
  })

  test("reach the next request as image parts of the tool result; the session log stores each image once, where the tool put it", async () => {
    const { outcome, seen, events, replayed } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { seen, model } = yield* scripted([call("c1", "screenshot", { page: "home" }), stop("a blank page")])
      return { ...(yield* run(model)), seen: yield* Ref.get(seen) }
    })))
    expect([outcome.outcome, outcome.reply]).toEqual(["completed", Option.some("a blank page")])
    const second = JSON.parse(seen[1]?.prompt ?? "[]") as ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Record<string, unknown>> }>
    const result = second.find((message) => message.role === "tool")?.content[0]
    expect(result?.["result"]).toBe("Screenshot of home.")
    expect(result?.["modelOutput"]).toMatchObject([
      { type: "text", text: "Screenshot of home." },
      { type: "file", mediaType: "image/png", data: screenshotPng, fileName: "home.png" },
    ])
    expect(JSON.stringify(replayed.prompt.content)).toBe(seen[1]?.prompt ?? "")
    const stored = named(events, "memory.tool-result")
    expect(body(stored[0])?.["media"]).toEqual([{ path: ["image"], fingerprint: expect.any(String), mediaType: "image/png", bytes: 70 }])
    expect(JSON.stringify(events).split(screenshotPng).length - 1).toBe(1)
  })

  test("an image the provider refuses is omitted (OmitMedia) and the step is sent once more, the image as its label line", async () => {
    const { outcome, seen, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { seen, model } = yield* refusing([call("c1", "screenshot", { page: "home" }), stop("a page I could not see")], 1)
      return { ...(yield* run(model)), seen: yield* Ref.get(seen) }
    })))
    expect([outcome.outcome, outcome.reply]).toEqual(["completed", Option.some("a page I could not see")])
    expect(seen).toHaveLength(3)
    expect(seen[1]).toContain(screenshotPng)
    expect(seen[2]).not.toContain(screenshotPng)
    expect(seen[2]).toContain("[image omitted: image/png, 70 B, home.png]")
    const omitted = named(events, "memory.compaction").map((event) => body(event)?.["action"])
    expect(omitted).toEqual([{ _tag: "OmitMedia", entries: [expect.stringMatching(/^run-1:/)], reason: expect.stringContaining("image exceeds 5 MB maximum") }])
    expect(named(events, "request.prepared").map((event) => event.data.step)).toEqual([0, 1, 1])
  })

  test("a step sent again over a refused image keeps its plan: one policy.model and policy.step call, one memory.step entry", async () => {
    const { outcome, events, models, directives } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* refusing([call("c1", "screenshot", { page: "home" }), stop("a page I could not see")], 1)
      const models = yield* Ref.make<ReadonlyArray<number>>([])
      const directives = yield* Ref.make<ReadonlyArray<number>>([])
      const agent = yield* define(memoryWindowPlugin, { capabilities: [screenshots] })
      const journal = yield* inMemorySession
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "how does the home page look?", model), (turn) =>
        turn.tools.select(turn.userMessage).pipe(
          Effect.andThen(turn.run({
            limits: { requireCompletion: false },
            model: (info) => Ref.update(models, (all) => [...all, info.stepIndex]).pipe(Effect.as(Option.some({ model, variant: Option.none<string>() }))),
            step: (info) => Ref.update(directives, (all) => [...all, info.stepIndex]).pipe(Effect.as({ context: Option.some(`step ${info.stepIndex}`), toolChoice: Option.none() })),
          })),
          Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
        ))
      return { outcome, events: yield* journal.stored, models: yield* Ref.get(models), directives: yield* Ref.get(directives) }
    })))
    expect(outcome.outcome).toBe("completed")
    expect(named(events, "memory.compaction")).toHaveLength(1)
    expect([models, directives]).toEqual([[0, 1], [0, 1]])
    expect(named(events, "memory.step").map((event) => event.data.step)).toEqual([0, 1])
  })

  test("a step loop that plans a step twice, with no image refused, asks the policy again", async () => {
    const models = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* scripted([stop("done")])
      const models = yield* Ref.make<ReadonlyArray<number>>([])
      const twice = definePlugin({
        id: "test/plans-twice", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [StepLoop],
        layer: () => Layer.succeed(StepLoop, {
          id: "plans-twice", version: "1", run: (request) => runSteps({ ...request, plan: (info) => request.plan(info).pipe(Effect.andThen(request.plan(info))) }),
        }),
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, twice], capabilities: [host],
        turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 1 },
      })
      const journal = yield* inMemorySession
      yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.run({
        limits: { requireCompletion: false },
        model: (info) => Ref.update(models, (all) => [...all, info.stepIndex]).pipe(Effect.as(Option.some({ model, variant: Option.none<string>() }))),
      }).pipe(Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
      return yield* Ref.get(models)
    })))
    expect(models).toEqual([0, 0])
  })

  test("a request the provider refuses twice over an image fails the turn", async () => {
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const seen = yield* Ref.make(0)
      const model = yield* LanguageModel.make({
        generateText: () => Ref.getAndUpdate(seen, (count) => count + 1).pipe(Effect.flatMap((index) => index === 0
          ? Effect.succeed(call("c1", "screenshot", { page: "home" }) as never)
          : Effect.fail(AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidRequestError({ description: "Could not process image" }) })))),
        streamText: () => Stream.die("not scripted") as never,
      })
      return yield* Effect.flip(run(model))
    })))
    expect(error.message).toContain("Could not process image")
  })
})

describe("the token budget", () => {
  test("Agent.define refuses a budget that is not an integer of at least 1 (config.budget)", async () => {
    const codes = await Effect.runPromise(Effect.forEach([0, -1, 1.5], (budgetTokens) =>
      Effect.scoped(Effect.flip(define(memoryWindowPlugin, { budgetTokens }))).pipe(Effect.map((error) => error.code))))
    expect(codes).toEqual(["config.budget", "config.budget", "config.budget"])
  })

  test("a run refuses a policy budget that is not an integer of at least 1 (turn.budget), before any provider call", async () => {
    const { codes, seen } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { seen, model } = yield* scripted([])
      const codes = yield* Effect.forEach([0, -1, 1.5], (budgetTokens, index) =>
        Effect.flip(agent.turn(inputFor(journal, `run-${index}`, "hello", model), (turn) =>
          turn.run({ budgetTokens }).pipe(Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) }))))).pipe(
          Effect.map((error) => error.code)))
      return { codes, seen: yield* Ref.get(seen) }
    })))
    expect(codes).toEqual(["turn.budget", "turn.budget", "turn.budget"])
    expect(seen).toHaveLength(0)
  })

  test("a budget the system prompt and tool schemas use up fails with context.budget before any provider call; context.built records the run's budget", async () => {
    const { tight, calls, built } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { budgetTokens: 20_000 })
      const journal = yield* inMemorySession
      const run = (runId: string, policy: TurnPolicy) => Effect.gen(function* () {
        const { model, seen } = yield* scripted(lookupThenDeliver)
        const result = yield* Effect.result(agent.turn(inputFor(journal, runId, "find alpha", model), answer(policy)))
        return { result, calls: (yield* Ref.get(seen)).length }
      })
      // 150 tokens hold the turn's message (memory's turn-start check passes) but not the system prompt and tool schemas.
      const tight = yield* run("run-1", { budgetTokens: 150 })
      yield* run("run-2", {})
      yield* run("run-3", { budgetTokens: 30_000 })
      const built = named(yield* journal.stored, "context.built").map((event) => [Option.getOrNull(event.turn), event.data.budgetTokens, event.data.reservedTokens])
      return { tight: tight.result, calls: tight.calls, built }
    })))
    expect(tight._tag === "Failure" ? [tight.failure.code, tight.failure.message] : "none")
      .toEqual(["context.budget", expect.stringMatching(/^The system prompt and tool schemas take \d+ tokens, all of the 150-token context budget/)])
    expect(calls).toBe(0)
    expect(built.map(([turn, budget]) => [turn, budget])).toEqual([[2, 20_000], [2, 20_000], [2, 20_000], [3, 30_000], [3, 30_000], [3, 30_000]])
    expect(built.every(([, , reserved]) => typeof reserved === "number" && reserved > 150)).toBe(true)
  })
})

describe("a turn's usage", () => {
  test("Agent.turn returns the turn's usage: every run's calls, cache writes and reasoning included; turn.ended and the stored step.usage records agree", async () => {
    // What a provider reports with prompt caching and reasoning on: the cache counts inside the input, the reasoning inside the output.
    const billed = { inputTokens: { total: 1000, uncached: 100, cacheRead: 800, cacheWrite: 100 }, outputTokens: { total: 50, text: 20, reasoning: 30 } }
    const reply = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage: billed }]
    const { result, ended, events, during } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const observerScope = yield* Effect.scope
      const ended = yield* Ref.make<ReadonlyArray<unknown>>([])
      const during = yield* Ref.make<ReadonlyArray<unknown>>([])
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemorySession
      const { model } = yield* scripted([reply("first"), reply("second")])
      const result = yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe((event) => event._tag === "turn.ended" ? Option.some(event.usage) : Option.none(),
          (usage) => Ref.update(ended, (all) => [...all, usage])).pipe(Scope.provide(observerScope))
        const first = yield* turn.run({})
        const second = yield* turn.run({})
        yield* Ref.set(during, [first.usage, second.usage, yield* turn.usage, yield* (yield* RunContext).usage])
        return { outcome: second.outcome, reply: Option.some(second.text) }
      }))
      return { result, ended: yield* Ref.get(ended), events: yield* journal.stored, during: yield* Ref.get(during) }
    })))
    const one = tokenUsage({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 30 })
    const two = tokenUsage({ inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1600, cacheWriteTokens: 200, reasoningTokens: 60 })
    expect(result).toEqual({ outcome: "completed", reply: Option.some("second"), usage: two, pending: 0 })
    expect(during).toEqual([one, one, two, two])
    expect(ended).toEqual([two])
    const number = Option.getOrThrow(named(events, "turn.started")[0]?.turn ?? Option.none())
    expect(await Effect.runPromise(turnUsageOf(events, number))).toEqual(two)
    expect(named(events, "step.usage").map((event) => event.data.usage)).toEqual([one, one])
  })
})

describe("the inbox after Agent.turn", () => {
  test("a background task's result delivered while the turn runs is counted in its pending, and the caller's drain answers it", async () => {
    const { pending, before, after } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reactions = yield* Ref.make<ReadonlyArray<string>>([])
      const executor = TaskExecutor.of({
        turn: (_writer, task) => Effect.succeed({ outcome: "completed", reply: Option.some(`found: ${task.instructions}`) }),
        react: (writer) => Ref.update(reactions, (all) => [...all, writer.admitted.userMessage.text]),
      })
      const sessionsLayer = SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
        Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
      const services = yield* Layer.build(TasksLive(tasksDefaults).pipe(
        Layer.provideMerge(Layer.mergeAll(sessionsLayer, InProcessTaskRunnerLive(), Layer.succeed(TaskExecutor, executor)))))
      const sessions = Context.get(services, Sessions)
      yield* sessions.create({ owner: "test", id: conversation })
      const journal: Journal = { sessions, address: { id: conversation, owner: "test" }, stored: sessions.read({ id: conversation, owner: "test" }).pipe(Effect.orDie) }
      const agent = yield* define(memoryWindowPlugin)
      const { model } = yield* scripted([])
      const result = yield* agent.turn(inputFor(journal, "run-1", "start a task", model), (turn) => Effect.gen(function* () {
        yield* Context.get(services, Tasks).start(journal.address, { instructions: "look it up", mode: "spawn" }).pipe(
          Effect.mapError((error) => new HarnessError({ code: "task.start", message: error._tag })))
        // The task runs, delivers its result and drains the parent, which is busy with this turn.
        yield* Context.get(services, TaskActivity).idle
        return yield* turn.reply("started")
      }))
      const before = yield* Ref.get(reactions)
      if ((result.pending ?? 0) > 0) yield* sessions.drain(journal.address, executor.react)
      return { pending: result.pending, before, after: yield* Ref.get(reactions) }
    })))
    expect([pending, before]).toEqual([1, []])
    expect(after).toHaveLength(1)
    expect(after[0]).toContain("found: look it up")
  })
})
