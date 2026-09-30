import { describe, expect, test } from "bun:test"
import { Toolkit } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { Scope } from "effect"
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
import { guardTurn, openTurnTools } from "./turn-lifecycle.js"

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0 } },
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
const begun = (runId = "run-1", turn = 1) => recordingTurnWriter({ runId, text: `message of ${runId}`, turn })
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
          again: again._tag === "Failure" ? again.failure.code : "twice",
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
          activateBefore: activateBefore._tag === "Failure" ? activateBefore.failure.code : "activated",
          again: again._tag === "Failure" ? again.failure.code : "twice",
          active: yield* run.activate(["notes"]),
        }
      }))
    }))
    expect(seen).toEqual({ before: "tools.unavailable", activateBefore: "tools.unavailable", again: "tools.opened", active: ["notes@host:run-1"] })
  })

  test("persistReply is a no-op before the message is persisted, and once after", async () => {
    const journalNames = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      yield* inTurn(recorded, Effect.gen(function* () {
        const turn = yield* TurnMemory
        const outcome: TurnOutcome = { outcome: "completed", reply: Option.some("hi") }
        yield* turn.persistReply(outcome)
        yield* turn.persistMessage
        yield* turn.persistReply(outcome)
        yield* turn.persistReply(outcome)
        yield* (yield* RunContext).flush
      }))
      return yield* recorded.kinds
    }))
    expect(journalNames.filter((name) => name.startsWith("turn."))).toEqual(["turn.started", "turn.reply"])
  })
})

describe("guardTurn", () => {
  const guarded = <E>(recorded: Recorded, body: Effect.Effect<TurnOutcome, E, TurnMemory | TurnTasks | TurnEvents | RunContext | Scope.Scope>) =>
    inTurn(recorded, guardTurn(Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      return yield* body
    })))
  const endings = (recorded: Recorded) => Ref.get(recorded.stored).pipe(
    Effect.map((all) => all.filter((event) => event.kind === "turn.reply").map((event) => (event.data.body as { readonly outcome: string }).outcome)),
  )

  test("a success joins the tasks, then records the reply with the outcome", async () => {
    const journalNames = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      yield* guarded(recorded, Effect.gen(function* () {
        const run = yield* RunContext
        yield* run.tasks.fork("late", Effect.sleep("5 millis").pipe(Effect.andThen(run.events.publish({ _tag: "host", name: "task.done", data: {} }))))
        return { outcome: "completed", reply: Option.some("done") } satisfies TurnOutcome
      }))
      return yield* recorded.kinds
    }))
    expect(journalNames.slice(-2)).toEqual(["task.done", "turn.reply"])
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

  test("a HarnessError carried as a defect fails the turn, typed", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const recorded = yield* begun()
      const exit = yield* Effect.result(guarded(recorded, Effect.die(new HarnessError({ code: "reaction.failed", message: "a subscriber failed" }))))
      return { exit, ended: yield* endings(recorded) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "reaction.failed" } })
    expect(ended).toEqual(["failed"])
  })
})
