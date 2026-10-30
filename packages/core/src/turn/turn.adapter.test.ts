import { describe, expect, test } from "bun:test"
import { Toolkit } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Result, Tracer } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { failureCode } from "../conformance.functions.js"
import { RunId } from "../domain/run.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { openLogSession } from "../memory/memory-session.js"
import type { MemoryPolicy } from "../memory/memory-session.js"
import { ConversationMemory } from "../ports/memory.port.js"
import type { ToolViews } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { ToolRegistry } from "../ports/tool-registry.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import { TurnMemory, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnOutcome } from "../ports/turn.port.js"
import { recordingTurnWriter } from "./testing.js"
import { TurnLive } from "./turn.adapter.js"
import { guardTurn, openTurnTools, traceTurn } from "./turn-lifecycle.js"

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

/** Memory over the turn's log, as the strategies open it. */
const memory = ConversationMemory.of({
  strategy: policy.strategy,
  open: ({ runId, log }) => openLogSession(log, policy, { runId }),
})

const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: String(encoded), version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: () => Effect.succeed(Option.none()),
  digest: () => Effect.succeed(Option.none()),
}

/** A registry whose tools report which run opened them and what they activate. */
const registry = ToolRegistry.of({
  catalog: { version: "1", recipes: [], tools: [] },
  open: () => Effect.gen(function* () {
    const run = yield* RunContext
    const active = yield* Ref.make<ReadonlyArray<string>>([])
    const tools: RunTools = {
      toolkit: Toolkit.make(),
      handlers: Context.empty(),
      active: Ref.get(active),
      activate: (skills, source) => Ref.updateAndGet(active, (all) => [...all, ...skills.map((skill) => `${skill}@${source}:${run.runId}`)]),
      match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }),
      apply: () => Ref.get(active),
      select: () => Ref.get(active),
      views,
      pollable: [],
      skills: [],
    }
    return tools
  }),
})

type Recorded = Effect.Success<ReturnType<typeof recordingTurnWriter>>
const services = Layer.merge(Layer.succeed(ConversationMemory, memory), Layer.succeed(ToolRegistry, registry))
/** End the recorded turn (its closing drafts stored, then `turn.ended`), and read what it stored. */
const endedKinds = (recorded: Recorded) => recorded.writer.end({ reason: "completed", failure: Option.none() }).pipe(Effect.andThen(recorded.kinds))
const begun = (runId = "run-1", turn = 1) => recordingTurnWriter({ runId: RunId.make(runId), text: `message of ${runId}`, turn })
const inTurn = <A, E>(recorded: Recorded, body: Effect.Effect<A, E, TurnMemory | TurnToolbox | TurnEvents | TurnTasks | RunContext | Scope.Scope>) =>
  Effect.scoped(body).pipe(Effect.provide(TurnLive({ turn: recorded.writer })), Effect.provide(services))

