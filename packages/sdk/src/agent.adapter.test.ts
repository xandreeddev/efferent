import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
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
  onTool,
  RunContext,
  replayModelRequest,
  SessionLog,
  SessionLogError,
  SessionLogMemoryLive,
  Sessions,
  StepLoop,
  subscribeAll,
  TurnAdmissionOpen,
  TurnEvents,
  TurnMemory,
  TurnTasks,
  UserMessage,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { LogEntry, Plugin, SessionLogEvent, Turn, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { runSteps, stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
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
  complete: () => Effect.succeed(new UtilityCompletion({ text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })),
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
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(log, TurnAdmissionOpen)))), Sessions)
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
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("record-alpha-a") })
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
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("Hello there.") })
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
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["failed"])
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
    expect(named(events, "turn.ended").map((event) => event.data.reason)).toEqual(["interrupted"])
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
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("record-alpha-a") })
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
