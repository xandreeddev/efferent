import { Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import {
  ConversationId,
  defineCapability,
  defineHostEvent,
  defineSkill,
  defineTool,
  Failure,
  HarnessError,
  IntentMatcher,
  onTool,
  RESERVED_KINDS,
  SessionHeader,
  SessionLogEvent,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  TaskExecutor,
  TaskRunner,
  Tasks,
  TurnAdmissionOpen,
  UserMessage,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { SessionAddress, Turn, TurnError, TurnOutcome, TurnPolicy } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { TasksLive, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

/*
 * Records one session journal as the current code writes it, for the
 * journal compatibility test (`packages/sdk/src/journal-compat.test.ts`):
 * later releases must still read what this release stored. The recording is
 * deterministic: a scripted model, a fixed clock, and ids minted from a
 * counter (`crypto.randomUUID` is replaced for this process), so it holds no
 * time, path or machine of the recording.
 *
 * It writes `packages/sdk/fixtures/journal-<version>.json`, the version being
 * the packages' shared one, with the kinds that version reserves; the
 * compatibility test reads every fixture in that folder. It refuses to
 * replace an existing fixture: a fixture is what a released version wrote,
 * so record it once, from that release's code. `--force` rewrites it, only
 * for re-recording the current, unreleased version.
 *
 * Coverage: four agent turns (a digested tool result, a loaded skill, step
 * context, a system variant and a stream that falls back; a quick reply with
 * a host event; a failure; a matcher-seeded skill, a planned batch, a call
 * the registry refuses and a compaction), an inbox item
 * whose turns fail until it is dropped, a background task that completes and
 * is delivered to the inbox, and one that is cancelled before it runs.
 */

const root = join(import.meta.dir, "..")
const version = (JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8")) as { readonly version: string }).version
const target = join(root, "packages/sdk/fixtures", `journal-${version}.json`)
if (existsSync(target) && !process.argv.includes("--force")) {
  console.error(`${relative(root, target)} exists: a fixture records what a release wrote. Pass --force to record it again.`)
  process.exit(1)
}

/* ── fixed ids and time ── */

const minted = { count: 0 }
const fixedId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  writable: true,
  value: () => fixedId(0x100 + ++minted.count),
})

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

/* ── the host's definitions ── */

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
const Note = Tool.make("note", {
  description: "Take a note.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})

const found = (items: ReadonlyArray<typeof Item.Type>) => items.map((item) => `FOUND ${item.id}: ${item.detail}`).join("\n")

const host = defineCapability({
  id: "fixture-host", version: "1",
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
    // Once per turn: a second call is refused (`tool.refused`).
    defineTool({ tool: Note, handler: () => Effect.succeed(true), annotations: { maxCallsPerRun: Option.some(1) } }),
  ],
  skills: [
    defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true }),
    defineSkill({ id: "delivery", summary: "Deliver a final answer.", instructions: "Deliver once, with the record id.", tools: ["deliver"] }),
    defineSkill({ id: "notes", summary: "Take notes.", instructions: "Note what the user asks to keep.", tools: ["note"] }),
  ],
  promptSections: [
    { id: "persona", version: "1", tier: "session", order: 0, render: () => Effect.succeed(Option.some("SESSION persona: a fixture agent.")) },
    { id: "rules", version: "1", tier: "static", order: 5, render: () => Effect.succeed(Option.some("STATIC rules.")) },
    {
      id: "style", version: "1", tier: "static", order: 7,
      render: ({ variant }) => Effect.succeed(Option.some(Option.match(variant, { onNone: () => "STYLE plain.", onSome: (name) => `STYLE ${name}.` }))),
    },
    { id: "turn-note", version: "1", tier: "turn", order: 0, render: ({ active }) => Effect.succeed(Option.some(`TURN active: ${active.join(", ")}`)) },
  ],
})

const Prepared = defineHostEvent("note.prepared", Schema.Struct({ id: Schema.String }))

/* ── a scripted provider ── */

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: () => Ref.getAndUpdate(served, (value) => value + 1).pipe(Effect.map((index) => (script[index] ?? stop("done")) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
})

const digester = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "- record-alpha-b\nrecord-unknown", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })),
}))
const matcher = Context.make(IntentMatcher, IntentMatcher.of({
  id: "keyword", version: "1",
  match: ({ userMessage }) => Effect.succeed({
    skills: userMessage.text.includes("note") ? ["notes"] : [],
    probabilities: Option.some({ notes: userMessage.text.includes("note") ? 0.9 : 0.1 }),
    abstained: false,
  }),
}))