describe("TurnLive", () => {
  test("memory takes the message once, at persistMessage; the writer stores every event before a subscriber sees it", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      return yield* inTurn(recorded, Effect.gen(function* () {
        const turn = yield* TurnMemory
        const run = yield* RunContext
        const before = yield* Effect.result(turn.number)
        const recordedBefore = (yield* turn.entries).length
        // A later subscriber sees each event already queued for the session.
        const storedFirst = yield* Ref.make<ReadonlyArray<string>>([])
        yield* run.events.subscribe((event) => event._tag === "host" ? Option.some(event) : Option.none(), (event) => run.flush.pipe(
          Effect.andThen(recorded.kinds),
          Effect.flatMap((stored) => Ref.update(storedFirst, (all) => [...all, `${event.name}:${stored.includes(event.name)}`])),
        ))
        const number = yield* turn.persistMessage
        const again = yield* Effect.result(turn.persistMessage)
        yield* run.events.publish({ _tag: "host", name: "probe.seen", data: {} })
        yield* run.flush
        return {
          before: before._tag === "Failure" ? before.failure.code : "started",
          recordedBefore, number, numberAfter: yield* turn.number, entries: (yield* turn.entries).map((entry) => `${entry.id}:${entry.body._tag}`),
          again: again._tag === "Failure" ? failureCode(again.failure) : "twice",
          stored: yield* recorded.kinds,
          storedFirst: yield* Ref.get(storedFirst),
        }
      }))
    }))
    expect(seen).toEqual({
      before: "turn.unstarted", recordedBefore: 0, number: 1, numberAfter: 1, entries: ["run-1:0:TurnStarted"], again: "turn.persisted",
      stored: ["turn.started", "probe.seen"], storedFirst: ["probe.seen:true"],
    })
  })

  test("each run of the turn takes the next ordinal, once the message is taken and until the reply", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      return yield* inTurn(recorded, Effect.gen(function* () {
        const turn = yield* TurnMemory
        const code = <A>(exit: Result.Result<A, HarnessError>) => exit._tag === "Failure" ? exit.failure.code : "started"
        const early = code(yield* Effect.result(turn.startRun))
        yield* turn.persistMessage
        const runs = [yield* turn.startRun, yield* turn.startRun]
        yield* turn.persistReply({ outcome: "completed", reply: Option.some("done") })
        return { early, runs: runs.map((run) => `${run.id} turn ${run.turn} run ${run.ordinal}`), after: code(yield* Effect.result(turn.startRun)) }
      }))
    }))
    expect(seen).toEqual({ early: "turn.unstarted", runs: ["run-1 turn 1 run 0", "run-1 turn 1 run 1"], after: "turn.closed" })
  })

  test("a message memory would number differently from the session is refused", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun("run-2", 2)
      return yield* Effect.result(inTurn(recorded, TurnMemory.pipe(Effect.flatMap((turn) => turn.persistMessage))))
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "turn.numbering" } })
  })

  test("a host event may not take a name the framework writes", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      return yield* Effect.result(inTurn(recorded, RunContext.pipe(Effect.flatMap((run) => run.events.publish({ _tag: "host", name: "turn.ended", data: {} })))))
    }))
    expect(JSON.stringify(exit)).toContain("events.reserved")
  })

  test.each(["assistant.message", "tool.progress", "tool.refused", "stream.fallback", "host"])("nor a bus event's name (%s), stored as itself or not", async (name) => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      return yield* Effect.result(inTurn(recorded, RunContext.pipe(Effect.flatMap((run) => run.events.publish({ _tag: "host", name, data: {} })))))
    }))
    expect(JSON.stringify(exit)).toContain("events.reserved")
  })

  test("the tools open once, with the opener's services, and RunContext.activate uses them", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      return yield* inTurn(recorded, Effect.gen(function* () {
        const toolbox = yield* TurnToolbox
        const run = yield* RunContext
        const before = yield* Effect.result(toolbox.tools)
        const activateBefore = yield* Effect.result(run.activate(["early"]))
        yield* openTurnTools
        const again = yield* Effect.result(openTurnTools)
        return {
          before: before._tag === "Failure" ? before.failure.code : "open",
          activateBefore: activateBefore._tag === "Failure" ? failureCode(activateBefore.failure) : "activated",
          again: again._tag === "Failure" ? failureCode(again.failure) : "twice",
          active: yield* run.activate(["notes"]),
        }
      }))
    }))
    expect(seen).toEqual({ before: "tools.unavailable", activateBefore: "tools.unavailable", again: "tools.opened", active: ["notes@host:run-1"] })
  })

  test("persistReply is a no-op before the message is persisted, and once after; the reply, and what memory records after it, wait for the turn's end", async () => {
    const { flushed, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const flushed = yield* inTurn(recorded, Effect.gen(function* () {
        const turn = yield* TurnMemory
        const outcome: TurnOutcome = { outcome: "completed", reply: Option.some("hi") }
        yield* turn.persistReply(outcome)
        yield* turn.persistMessage
        yield* turn.persistReply(outcome)
        yield* turn.persistReply(outcome)
        yield* turn.context({ id: "after", version: "1", text: "noted after the reply" })
        yield* (yield* RunContext).flush
        return yield* recorded.kinds
      }))
      return { flushed, ended: yield* endedKinds(recorded) }
    }))
    expect(flushed.filter((name) => name.startsWith("turn.") || name.startsWith("memory."))).toEqual(["turn.started"])
    expect(ended.filter((name) => name.startsWith("turn.") || name.startsWith("memory."))).toEqual(["turn.started", "turn.reply", "memory.section", "turn.ended"])
  })

  test("a message memory failed to record can be taken again, with the context entries that waited for it", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      // The first write (the message's) fails, as a store refusing one append would.
      const writes = yield* Ref.make(0)
      const flaky: Recorded = { ...recorded, writer: { ...recorded.writer, append: (drafts) => Ref.getAndUpdate(writes, (n) => n + 1).pipe(
        Effect.flatMap((n) => n === 0 ? Effect.fail(new HarnessError({ code: "session.log", message: "refused once" })) : recorded.writer.append(drafts)),
      ) } }
      return yield* inTurn(flaky, Effect.gen(function* () {
        const turn = yield* TurnMemory
        yield* turn.context({ id: "intent", version: "1", text: "waited" })
        const first = yield* Effect.result(turn.persistMessage)
        const again = yield* Effect.result(turn.persistMessage)
        return {
          first: first._tag === "Failure" ? failureCode(first.failure) : "taken",
          again: again._tag === "Failure" ? failureCode(again.failure) : again.success,
          entries: (yield* turn.entries).map((entry) => `${entry.id}:${entry.body._tag}`),
        }
      }))
    }))
    expect(seen).toEqual({ first: "session.log", again: 1, entries: ["run-1:0:TurnStarted", "run-1:1:TurnContext"] })
  })

  test("tools whose open failed stay closed, and open on the next try", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const opens = yield* Ref.make(0)
      const flaky = ToolRegistry.of({
        ...registry,
        open: (session) => Ref.getAndUpdate(opens, (n) => n + 1).pipe(
          Effect.flatMap((n) => n === 0 ? Effect.fail(new HarnessError({ code: "tools.duplicate", message: "refused once" })) : registry.open(session)),
        ),
      })
      return yield* Effect.scoped(Effect.gen(function* () {
        const toolbox = yield* TurnToolbox
        const first = yield* Effect.result(openTurnTools)
        const between = yield* Effect.result(toolbox.tools)
        const again = yield* Effect.result(openTurnTools)
        return {
          first: first._tag === "Failure" ? failureCode(first.failure) : "open",
          between: between._tag === "Failure" ? between.failure.code : "open",
          again: again._tag === "Failure" ? failureCode(again.failure) : "open",
          active: yield* (yield* RunContext).activate(["notes"]),
        }
      })).pipe(
        Effect.provide(TurnLive({ turn: recorded.writer })),
        Effect.provide(Layer.merge(Layer.succeed(ConversationMemory, memory), Layer.succeed(ToolRegistry, flaky))),
      )
    }))
    expect(seen).toEqual({ first: "tools.duplicate", between: "tools.unavailable", again: "open", active: ["notes@host:run-1"] })
  })
})

