import { expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { join } from "node:path"
import { ConversationId, CurrentPromptCacheKey, defineContributions, defineHostEvent, defineSkill, defineTool, entriesOfPayload, Failure, HarnessError, IntentMatcher, LogEntry, onTool, RunContext, subscribeAll, UserMessage, UtilityCompletion, UtilityLlm, toolParametersSchema } from "@xandreed/core"
import type { EventBody, JournalIO, Turn, TurnEvent, TurnInput, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memoryLogPlugin } from "@xandreed/plugin-memory-log"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"
import { Tally } from "./testing.port.js"

/*
 * The golden pin of `Agent.turn`: one conversation of four turns (a tool call
 * with a digest, a skill activation and a system-prompt variant; a quick
 * reply with a host layer and a task; a failure; a matcher-seeded skill, a
 * planned batch and a forced tool choice) under a fixed clock. The journal
 * bytes, the memory log, the event order, the `context.built` fingerprints
 * and every model request are compared with `golden/agent-turn.json`.
 * Any composition of the turn must reproduce the file exactly.
 */

/* ── the host's definitions ── */

const Item = Schema.Struct({ id: Schema.String, detail: Schema.String })
export const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ items: Schema.Array(Item) }),
  failure: Failure,
  failureMode: "return",
})
export const Deliver = Tool.make("deliver", {
  description: "Deliver the final answer.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})
const Note = Tool.make("note", {
  description: "Take a note.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})

const found = (items: ReadonlyArray<typeof Item.Type>) => items.map((item) => `FOUND ${item.id}: ${item.detail}`).join("\n")

export const goldenHost = defineContributions({
  id: "golden-host", version: "1",
  tools: [
    defineTool({
      tool: Lookup,
      handler: ({ query }) => Effect.succeed({ items: ["a", "b", "c"].map((suffix) => ({ id: `record-${query}-${suffix}`, detail: `${query} ${suffix} `.repeat(12) })) }),
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
    defineTool({ tool: Note, handler: () => Effect.succeed(true) }),
  ],
  skills: [
    defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true }),
    defineSkill({ id: "delivery", summary: "Deliver a final answer.", instructions: "Deliver once, with the record id.", tools: ["deliver"] }),
    defineSkill({ id: "notes", summary: "Take notes.", instructions: "Note what the user asks to keep.", tools: ["note"] }),
  ],
  sections: [
    { id: "persona", version: "1", tier: "session", order: 0, render: () => Effect.succeed(Option.some("SESSION persona: a golden agent.")) },
    { id: "rules", version: "1", tier: "static", order: 5, render: () => Effect.succeed(Option.some("STATIC rules.")) },
    {
      id: "style", version: "1", tier: "static", order: 7,
      render: ({ variant }) => Effect.succeed(Option.some(Option.match(variant, { onNone: () => "STYLE plain.", onSome: (name) => `STYLE ${name}.` }))),
    },
    {
      id: "turn-note", version: "1", tier: "turn", order: 0,
      render: ({ active }) => Effect.succeed(Option.some(`TURN active: ${active.join(", ")}`)),
    },
  ],
})

/** The agent every composition of the golden conversation reproduces. */
export const goldenConfig: AgentConfig = {
  plugins: [memoryLogPlugin, { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 1 } }, toolDiscoveryPlugin, stepLoopPlugin, memoryDigestPlugin],
  contributions: [goldenHost],
  turnServices: [LanguageModel.LanguageModel, UtilityLlm],
  limits: { streaming: false, maxSteps: 6 },
  cacheKeyPrefix: "golden",
  system: "GOLDEN system prefix.",
}

/* ── a scripted provider that records every request, whole ── */

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

const encodePrompt = Schema.encodeSync(Prompt.Prompt)

const scripted = (requests: Ref.Ref<ReadonlyArray<unknown>>, runId: string, script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const cacheKey = yield* Effect.service(CurrentPromptCacheKey)
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      yield* Ref.update(requests, (all) => [...all, {
        runId,
        prompt: encodePrompt(options.prompt),
        tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })),
        toolChoice: options.toolChoice,
        responseFormat: options.responseFormat.type,
        cacheKey,
      }])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted") as never,
  })
})

/* ── the fixed clock: every timestamp and duration is the same in every run ── */

