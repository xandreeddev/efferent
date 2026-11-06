import { describe, expect, test } from "bun:test"
import { Context, Deferred, Duration, Effect, Fiber, Layer, Match, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool as AiTool } from "effect/ai"
import { publishToolProgress, SessionChannel, shareTransient } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { PrincipalId, RenderFeed, RenderFeedLive, SessionsJournalTailLive, sessionLive, ThreadId } from "@xandreed/plugin-render"
import type { FeedFrame, FeedProjection, SnapshotFold } from "@xandreed/plugin-render"
import { makeMemorySessionChannel, SessionsPluginLive } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import {
  Agent,
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/sdk"
import type { SessionAddress, Turn } from "@xandreed/sdk"

/*
 * A key-free journey across the agent loop, sessions and the render feed:
 * one request runs a turn in the background and shares its transient
 * events with the session's channel; another request, which never touched
 * the turn, follows the session through a render feed whose `live` stream
 * is that channel. It sees the reply as it streams and the tool's progress
 * beside the journal's records; a client that reconnects gets only what the
 * journal kept.
 */

const usage = { inputTokens: { total: 20 }, outputTokens: { total: 5 } }
type Part = Readonly<Record<string, unknown>>
const says = (text: string): ReadonlyArray<Part> => [
  { type: "text-start", id: "t" },
  ...[text.slice(0, 4), text.slice(4, 9), text.slice(9)].map((delta) => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage },
]
const calls = (id: string, name: string, params: unknown): ReadonlyArray<Part> => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]

/** A streaming provider answering the script's responses in order. */
const scripted = (script: ReadonlyArray<ReadonlyArray<Part>>) => Effect.gen(function* () {
  const count = yield* Ref.make(0)
  const next = Ref.getAndUpdate(count, (n) => n + 1).pipe(Effect.map((n) => script[n] ?? says("done")))
  return yield* LanguageModel.make({
    generateText: () => Effect.die("this journey streams every step"),
    streamText: () => Stream.unwrap(next.pipe(Effect.map((parts) => Stream.fromIterable(parts)))) as never,
  })
})

const Count = AiTool.make("count", {
  description: "Count the records.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ counted: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})
const counting = defineCapability({
  id: "session-channel-journey", version: "1",
  tools: [defineTool({ tool: Count, handler: () => publishToolProgress("status", "counting 3 records").pipe(Effect.as({ counted: 3 })), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "count", summary: "Count records.", tools: ["count"], always: true })],
})

const address: SessionAddress = { id: ConversationId.make("00000000-0000-4000-8000-0000000000c3"), owner: "user-1" }
const scope = { threadId: ThreadId.make(address.id), principalId: PrincipalId.make(address.owner) }
/** Every record as it is stored. */
const asStored: FeedProjection = (record) => Effect.succeed(Option.some({ event: record.kind, data: record.data }))
const quickFeed = { pollMs: 10, maxPollMs: 40, heartbeatMs: 10_000, maxDurationMs: 5_000 }

/** A frame as the assertions read it: a record's event, a transient frame's after `~`, else its tag. */
const named = (frame: FeedFrame): string => Match.valueTags(frame, {
  FeedRecord: (record) => record.event,
  FeedTransient: (live) => `~${live.event}`,
  FeedReady: () => "FeedReady",
  FeedHeartbeat: () => "FeedHeartbeat",
})
const isEnded = (frame: FeedFrame) => frame._tag === "FeedRecord" && frame.event === "turn.ended"

/** Read `value` until `holds`, sleeping in between, at most `tries` times. */
const until = <A>(value: Effect.Effect<A>, holds: (a: A) => boolean, tries = 200): Effect.Effect<A> => value.pipe(
  Effect.flatMap((now) => holds(now) || tries <= 0 ? Effect.succeed(now)
    : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(Effect.suspend(() => until(value, holds, tries - 1))))))

const host = Effect.gen(function* () {
  const sessionsContext = yield* Layer.build(SessionsPluginLive({}).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))
  const { channel, retained } = yield* makeMemorySessionChannel({ capacity: 64 })
  const services = Context.add(sessionsContext, SessionChannel, channel)
  const agent = yield* Agent.define({
    services,
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [counting],
    turnServices: [LanguageModel.LanguageModel],
  })
  const feed = Context.get(yield* Layer.build(RenderFeedLive(quickFeed).pipe(Layer.provide(SessionsJournalTailLive()), Layer.provide(Layer.succeedContext(services)))), RenderFeed)
  const sessions = Context.get(services, Sessions)
  yield* sessions.create({ owner: address.owner, id: address.id })
  /** A follower's request: the session's journal from `after`, and its channel as the feed's live frames. */
  const follow = (after: number) => sessionLive(scope).pipe(
    Effect.map((live) => feed.frames(scope, after, asStored, { live })),
    Effect.provideService(SessionChannel, channel),
  )
  /** A cold follower's request: the journal folded up to the session's `seq` as it connects, then what follows, with the channel's live frames. */
  const followCold = (fold: SnapshotFold) => Effect.all([sessionLive(scope), sessions.get(address)], { concurrency: 1 }).pipe(
    Effect.map(([live, view]) => feed.frames(scope, 0, asStored, { live, snapshot: { head: view.seq, fold } })),
    Effect.provideService(SessionChannel, channel),
  )
  return { agent, sessions, channel, retained, follow, followCold }
})