describe("guardTurn", () => {
  const guarded = <E>(recorded: Recorded, body: Effect.Effect<TurnOutcome, E, TurnMemory | TurnTasks | TurnEvents | RunContext | Scope.Scope>) =>
    inTurn(recorded, guardTurn(Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      return yield* body
    })))
  /** The turn's replies as its end stores them: `outcome`, and `outcome:text` with `withText`. */
  const endings = (recorded: Recorded, withText = false) => recorded.writer.end({ reason: "completed", failure: Option.none() }).pipe(
    Effect.andThen(Ref.get(recorded.stored)),
    Effect.map((all) => all.filter((event) => event.kind === "turn.reply").map((event) => {
      const body = event.data.body as { readonly outcome: string; readonly reply: string | null }
      return withText ? `${body.outcome}:${body.reply}` : body.outcome
    })),
  )

  test("a success joins the tasks, then records the reply with the outcome", async () => {
    const journalNames = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      yield* guarded(recorded, Effect.gen(function* () {
        const run = yield* RunContext
        yield* run.tasks.fork("late", Effect.sleep("5 millis").pipe(Effect.andThen(run.events.publish({ _tag: "host", name: "task.done", data: {} }))))
        return { outcome: "completed", reply: Option.some("done") } satisfies TurnOutcome
      }))
      return yield* endedKinds(recorded)
    }))
    expect(journalNames.slice(-3)).toEqual(["task.done", "turn.reply", "turn.ended"])
  })

  test("a reaction to the reply that fails fails the turn and downgrades the reply held for the end: it is stored failed, its text kept", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const exit = yield* Effect.result(guarded(recorded, Effect.gen(function* () {
        yield* (yield* TurnEvents).subscribe((event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(),
          () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "the reaction failed" })), { mode: "background" })
        return { outcome: "completed", reply: Option.some("done") } satisfies TurnOutcome
      })))
      return { exit, ended: yield* endings(recorded, true) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "reaction.failed" } })
    expect(ended).toEqual(["failed:done"])
  })

  test("a failure keeps its cause and records the reply failed, once", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const exit = yield* Effect.result(guarded(recorded, Effect.fail({ _tag: "HostFailure" as const })))
      return { exit, ended: yield* endings(recorded) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { _tag: "HostFailure" } })
    expect(ended).toEqual(["failed"])
  })

  test("an interrupt records the reply failed, once", async () => {
    const ended = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(guarded(recorded, Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* endings(recorded)
    }))
    expect(ended).toEqual(["failed"])
  })

  /** A subscription in the body's scope, so it takes the turn's reply: a background reaction to it that never returns. */
  const stuckOnReply = (reacting: Deferred.Deferred<void>) => Effect.gen(function* () {
    const events = yield* TurnEvents
    yield* events.subscribe((event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(),
      () => Deferred.succeed(reacting, undefined).pipe(Effect.andThen(Effect.never)), { mode: "background" })
  })

  test("an interrupt is not held up by a background reaction to the failed reply that never returns", async () => {
    const { stopped, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const started = yield* Deferred.make<void>()
      const reacting = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(guarded(recorded, stuckOnReply(reacting).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      const stopped = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"))
      return { stopped: Option.isSome(stopped), ended: yield* endings(recorded) }
    }))
    expect({ stopped, ended }).toEqual({ stopped: true, ended: ["failed"] })
  })

  test("a failure waits for the reactions to its failed reply ten seconds at most, then ends keeping its cause", async () => {
    const { early, exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const reacting = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(guarded(recorded, stuckOnReply(reacting).pipe(Effect.andThen(Effect.fail({ _tag: "HostFailure" as const })))))
      yield* Deferred.await(reacting)
      yield* TestClock.adjust("9 seconds")
      const early = (yield* Effect.sync(() => fiber.pollUnsafe())) !== undefined
      yield* TestClock.adjust("1 second")
      const exit = yield* Effect.result(Fiber.join(fiber))
      return { early, exit, ended: yield* endings(recorded) }
    }).pipe(Effect.provide(TestClock.layer())))
    expect(early).toBe(false)
    expect(exit).toMatchObject({ _tag: "Failure", failure: { _tag: "HostFailure" } })
    expect(ended).toEqual(["failed"])
  })

  test("once the body has returned, its reply is recorded even when the turn is interrupted meanwhile; the drain the interrupt cuts downgrades it to failed", async () => {
    const ended = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // The reply's hold waits: an interrupt arrives while the reply is being recorded.
      const slow: Recorded = { ...recorded, writer: { ...recorded.writer, closing: (drafts) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)), Effect.andThen(recorded.writer.closing(drafts))) } }
      const fiber = yield* Effect.forkChild(guarded(slow, Effect.succeed<TurnOutcome>({ outcome: "completed", reply: Option.some("done") })))
      yield* Deferred.await(entered)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
      return yield* endings(recorded, true)
    }))
    expect(ended).toEqual(["failed:done"])
  })

  test("a HarnessError carried as a defect fails the turn, typed", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const exit = yield* Effect.result(guarded(recorded, Effect.die(new HarnessError({ code: "reaction.failed", message: "a subscriber failed" }))))
      return { exit, ended: yield* endings(recorded) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "reaction.failed" } })
    expect(ended).toEqual(["failed"])
  })

  test("under traceTurn the reply is recorded in turn.persist_reply, a child of agent.turn with the turn's ids; a failed turn's usage stays on agent.turn", async () => {
    const tracedTurn = (body: Effect.Effect<TurnOutcome, { readonly _tag: "HostFailure" }>) => Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const recorded = yield* begun()
      yield* guarded(recorded, body).pipe(traceTurn(recorded.writer), Effect.withTracer(tracer), Effect.exit)
      const turn = spans.find((span) => span.name === "agent.turn")
      const replies = spans.filter((span) => span.name === "turn.persist_reply")
      return {
        replies: replies.map((span) => ({
          parent: Option.map(span.parent, (parent) => parent.spanId === turn?.spanId),
          ids: ["efferent.session.id", "efferent.run.id", "efferent.turn"].map((key) => span.attributes.get(key)),
          usage: span.attributes.has("efferent.usage.input_tokens"),
        })),
        turnUsage: turn?.attributes.get("efferent.usage.input_tokens"),
        session: recorded.writer.admitted.session.id,
      }
    })
    const [completed, failed] = await Effect.runPromise(Effect.all([
      tracedTurn(Effect.succeed<TurnOutcome>({ outcome: "completed", reply: Option.some("done") })),
      tracedTurn(Effect.fail({ _tag: "HostFailure" as const })),
    ], { concurrency: 1 }))
    expect(completed.replies).toEqual([{ parent: Option.some(true), ids: [completed.session, "run-1", 1], usage: false }])
    expect(failed.replies).toEqual([{ parent: Option.some(true), ids: [failed.session, "run-1", 1], usage: false }])
    expect(failed.turnUsage).toBe(0)
  })
})