const epoch = 1_767_225_600_000
const realClock = Clock.Clock.defaultValue()
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => epoch,
  currentTimeMillis: Effect.succeed(epoch),
  currentTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  sleep: (duration) => realClock.sleep(duration),
}

/* ── the conversation ── */

const conversation = ConversationId.make("00000000-0000-4000-8000-00000000601d")
const digester = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "- record-alpha-b\nrecord-unknown", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })),
}))
const matcher = Context.make(IntentMatcher, IntentMatcher.of({
  id: "keyword", version: "1",
  match: ({ userMessage }) => Effect.succeed({
    skills: userMessage.text.includes("note") ? ["notes"] : [],
    probabilities: Option.some({ notes: userMessage.text.includes("note") ? 0.9 : 0.1 }),
    abstained: false,
  }),
}))

/** Build this turn's layer against the turn: it sees the memory as it stood before the user's message. */
const tallyLayer = Layer.effect(Tally, Effect.gen(function* () {
  const run = yield* RunContext
  const before = `layer saw turn ${yield* run.memory.turn} with ${(yield* run.memory.entries).length} entries`
  return { runId: run.runId, seen: yield* Ref.make<ReadonlyArray<string>>([before]) }
}))

const Prepared = defineHostEvent("note.prepared", Schema.Struct({ id: Schema.String }))

/** What one turn left: its outcome (or failure), the events its host saw and what the memory held. */
interface Observed {
  readonly runId: string
  readonly outcome: unknown
  readonly events: ReadonlyArray<string>
  readonly contextBuilt: ReadonlyArray<unknown>
  readonly entries: number
}

/**
 * The golden conversation over `runner` — anything that runs one admitted
 * turn the way `Agent.turn` does, acquired in the conversation's scope —
 * under the fixed clock: every turn, then the journal and the log.
 */
