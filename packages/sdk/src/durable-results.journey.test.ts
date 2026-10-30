import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import type { Response } from "effect/ai"
import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  entriesOfEvents,
  Failure,
  harnessCodeOf,
  HarnessError,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  StepEndedEvent,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { SessionAddress, SessionLogEvent, Turn } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

const Probe = Tool.make("durable_probe", {
  description: "Return a sequence number.",
  parameters: Schema.Struct({ n: Schema.Number }),
  success: Schema.Number,
  failure: Failure,
  failureMode: "return",
})
const usage = { inputTokens: { total: 2 }, outputTokens: { total: 1 } }
const call = (id: string, n: number): ReadonlyArray<Response.PartEncoded> => [
  { type: "tool-call", id, name: Probe.name, params: { n }, providerExecuted: false },
  { type: "finish", reason: "tool-calls", usage },
]

/** A fresh in-memory session and the real sessions service for each journey. */
const sessionsFor = (id: string) => Effect.gen(function* () {
  const services = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
  ))
  const sessions = Context.get(services, Sessions)
  const address: SessionAddress = { owner: "durable-results-journey", id: ConversationId.make(id) }
  yield* sessions.create(address)
  return { sessions, address }
})

const agentWith = (handle: (n: number) => Effect.Effect<number>) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities: [defineCapability({
    id: "durable-results-journey", version: "1",
    tools: [defineTool({ tool: Probe, handler: ({ n }) => handle(n), annotations: { readOnly: true } })],
    skills: [defineSkill({ id: "durable-results", summary: "Report sequence numbers.", tools: [Probe.name], always: true })],
  })],
  turnServices: [LanguageModel.LanguageModel],
  limits: { streaming: false, maxSteps: 1 },
})

/** The scripted provider records the exact prompt from each real dispatch. */
const modelOf = (reply: (prompt: string, index: number) => ReadonlyArray<Response.PartEncoded>) => Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => {
      const prompt = JSON.stringify(options.prompt.content)
      return Ref.modify(requests, (all): readonly [number, ReadonlyArray<string>] => [all.length, [...all, prompt]]).pipe(
        Effect.map((index) => [...reply(prompt, index)]),
      )
    },
    streamText: () => Stream.die("not scripted"),
  })
  return { model, requests: Ref.get(requests) }
})

const endedSteps = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events.filter((event) => event.kind === "step.ended"),
  (event) => Schema.decodeUnknownEffect(StepEndedEvent)({ _tag: "step.ended", ...event.data }), { concurrency: 1 })
const runToCap = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({})), Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })),
)