/** Background work runs when the recording says so: one task runs, the other is cancelled first. */
const queued = Effect.runSync(Ref.make<ReadonlyArray<(deadline: Option.Option<number>) => Effect.Effect<void>>>([]))
const runner = Layer.succeed(TaskRunner, TaskRunner.of({ run: (work) => Ref.update(queued, (all) => [...all, work]) }))
const runQueued = Ref.getAndSet(queued, []).pipe(Effect.flatMap((works) => Effect.forEach(works, (work) => work(Option.none()), { discard: true })))
const executor = Layer.succeed(TaskExecutor, TaskExecutor.of({
  turn: (_writer, task) => Effect.succeed({ outcome: "completed" as const, reply: Option.some(`found ${task.instructions}`) }),
  react: () => Effect.void,
}))

/* ── the recording ── */

const conversation = ConversationId.make(fixedId(0x601d))
const completedTask = ConversationId.make(fixedId(0x7a51))
const cancelledTask = ConversationId.make(fixedId(0x7a52))

const record = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const tasks = Context.get(yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sessions, sessions), runner, executor)))), Tasks)
  const agent = yield* Agent.define({
    plugins: [{ plugin: memoryWindowPlugin, options: { digestOnWriteChars: 1 } }, toolDiscoveryPlugin, stepLoopPlugin, memoryDigestPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel, UtilityLlm],
    limits: { streaming: false, maxSteps: 6 },
    cacheKeyPrefix: "fixture",
    system: "FIXTURE system prefix.",
  })
  const address: SessionAddress = { id: conversation, owner: "fixture" }
  yield* sessions.create({ owner: address.owner, id: conversation, meta: { recorded: version } })

  const input = (runId: string, text: string, model: LanguageModel.LanguageModel, extra?: { readonly key: string; readonly command: Readonly<Record<string, unknown>> }) => ({
    turn: { session: address, userMessage: new UserMessage({ text }), runId, ...extra },
    services: Context.merge(Context.merge(Context.merge(Context.make(LanguageModel.LanguageModel, model), digester), matcher), Context.make(Sessions, sessions)),
  })
  const turnOf = (turnInput: ReturnType<typeof input>, use: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, Scope.Scope>) =>
    Effect.exit(agent.turn(turnInput, use))

  /** Deliver through the loop: complete once delivered. */
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

  // 1. A digested tool result, a skill the model loads, step context, and a system variant from step 2;
  // the model does not stream, so the first step falls back (`stream.fallback`).
  const first = yield* scripted([call("c1", "lookup", { query: "alpha" }), call("c2", "load_skill", { skills: ["delivery"] }), call("c3", "deliver", { text: "record-alpha-b" })])
  yield* turnOf(input("run-1", "find alpha", first, { key: "client-command-1", command: { source: "fixture" } }), (turn) => Effect.gen(function* () {
    yield* turn.context({ id: "intent", version: "1", text: "INTENT: look a record up" })
    return yield* answer({
      model: (step) => Effect.succeed(step.stepIndex >= 2 ? Option.some({ model: first, variant: Option.some("brief") }) : Option.none()),
      step: (step) => Effect.succeed({ context: Option.some(`STEP ${step.stepIndex}`), toolChoice: Option.none() }),
      limits: { requireCompletion: true, streaming: true },
    })(turn)
  }))

  // 2. A quick reply; a task publishes a host event.
  yield* turnOf(input("run-2", "hello again", yield* scripted([])), (turn) => Effect.gen(function* () {
    yield* turn.tasks.fork("note", Prepared.publish(turn.events, { id: "n1" }))
    yield* turn.tasks.await(["note"])
    return yield* turn.reply(`turn ${turn.turn} noted`)
  }))

  // 3. A failure after some work.
  yield* turnOf(input("run-3", "fail please", yield* scripted([])), (turn) => Effect.gen(function* () {
    yield* turn.context({ id: "intent", version: "1", text: "INTENT: give up" })
    return yield* Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up" }))
  }))

  // 4. The matcher seeds a skill (a decision), a planned first batch, a forced tool choice and a second note the
  // registry refuses; the earlier lookup is compacted.
  const twoNotes: Part = [
    { type: "tool-call", id: "e1", name: "note", params: { text: "gamma" } },
    { type: "tool-call", id: "e1b", name: "note", params: { text: "gamma again" } },
    { type: "finish", reason: "tool-calls", usage },
  ]
  const fourth = yield* scripted([twoNotes, call("e2", "deliver", { text: "record-gamma-a" })])
  yield* turnOf(input("run-4", "note gamma, then deliver it", fourth), answer({
    initial: { calls: [{ name: "lookup", params: { query: "gamma" } }], skills: [] },
    step: (step) => Effect.succeed({ context: Option.none(), toolChoice: step.stepIndex === 1 ? Option.some({ tool: "note" }) : Option.none() }),
  }))

  // 5. An inbox item whose turns fail: dropped after the configured attempts.
  yield* sessions.deliver(address, { id: "reminder-1", source: { kind: "host", channel: "fixture" }, content: "Remind the user about record-alpha-b." })
  yield* sessions.drain(address, () => Effect.fail(new HarnessError({ code: "host.unavailable", message: "the reminder could not be handled" })))

  // 6. A background task that completes: its result is delivered to the inbox and the parent reacts.
  yield* tasks.start(address, { taskId: completedTask, instructions: "find beta", mode: "fork", meta: { runId: "run-4" } })
  yield* runQueued

  // 7. A background task cancelled before it runs.
  yield* tasks.start(address, { taskId: cancelledTask, instructions: "find delta", mode: "spawn" })
  yield* tasks.cancel(address, cancelledTask)
  yield* runQueued

  const journal = (session: SessionAddress) => Effect.gen(function* () {
    const view = yield* sessions.get(session)
    const events = yield* sessions.read(session)
    return { header: Schema.encodeSync(SessionHeader)(view.header), events: Schema.encodeSync(Schema.Array(SessionLogEvent))(events) }
  })
  return yield* Effect.forEach([address, { id: completedTask, owner: address.owner }, { id: cancelledTask, owner: address.owner }], journal)
}).pipe(Effect.scoped, Effect.provideService(Clock.Clock, fixedClock))

const sessions = await Effect.runPromise(record)
const fixture = {
  format: 1,
  version,
  description: "Session journals as this version stores them, recorded by scripts/record-journal-fixture.ts. Later versions must read them.",
  /** The kinds this version reserved: the recording holds each, and later versions must keep them reserved. */
  reserved: RESERVED_KINDS,
  sessions,
}
const text = `${JSON.stringify(fixture, null, 2)}\n`
if (/\/home\/|\/Users\/|[A-Z]:\\\\/.test(text)) {
  console.error("The recording holds an absolute path; nothing was written.")
  process.exit(1)
}
await mkdir(join(target, ".."), { recursive: true })
await writeFile(target, text)
const kinds = new Set(sessions.flatMap((session) => session.events.map((event) => event.kind)))
console.log(`Recorded ${sessions.reduce((sum, session) => sum + session.events.length, 0)} events of ${kinds.size} kinds in ${sessions.length} sessions to ${relative(root, target)}`)
