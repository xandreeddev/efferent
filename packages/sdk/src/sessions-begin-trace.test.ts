import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Tracer } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { RunId, SessionLog, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { BeginTurn, SessionAddress, SessionLogEvent } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { traceTurnBegin } from "./turn/turn-lifecycle.usecase.functions.js"

/*
 * The sessions plugin's spans under a begin traced as `Agent.turn` traces it
 * (`traceTurnBegin`, `agent.turn.begin`): the begin holds only its own work,
 * and the writer's commits nest under the calls that asked for them. The
 * plugin's other spans and log annotations are tested in the plugin.
 */

type Log = Context.Service.Shape<typeof SessionLog>
type Service = Context.Service.Shape<typeof Sessions>

const owner = "owner-1"
const say = (text: string): BeginTurn =>
  ({ _tag: "User", userMessage: new UserMessage({ text }), runId: RunId.make(`run-${text}`), key: text, command: {} })

/** Sessions instances over one shared log: as if on several servers. */
const instancesOver = (log: Log, ...configs: ReadonlyArray<SessionsConfig>) => Effect.forEach(configs, (config) =>
  Effect.service(Sessions).pipe(Effect.provide(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))))

const withLog = <A, E>(body: (log: Log) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive), Effect.flatMap(body))).pipe(Effect.provide(TestClock.layer())))

const created = (sessions: Service) => sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
const kinds = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`)
const all = (sessions: Service, address: SessionAddress) => sessions.read(address).pipe(Effect.map(kinds))

describe("a traced begin over the sessions plugin", () => {
  /** A tracer keeping every span it starts, in the order they start. */
  const capturing = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  /** A span's ancestors among the kept spans, nearest first. */
  const ancestors = (spans: ReadonlyArray<Tracer.NativeSpan>, span: Tracer.NativeSpan): ReadonlyArray<string> => Option.match(
    Option.flatMap(span.parent, (parent) => Option.fromNullishOr(spans.find((candidate) => candidate.spanId === parent.spanId))),
    { onNone: () => [], onSome: (parent) => [parent.name, ...ancestors(spans, parent)] },
  )
  const ids = ["efferent.session.id", "efferent.run.id", "efferent.turn"]
  const read = (span: Tracer.NativeSpan, keys: ReadonlyArray<string>) => keys.map((key) => span.attributes.get(key))

  test("the writer's commits are turn_writer.commit spans under the call that asked for them, not under the begin; they, flush and end carry the turn's ids, as do the log's spans under a commit", () => withLog((inner) => Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = []
    // A log whose commit opens a span of its own, as a store's would.
    const log = SessionLog.of({ ...inner, commit: (id, commit) => inner.commit(id, commit).pipe(Effect.withSpan("store.commit")) })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions!.begin(address, say("hello")).pipe(traceTurnBegin({ session: address.id, runId: RunId.make("run-hello"), origin: "user" }))
      yield* Effect.gen(function* () {
        yield* writer.append([{ kind: "note", data: { n: 1 } }]).pipe(Effect.withSpan("host.step"))
        yield* writer.flush
        yield* writer.end({ reason: "completed", failure: Option.none() })
      }).pipe(Effect.withSpan("host.turn"))
    })).pipe(Effect.withSpan("host.request"), Effect.withTracer(capturing(spans)))
    const begin = spans.filter((span) => ancestors(spans, span).includes("agent.turn.begin"))
    // The begin holds only its own work: its reads of the log and the opening commit.
    expect(begin.map((span) => [span.name, ancestors(spans, span)[0]])).toEqual([
      ["sessions.begin", "agent.turn.begin"],
      ["session_log.head", "sessions.begin"],
      ["session_log.read", "sessions.begin"],
      ["session_log.read", "sessions.begin"],
      ["store.commit", "sessions.begin"],
      ["session_log.commit", "store.commit"],
    ])
    // By name and parent: the writer's fiber runs a commit after the call that queued it may have moved on.
    const writes = spans.filter((span) => span.name.startsWith("turn_writer.") || (span.name === "store.commit" && !begin.includes(span)))
      .map((span) => [span.name, ancestors(spans, span).slice(0, 2).join(" < "), ...read(span, ids)])
    expect(writes.toSorted((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)).toEqual([
      ["store.commit", "turn_writer.commit < host.step", address.id, "run-hello", 1],
      ["store.commit", "turn_writer.commit < turn_writer.end", address.id, "run-hello", 1],
      ["turn_writer.commit", "host.step < host.turn", address.id, "run-hello", 1],
      ["turn_writer.commit", "turn_writer.end < host.turn", address.id, "run-hello", 1],
      ["turn_writer.end", "host.turn < host.request", address.id, "run-hello", 1],
      ["turn_writer.flush", "host.turn < host.request", address.id, "run-hello", 1],
    ])
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "note@1", "turn.ended@1"])
  })))
})