describe("journey: durable tool results", () => {
  test("concurrent runs of one turn list exactly their own durable results even when the provider reuses a call id", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, address } = yield* sessionsFor("00000000-0000-4000-8000-000000005510")
      const secondStarted = yield* Deferred.make<void>()
      const agent = yield* agentWith((n) => (n === 1 ? Deferred.await(secondStarted) : Deferred.succeed(secondStarted, undefined)).pipe(Effect.as(n)))
      const provider = yield* modelOf((prompt) => call("shared-call", prompt.includes("Run marker alpha") ? 1 : 2))
      const result = yield* agent.turn({
        turn: { session: address, userMessage: new UserMessage({ text: "run both probes" }), runId: RunId.make("parallel-runs") },
        services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, provider.model)),
      }, (turn) => Effect.gen(function* () {
        yield* turn.tools.select(turn.userMessage)
        yield* Effect.all(["alpha", "beta"].map((name) => turn.run({
          step: () => Effect.succeed({ context: Option.some(`Run marker ${name}`), toolChoice: Option.none() }),
        })), { concurrency: 2 })
        return { outcome: "partial" as const, reply: Option.none() }
      }))
      const events = yield* sessions.read(address)
      return { result, requests: yield* provider.requests, entries: yield* entriesOfEvents(events), ended: yield* endedSteps(events) }
    })))

    expect(observed.result.outcome).toBe("partial")
    expect(observed.requests).toHaveLength(2)
    expect(observed.requests.filter((prompt) => prompt.includes("Run marker alpha"))).toHaveLength(1)
    expect(observed.requests.filter((prompt) => prompt.includes("Run marker beta"))).toHaveLength(1)
    const raw = observed.entries.flatMap((entry) => entry.body._tag === "ToolResult"
      ? [{ entry: String(entry.id), run: Number(entry.body.run), call: String(entry.body.toolCallId), encoded: entry.body.encoded }] : [])
      .toSorted((left, right) => left.run - right.run)
    expect(raw.map(({ run, call, encoded }) => ({ run, call, encoded }))).toEqual([
      { run: 0, call: "shared-call", encoded: 1 }, { run: 1, call: "shared-call", encoded: 2 },
    ])
    expect(observed.ended.toSorted((left, right) => left.run - right.run).map((step) => ({
      run: Number(step.run), status: step.status, step: step.step,
      results: step.results.map((result) => ({ entry: String(result.entry), call: String(result.toolCallId), ok: result.ok })),
    }))).toEqual(raw.map((entry) => ({
      run: entry.run, status: "completed", step: 0, results: [{ entry: entry.entry, call: entry.call, ok: true }],
    })))
  })

  test("a raw commit whose acknowledgement fails remains on the failed step, and its entry id is never reused", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, address } = yield* sessionsFor("00000000-0000-4000-8000-000000005511")
      const armed = yield* Ref.make(true)
      const lostAt = yield* Ref.make(0)
      // The real writer commits first. Only its host-facing acknowledgement fails once;
      // later snapshots can still read the committed value and the failed turn can close.
      const acknowledgementLost = Sessions.of({
        ...sessions,
        begin: (session, input) => sessions.begin(session, input).pipe(Effect.map((writer) => ({
          ...writer,
          flush: writer.flush.pipe(
            Effect.andThen(writer.snapshot(["memory.tool-result"])),
            Effect.flatMap((stored) => stored.length === 0 ? Effect.void : Ref.getAndSet(armed, false).pipe(
              Effect.flatMap((fail) => !fail ? Effect.void : Ref.set(lostAt, stored[0]!.seq).pipe(
                Effect.andThen(Effect.fail(new HarnessError({ code: "test.after_commit", message: "the flush acknowledgement failed after the raw result committed" }))),
              )),
            )),
          ),
        }))),
      })
      const agent = yield* agentWith((n) => Effect.succeed(n))
      const provider = yield* modelOf(() => call("committed-call", 9))
      const result = yield* Effect.exit(agent.turn({
        turn: { session: address, userMessage: new UserMessage({ text: "return one probe" }), runId: RunId.make("lost-ack") },
        services: Context.merge(Context.make(Sessions, acknowledgementLost), Context.make(LanguageModel.LanguageModel, provider.model)),
      }, runToCap))
      const events = yield* sessions.read(address)
      return { result, lostAt: yield* Ref.get(lostAt), events, entries: yield* entriesOfEvents(events), ended: yield* endedSteps(events), requests: yield* provider.requests }
    })))

    expect(Option.flatMap(Exit.findErrorOption(observed.result), harnessCodeOf)).toEqual(Option.some("test.after_commit"))
    expect(observed.requests).toHaveLength(1)
    const rawEvent = observed.events.find((event) => event.kind === "memory.tool-result")
    expect(observed.lostAt).toBe(rawEvent?.seq ?? -1)
    const raw = observed.entries.filter((entry) => entry.body._tag === "ToolResult")
    expect(raw).toHaveLength(1)
    expect(raw[0]?.body._tag === "ToolResult" ? { encoded: raw[0].body.encoded, call: String(raw[0].body.toolCallId), run: Number(raw[0].body.run) } : null)
      .toEqual({ encoded: 9, call: "committed-call", run: 0 })
    expect(observed.ended.map((step) => ({ status: step.status, results: step.results.map((result) => ({ entry: String(result.entry), call: String(result.toolCallId), ok: result.ok })) })))
      .toEqual([{ status: "failed", results: [{ entry: String(raw[0]?.id), call: "committed-call", ok: true }] }])
    const ids = observed.entries.map((entry) => String(entry.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(observed.events.at(-1)?.kind).toBe("turn.ended")
    expect(observed.events.at(-1)?.data.reason).toBe("failed")
  })
})
