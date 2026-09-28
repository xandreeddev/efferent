import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "@effect/ai"
import { Context, Deferred, Effect, Fiber, FiberRef, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import {
  ConversationId,
  CurrentPromptCacheKey,
  DecisionRecord,
  defineContributions,
  defineHostEvent,
  definePlugin,
  defineSkill,
  defineTool,
  Failure,
  HarnessError,
  inMemoryJournal,
  IntentMatcher,
  onTool,
  RunContext,
  subscribeAll,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { EventBody, JournalIO, LogEntry, Plugin, Turn, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memoryLogPlugin } from "@xandreed/plugin-memory-log"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig, AgentPluginEntry } from "./agent.adapter.js"
import { Tally } from "./testing.port.js"

/* ── the host's definitions: thin tools with views, skills and sections ── */

const Item = Schema.Struct({ id: Schema.String, detail: Schema.String })
const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: { query: Schema.String },
  success: Schema.Struct({ items: Schema.Array(Item) }),
  failure: Failure,
  failureMode: "return",
})
const Deliver = Tool.make("deliver", {
  description: "Deliver the final answer.",
  parameters: { text: Schema.String },
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})

const found = (items: ReadonlyArray<typeof Item.Type>) => items.map((item) => `FOUND ${item.id}: ${item.detail}`).join("\n")
const host = defineContributions({
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
  sections: [
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
const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const cacheKey = yield* FiberRef.get(CurrentPromptCacheKey)
      const index = yield* Ref.modify(seen, (all): [number, ReadonlyArray<Seen>] => [all.length, [...all, {
        tools: options.tools.map((tool) => tool.name), prompt: JSON.stringify(options.prompt.content), toolChoice: options.toolChoice, cacheKey,
      }]])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { seen, model }
})

/* ── agents, journals and turns ── */

const conversation = ConversationId.make("00000000-0000-4000-8000-000000000001")
const utilityText = (text: string) => Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })),
}))

const define = (memory: Plugin | AgentPluginEntry, extra: Partial<AgentConfig> = {}) => Agent.define({
  plugins: [memoryLogPlugin, memory, toolDiscoveryPlugin, stepLoopPlugin, ...(extra.plugins ?? [])],
  contributions: [host, ...(extra.contributions ?? [])],
  turnServices: [LanguageModel.LanguageModel, ...(extra.turnServices ?? [])],
  limits: { streaming: false, maxSteps: 6 },
  cacheKeyPrefix: "agent",
  ...(extra.budgetTokens === undefined ? {} : { budgetTokens: extra.budgetTokens }),
})

type Journal = Effect.Effect.Success<typeof inMemoryJournal>
const inputFor = (journal: Journal, runId: string, prompt: string, model: LanguageModel.Service, services: Context.Context<never> = Context.empty()) => ({
  conversation, runId, prompt, journal: journal.io,
  services: Context.merge(Context.make(LanguageModel.LanguageModel, model), services),
})
const named = (events: ReadonlyArray<EventBody>, name: string) => events.filter((event) => event.name === name)

/** The ordinary answer: select tools, react to delivery, run until delivered. */
const answer = (policy: TurnPolicy = {}) => (turn: Turn): Effect.Effect<TurnOutcome, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const delivered = yield* Ref.make(Option.none<string>())
  yield* subscribeAll(turn.events, [onTool(Deliver, ({ input }) => Ref.set(delivered, Option.some(input.text)))])
  yield* turn.tools.select(turn.prompt)
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
  parameters: { text: Schema.String },
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})
const noting = defineContributions({
  id: "test-noting", version: "1",
  tools: [defineTool({ tool: Note, handler: ({ text }) => Tally.pipe(Effect.flatMap((tally) => tallied(tally, `tool:${text}`)), Effect.as(true)) })],
  skills: [defineSkill({ id: "noting", summary: "Take notes.", tools: ["note"], always: true })],
})

/** A journal whose store is slow, and fails on one event name when asked to. */
const slowJournal = (failOn: Option.Option<string>) => Effect.gen(function* () {
  const stored = yield* Ref.make<ReadonlyArray<EventBody>>([])
  const io: JournalIO = {
    append: (event) => Effect.sleep("1 millis").pipe(Effect.zipRight(Option.contains(failOn, event.name)
      ? Effect.fail(new HarnessError({ code: "journal.down", message: "store unavailable" }))
      : Ref.update(stored, (all) => [...all, event]))),
    read: (names) => Ref.get(stored).pipe(Effect.map((all) => all.filter((event) => names.length === 0 || names.includes(event.name)))),
  }
  return { stored, io }
})