export const runGolden = (runner: Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope>) => Effect.scoped(Effect.gen(function* () {
  const agent = yield* runner
  const stored = yield* Ref.make<ReadonlyArray<EventBody>>([])
  const bytes = yield* Ref.make<ReadonlyArray<string>>([])
  const journal: JournalIO = {
    append: (event) => Ref.update(bytes, (all) => [...all, JSON.stringify(event)]).pipe(Effect.andThen(Ref.update(stored, (all) => [...all, event]))),
    read: (names) => Ref.get(stored).pipe(Effect.map((all) => all.filter((event) => names.length === 0 || names.includes(event.name)))),
  }
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
  const turns = yield* Ref.make<ReadonlyArray<Observed>>([])

  const input = (runId: string, text: string, model: LanguageModel.LanguageModel) => ({
    conversation, runId, userMessage: new UserMessage({ text }), journal,
    services: Context.merge(Context.merge(Context.make(LanguageModel.LanguageModel, model), digester), matcher),
  })

  /** Run one turn; its host subscribes to every event first and counts the memory it ends with. */
  const turnOf = <A, E>(turnInput: TurnInput<A, E>, use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, Scope.Scope | A>) => Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const built = yield* Ref.make<ReadonlyArray<unknown>>([])
    const entries = yield* Ref.make(0)
    const observed = (turn: Turn) => Effect.gen(function* () {
      yield* turn.events.subscribe(Option.some, (event: TurnEvent) => Effect.gen(function* () {
        yield* Ref.update(events, (all) => [...all, event._tag === "host" ? `host:${event.name}` : event._tag])
        if (event._tag === "context.built") yield* Ref.update(built, (all) => [...all, event])
      }))
      return yield* use(turn).pipe(Effect.ensuring(turn.memory.entries.pipe(Effect.flatMap((all) => Ref.set(entries, all.length)))))
    })
    const exit = yield* Effect.result(agent.turn(turnInput, observed))
    const recorded: Observed = {
      runId: turnInput.runId,
      outcome: exit._tag === "Success" ? exit.success : { failed: exit.failure instanceof HarnessError ? exit.failure.code : String(exit.failure) },
      events: yield* Ref.get(events),
      contextBuilt: yield* Ref.get(built),
      entries: yield* Ref.get(entries),
    }
    yield* Ref.update(turns, (all) => [...all, recorded])
  })

  /** Deliver through the loop: react to delivery, complete once delivered. */
  const answer = (policy: TurnPolicy) => (turn: Turn) => Effect.gen(function* () {
    const delivered = yield* Ref.make(Option.none<string>())
    yield* subscribeAll(turn.events, [onTool(Deliver, ({ input: params }) => Ref.set(delivered, Option.some(params.text)))])
    yield* turn.tools.select(turn.userMessage)
    const result = yield* turn.run({
      completion: () => Ref.get(delivered).pipe(Effect.map((text) => ({ complete: Option.isSome(text), awaiting: [], facts: {} }))),
      limits: { requireCompletion: true },
      ...policy,
    })
    return { outcome: result.outcome, reply: Option.orElse(yield* Ref.get(delivered), () => Option.some(result.text)) } satisfies TurnOutcome
  })

  // 1. A tool call whose long result is digested, a skill loaded by the model, and a system-prompt variant from step 2.
  const first = yield* scripted(requests, "run-1", [
    call("c1", "lookup", { query: "alpha" }),
    call("c2", "load_skill", { skills: ["delivery"] }),
    call("c3", "deliver", { text: "record-alpha-b" }),
  ])
  yield* turnOf(input("run-1", "find alpha", first), (turn) => Effect.gen(function* () {
    yield* turn.context({ id: "intent", version: "1", text: "INTENT: look a record up" })
    return yield* answer({
      model: (step) => Effect.succeed(step.stepIndex >= 2 ? Option.some({ model: first, variant: Option.some("brief") }) : Option.none()),
      step: (step) => Effect.succeed({ context: Option.some(`STEP ${step.stepIndex}`), toolChoice: Option.none() }),
    })(turn)
  }))

  // 2. A quick reply: the host layer is built against the turn, a task publishes and is joined, a store write runs in journal order.
  const second = yield* scripted(requests, "run-2", [])
  yield* turnOf({ ...input("run-2", "hello again", second), layer: tallyLayer }, (turn) => Effect.gen(function* () {
    const tally = yield* Tally
    yield* turn.tasks.fork("note", Prepared.publish(turn.events, { id: "n1" }))
    yield* turn.tasks.await(["note"])
    const written = yield* turn.write(Effect.succeed("written in order"))
    yield* turn.flush
    return yield* turn.reply([...(yield* Ref.get(tally.seen)), written, `turn ${turn.turn}`].join(" | "))
  }))

  // 3. A failure after some work: the turn fails with the host's error and records the failed outcome.
  const third = yield* scripted(requests, "run-3", [])
  yield* turnOf(input("run-3", "fail please", third), (turn) => Effect.gen(function* () {
    yield* turn.context({ id: "intent", version: "1", text: "INTENT: give up" })
    return yield* Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up" }))
  }))

  // 4. The matcher seeds a skill; a planned first batch; a forced tool choice.
  const fourth = yield* scripted(requests, "run-4", [call("e1", "note", { text: "gamma" }), call("e2", "deliver", { text: "record-gamma-a" })])
  yield* turnOf(input("run-4", "note gamma, then deliver it", fourth), answer({
    initial: { calls: [{ name: "lookup", params: { query: "gamma" } }], skills: [] },
    step: (step) => Effect.succeed({ context: Option.none(), toolChoice: step.stepIndex === 1 ? Option.some({ tool: "note" }) : Option.none() }),
  }))

  const all = yield* Ref.get(stored)
  const log = yield* Effect.forEach(all.filter((event) => event.name === "memory.entries"), (event) => entriesOfPayload(event.data))
  return {
    turns: yield* Ref.get(turns),
    journal: yield* Ref.get(bytes),
    log: Schema.encodeSync(Schema.Array(LogEntry))(log.flat()),
    requests: yield* Ref.get(requests),
  }
})).pipe(Effect.provideService(Clock.Clock, fixedClock))

const goldenPath = join(import.meta.dir, "../golden/agent-turn.json")

test("Agent.turn reproduces the golden conversation byte for byte", async () => {
  const actual = JSON.parse(JSON.stringify(await Effect.runPromise(runGolden(Agent.define(goldenConfig)))))
  if (process.env.EFFERENT_UPDATE_GOLDEN === "1") await Bun.write(goldenPath, `${JSON.stringify(actual, null, 2)}\n`)
  const golden = await Bun.file(goldenPath).json()
  expect(actual).toEqual(golden)
})