/** `use` for the background turn: its transient events go to the session's channel, then a preview of the host's own, then the run. */
const sharing = (channel: SessionChannel["Service"]) => (turn: Turn) => Effect.gen(function* () {
  yield* subscribeAll(turn.events, [shareTransient(address)])
  yield* channel.publish(address, { event: "app.preview", data: { stage: "drafting" } }).pipe(Effect.orDie)
  yield* turn.tools.select(turn.userMessage)
  const result = yield* turn.run({})
  return { outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text) }
}).pipe(Effect.provideService(SessionChannel, channel))

describe("a session's transient events reach every follower", () => {
  test("a turn run in the background streams to a feed another request opened; a reconnect gets only journaled records", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { agent, sessions, channel, retained, follow } = yield* host
    const model = yield* scripted([calls("c1", "count", {}), says("Counted three records.")])

    // The follower's request opens its feed before any turn, and reads it until the turn has ended.
    const seen = yield* Ref.make<ReadonlyArray<FeedFrame>>([])
    const following = yield* (yield* follow(0)).pipe(
      Stream.tap((frame) => Ref.update(seen, (all) => [...all, frame])),
      Stream.takeUntil(isEnded),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* until(Effect.all([Ref.get(seen), retained], { concurrency: 1 }), ([frames, held]) => frames.some((frame) => frame._tag === "FeedReady") && held === 1)

    // Another request runs the turn in the background.
    const turn = yield* Effect.forkChild(agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: "count the records" }), runId: RunId.make("run-channel-1") },
      services: Context.make(LanguageModel.LanguageModel, model),
    }, sharing(channel)))
    const result = yield* Fiber.join(turn)
    expect(result.outcome).toBe("completed")

    const frames = yield* Fiber.join(following)
    const names = frames.map(named)
    // Live frames come only after the backlog's ready frame, and the journal's records keep their own order.
    expect(names.indexOf("FeedReady")).toBeLessThan(names.findIndex((name) => name.startsWith("~")))
    expect(names.filter((name) => name.startsWith("~"))).toEqual([
      "~app.preview", "~tool.progress", "~assistant.delta", "~assistant.delta", "~assistant.delta",
    ])
    const transient = frames.flatMap((frame) => frame._tag === "FeedTransient" ? [frame] : [])
    expect(transient.find((frame) => frame.event === "tool.progress")?.data).toMatchObject({ tool: "count", channel: "status", text: "counting 3 records" })
    expect(transient.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.delta).join("")).toBe("Counted three records.")
    expect(result.reply).toEqual(Option.some("Counted three records."))

    // The journal stores none of it; a client that reconnects, from the start or from its last cursor, gets only records.
    const stored = yield* sessions.read(address)
    expect(stored.some((event) => ["assistant.delta", "tool.progress", "app.preview"].includes(event.kind))).toBe(false)
    const records = frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame] : [])
    const reconnect = (after: number) => follow(after).pipe(Effect.flatMap((stream) => stream.pipe(Stream.takeUntil((frame) => frame._tag === "FeedReady"), Stream.runCollect)))
    const fromStart = yield* reconnect(0)
    expect(fromStart.map(named)).toEqual([...records.map(named), "FeedReady"])
    expect(fromStart.filter((frame) => frame._tag === "FeedRecord")).toEqual(records)
    const cursor = records[1]?.sequence ?? 0
    const fromCursor = yield* reconnect(cursor)
    expect(fromCursor.map(named)).toEqual([...records.filter((record) => record.sequence > cursor).map(named), "FeedReady"])

    // Every follower has left: the channel holds nothing for the session.
    expect(yield* until(retained, (held) => held === 0)).toBe(0)
  }))), 20_000)

  test("a cold client that connects mid-turn gets the snapshot, then that turn's transient events after ready", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { agent, channel, followCold } = yield* host
    // The reply's step waits at `gate` until the cold client is folding its snapshot; `midTurn` says the turn has reached it.
    const midTurn = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const steps = yield* Ref.make(0)
    const script = [calls("c1", "count", {}), says("Counted three records.")]
    const model = yield* LanguageModel.make({
      generateText: () => Effect.die("this journey streams every step"),
      streamText: () => Stream.unwrap(Ref.getAndUpdate(steps, (n) => n + 1).pipe(Effect.flatMap((n) => n === 0
        ? Effect.succeed(Stream.fromIterable(script[0] ?? []))
        : Deferred.succeed(midTurn, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(Stream.fromIterable(script[1] ?? []))))) as never),
    })

    const turn = yield* Effect.forkChild(agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: "count the records" }), runId: RunId.make("run-channel-cold") },
      services: Context.make(LanguageModel.LanguageModel, model),
    }, sharing(channel)))
    yield* Deferred.await(midTurn)

    // The fold lets the turn stream its reply and waits for the turn to end: every delta is published while the snapshot is folded.
    const fold: SnapshotFold = (records) => Deferred.succeed(gate, undefined).pipe(
      Effect.andThen(Fiber.await(turn)),
      Effect.as({ event: "snapshot", data: { kinds: records.map((record) => record.kind) } }))
    const frames = Array.from(yield* (yield* followCold(fold)).pipe(
      Stream.takeUntil((frame) => frame._tag === "FeedTransient" && frame.event === "app.done"),
      Stream.tap((frame) => frame._tag === "FeedReady" ? channel.publish(address, { event: "app.done", data: {} }).pipe(Effect.orDie) : Effect.void),
      Stream.runCollect,
    ))
    const result = yield* Fiber.join(turn)
    expect(result.outcome).toBe("completed")

    const names = frames.map(named)
    const snapshot = frames[0]
    expect(snapshot?._tag === "FeedRecord" && snapshot.event === "snapshot").toBe(true)
    // What the turn shared before the client connected is not replayed; what it shared while the snapshot was folded follows the ready frame, in order.
    expect(names.slice(names.indexOf("FeedReady") + 1)).toEqual(["~assistant.delta", "~assistant.delta", "~assistant.delta", "~app.done"])
    expect(names.slice(1, names.indexOf("FeedReady"))).toContain("turn.ended")
    const deltas = frames.flatMap((frame) => frame._tag === "FeedTransient" && frame.event === "assistant.delta" ? [frame.data.delta] : [])
    expect(deltas.join("")).toBe("Counted three records.")
  }))), 20_000)
})