const lookupThenDeliver = [call("c1", "lookup", { query: "alpha" }), call("c2", "load_skill", { skills: ["delivery"] }), call("c3", "deliver", { text: "record-alpha-a" })]

describe("Agent.turn", () => {
  test("a turn runs the loop, grows tools in activation order and journals every event", async () => {
    const { outcome, seen, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), answer())
      return { outcome, seen: yield* Ref.get(seen), events: yield* Ref.get(journal.stored) }
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
    const names = events.map((event) => event.name).filter((name) => name !== "memory.entries")
    expect(names[0]).toBe("turn.started")
    expect(names.at(-1)).toBe("turn.ended")
    expect(named(events, "tool.completed").map((event) => event.data.tool)).toEqual(["lookup", "load_skill", "deliver"])
    expect(named(events, "tool.completed").every((event) => !("result" in event.data) && "encoded" in event.data)).toBe(true)
    expect(named(events, "context.built")).toHaveLength(3)
    expect(named(events, "skills.activated").map((event) => event.data.skills)).toContainEqual(["delivery"])
    const order = names.filter((name) => ["step.started", "tool.started", "tool.completed", "step.ended", "completion.evaluated"].includes(name))
    expect(order.slice(0, 5)).toEqual(["step.started", "tool.started", "tool.completed", "step.ended", "completion.evaluated"])
    expect(named(events, "turn.ended")).toHaveLength(1)
  })

  test("a quick reply is a recorded turn without the loop", async () => {
    const { outcome, seen, events, transcript } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { seen, model } = yield* scripted([])
      const outcome = yield* agent.turn(inputFor(journal, "run-1", "hello", model), (turn) => turn.reply("Hello there."))
      const transcript = yield* agent.turn(inputFor(journal, "run-2", "again", model), (turn) =>
        turn.memory.transcript("reference").pipe(Effect.flatMap((messages) => turn.reply(JSON.stringify(messages)))))
      return { outcome, seen: yield* Ref.get(seen), events: yield* Ref.get(journal.stored), transcript }
    })))
    expect(outcome).toEqual({ outcome: "completed", reply: Option.some("Hello there.") })
    expect(seen).toHaveLength(0)
    expect(named(events, "turn.ended").map((event) => event.data)).toContainEqual({ runId: "run-1", turn: 1, outcome: "completed", reply: "Hello there." })
    expect(Option.getOrElse(transcript.reply, () => "")).toContain("Hello there.")
  })

  test("a failing turn fails with its error and records turn.ended failed exactly once", async () => {
    const { exit, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([])
      const exit = yield* Effect.either(agent.turn(inputFor(journal, "run-1", "fail", model), () => Effect.fail(new HarnessError({ code: "host.failed", message: "no" }))))
      return { exit, events: yield* Ref.get(journal.stored) }
    })))
    expect(exit._tag === "Left" ? exit.left.code : "none").toBe("host.failed")
    expect(named(events, "turn.ended").map((event) => event.data.outcome)).toEqual(["failed"])
  })

  test("a failing subscriber fails the turn, not the tool call", async () => {
    const { exit, seen } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { seen, model } = yield* scripted(lookupThenDeliver)
      const exit = yield* Effect.either(agent.turn(inputFor(journal, "run-1", "find alpha", model), (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe(Option.liftPredicate((event) => event._tag === "tool.completed"), () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "broken" })))
        return yield* answer()(turn)
      })))
      return { exit, seen: yield* Ref.get(seen) }
    })))
    expect(exit._tag === "Left" ? exit.left.code : "none").toBe("reaction.failed")
    expect(seen).toHaveLength(1)
  })

  test("interrupting a turn interrupts its tasks and records the failure", async () => {
    const { interrupted, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([])
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const fiber = yield* Effect.fork(agent.turn(inputFor(journal, "run-1", "wait", model), (turn) => Effect.gen(function* () {
        yield* turn.tasks.fork("slow", Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never), Effect.onInterrupt(() => Ref.set(interrupted, true))))
        return yield* Effect.never
      })))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return { interrupted: yield* Ref.get(interrupted), events: yield* Ref.get(journal.stored) }
    })))
    expect(interrupted).toBe(true)
    expect(named(events, "turn.ended").map((event) => event.data.outcome)).toEqual(["failed"])
  })

  test("tasks are joined before turn.ended", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([])
      const Prepared = defineHostEvent("page.prepared", Schema.Struct({ id: Schema.String }))
      yield* agent.turn(inputFor(journal, "run-1", "prepare", model), (turn) => Effect.gen(function* () {
        yield* turn.tasks.fork("page", Effect.sleep("20 millis").pipe(Effect.zipRight(Prepared.publish(turn.events, { id: "p1" }))))
        return yield* turn.reply("preparing")
      }))
      return yield* Ref.get(journal.stored)
    })))
    const names = events.map((event) => event.name)
    expect(names.indexOf("page.prepared")).toBeGreaterThan(-1)
    expect(names.indexOf("page.prepared")).toBeLessThan(names.indexOf("turn.ended"))
  })

  test("a subscriber's state is visible to the next step", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* inMemoryJournal
      const { seen, model } = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "deliver", { text: "x" })])
      yield* agent.turn(inputFor(journal, "run-1", "find alpha", model), (turn) => Effect.gen(function* () {
        const known = yield* Ref.make<ReadonlyArray<string>>([])
        yield* subscribeAll(turn.events, [onTool(Lookup, ({ result }) => Ref.set(known, result.items.map((item) => item.id)))])
        yield* turn.tools.select(turn.prompt)
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
      const journal = yield* inMemoryJournal
      const { seen, model } = yield* scripted([call("c1", "deliver", { text: "planned" })])
      yield* agent.turn(inputFor(journal, "run-1", "plan it", model), answer({
        initial: { calls: [{ name: "lookup", params: { query: "alpha" } }], skills: ["delivery"] },
        step: (step) => Effect.succeed({ context: Option.none(), toolChoice: step.stepIndex === 1 ? Option.some({ tool: "deliver" }) : Option.none() }),
      }))
      return { seen: yield* Ref.get(seen), events: yield* Ref.get(journal.stored) }
    })))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.toolChoice).toEqual({ tool: "deliver" })
    expect(seen[0]!.prompt).toContain("FOUND record-alpha-a")
    expect(named(events, "step.started")[0]?.data).toMatchObject({ step: 0, planned: true })
  })

  test("the matcher from the turn's services seeds skills and records its decision", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { turnServices: [] })
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([call("c1", "deliver", { text: "done" })])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "keyword", version: "1",
        match: ({ message }) => Effect.succeed({ skills: message.includes("deliver") ? ["delivery"] : [], probabilities: Option.none(), abstained: false }),
      }))
      yield* agent.turn(inputFor(journal, "run-1", "please deliver", model, matcher), answer())
      return yield* Ref.get(journal.stored)
    })))
    const decision = named(events, "decision.recorded")[0]?.data.record
    expect(decision).toMatchObject({ family: "skill-selection", selection: "delivery", applied: "delivery", validation: "accepted" })
    expect(Schema.decodeUnknownEither(DecisionRecord)(decision)._tag).toBe("Right")
  })

  test("the turn's layer is built per turn and provided to use, tools and subscriptions alike", async () => {
    const replies = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin, { contributions: [noting] })
      const journal = yield* inMemoryJournal
      const turnWith = (runId: string) => Effect.gen(function* () {
        const { model } = yield* scripted([call("c1", "note", { text: "x" }), stop("done")])
        const outcome = yield* agent.turn({ ...inputFor(journal, runId, "take a note", model), layer: tallyLayer }, (turn) => Effect.gen(function* () {
          const tally = yield* Tally
          yield* tallied(tally, "use")
          yield* subscribeAll(turn.events, [onTool(Note, ({ input }) => Tally.pipe(Effect.flatMap((same) => tallied(same, `subscriber:${input.text}`))))])
          yield* turn.tasks.fork("tally", Tally.pipe(Effect.flatMap((same) => tallied(same, "task"))))
          yield* turn.tasks.await(["tally"])
          yield* turn.tools.select(turn.prompt)
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
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "keyword", version: "1",
        match: ({ message }) => Effect.succeed({ skills: message.includes("deliver") ? ["delivery"] : [], probabilities: Option.none(), abstained: false }),
      }))
      const observed = yield* Ref.make({ matched: [] as ReadonlyArray<string>, recorded: false, wroteOnMatch: -1, activeBefore: [] as ReadonlyArray<string>, activeAfter: [] as ReadonlyArray<string> })
      yield* agent.turn(inputFor(journal, "run-1", "please deliver", model, matcher), (turn) => Effect.gen(function* () {
        yield* turn.flush
        const before = (yield* Ref.get(journal.stored)).length
        const match = yield* turn.tools.match(turn.prompt)
        yield* turn.flush
        const wroteOnMatch = (yield* Ref.get(journal.stored)).length - before
        const activeBefore = yield* turn.tools.active
        yield* turn.tools.apply(match)
        yield* Ref.set(observed, { matched: match.skills, recorded: Option.isSome(match.record), wroteOnMatch, activeBefore, activeAfter: yield* turn.tools.active })
        return yield* turn.reply("ok")
      }))
      return { ...(yield* Ref.get(observed)), events: yield* Ref.get(journal.stored) }
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

  test("background subscribers handle events in order and are drained before turn.ended", async () => {
    const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* slowJournal(Option.none())
      const { model } = yield* scripted([])
      const Noted = defineHostEvent("item.noted", Schema.Struct({ n: Schema.Number }))
      const Handled = defineHostEvent("item.handled", Schema.Struct({ n: Schema.Number }))
      yield* agent.turn(inputFor({ stored: journal.stored, io: journal.io }, "run-1", "note", model), (turn) => Effect.gen(function* () {
        yield* Noted.on((item) => Effect.sleep("3 millis").pipe(Effect.zipRight(Handled.publish(turn.events, item))), { mode: "background" })(turn.events)
        yield* Effect.forEach([1, 2, 3], (n) => Noted.publish(turn.events, { n }), { discard: true })
        return yield* turn.reply("noted")
      }))
      return yield* Ref.get(journal.stored)
    })))
    const names = events.map((event) => event.name)
    expect(named(events, "item.handled").map((event) => event.data.n)).toEqual([1, 2, 3])
    expect(names.lastIndexOf("item.handled")).toBeLessThan(names.indexOf("turn.ended"))
    expect(names.at(-1)).toBe("turn.ended")
  })

  test("a journal that stops storing fails the turn with its error", async () => {
    const { exit, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define(memoryWindowPlugin)
      const journal = yield* slowJournal(Option.some("tool.completed"))
      const { model } = yield* scripted(lookupThenDeliver)
      const exit = yield* Effect.either(agent.turn(inputFor(journal, "run-1", "find alpha", model), answer()))
      return { exit, events: yield* Ref.get(journal.stored) }
    })))
    expect(exit._tag === "Left" ? exit.left.code : "none").toBe("journal.down")
    expect(named(events, "tool.completed")).toHaveLength(0)
    expect(named(events, "turn.ended")).toHaveLength(0)
  })

  test("swapping the memory strategy is one config entry", async () => {
    const { events, third } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define({ plugin: memorySummaryPlugin, options: { triggerRatio: 0.1, keepRatio: 0.05, cooldownTurns: 0 } }, { budgetTokens: 1_500 })
      const journal = yield* inMemoryJournal
      const utility = utilityText("SUMMARY of earlier turns")
      const turnWith = (runId: string, prompt: string, script: ReadonlyArray<Part>) => Effect.gen(function* () {
        const { seen, model } = yield* scripted(script)
        yield* agent.turn(inputFor(journal, runId, prompt, model, utility), answer())
        return yield* Ref.get(seen)
      })
      yield* turnWith("run-1", "find alpha", lookupThenDeliver)
      yield* turnWith("run-2", "find beta", [call("d1", "lookup", { query: "beta" }), call("d2", "load_skill", { skills: ["delivery"] }), call("d3", "deliver", { text: "record-beta-a" })])
      const third = yield* turnWith("run-3", "deliver gamma", [call("e1", "load_skill", { skills: ["delivery"] }), call("e2", "deliver", { text: "gamma" })])
      return { events: yield* Ref.get(journal.stored), third }
    })))
    expect(new Set(named(events, "context.built").map((event) => event.data.strategy))).toEqual(new Set(["summary"]))
    expect(third[0]!.prompt).toContain("SUMMARY of earlier turns")
  })

  test("a select digest keeps whole items, so the ids an answer cites survive", async () => {
    const { seen, entries } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const agent = yield* define({ plugin: memoryWindowPlugin, options: { digestOnWriteChars: 1 } }, { plugins: [memoryDigestPlugin], turnServices: [UtilityLlm] })
      const journal = yield* inMemoryJournal
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
      const journal = yield* inMemoryJournal
      const { model } = yield* scripted([])
      yield* Effect.forEach(["run-1", "run-2", "run-3"], (runId) => agent.turn(inputFor(journal, runId, "hi", model), (turn) => turn.reply("hello")))
      return { runtime: yield* Ref.get(runtimeBuilds), session: yield* Ref.get(sessionBuilds) }
    })))
    expect(counts).toEqual({ runtime: 1, session: 3 })
  })
})
