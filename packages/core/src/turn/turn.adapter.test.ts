import { describe, expect, test } from "bun:test"
import { Toolkit } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { Scope } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { inMemoryJournal } from "../memory/memory.conformance.js"
import { openLogSession } from "../memory/memory-session.js"
import type { MemoryPolicy } from "../memory/memory-session.js"
import { ConversationMemory } from "../ports/memory.port.js"
import type { JournalIO, ToolViews } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { ToolRegistry } from "../ports/tool-registry.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import { TurnMemory, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnOutcome } from "../ports/turn.port.js"
import { UserMessage } from "./user-message.entity.js"
import { TurnLive } from "./turn.adapter.js"
import { guardTurn, openTurnTools } from "./turn-lifecycle.js"

const conversation = ConversationId.make("00000000-0000-4000-8000-0000000071e5")
const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0 } },
  digestOnWrite: Option.none(),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

/** Memory that writes each record to the turn's journal, as the memory log does. */
const memory = ConversationMemory.of({
  strategy: policy.strategy,
  open: ({ runId, io }) => Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<never>>([])
    return yield* openLogSession({
      read: Ref.get(stored),
      append: (entries) => io.append({ name: "memory.entries", runId, data: { bodies: entries.map((entry) => entry.body._tag) } }),
    }, policy, { runId })
  }),
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

const turnInput = (journal: JournalIO, runId: string) => ({ conversation, runId, userMessage: new UserMessage({ text: `message of ${runId}` }), journal })
const services = Layer.merge(Layer.succeed(ConversationMemory, memory), Layer.succeed(ToolRegistry, registry))
const names = (journal: Effect.Success<typeof inMemoryJournal>) => Ref.get(journal.stored).pipe(Effect.map((all) => all.map((event) => event.name)))
const inTurn = <A, E>(journal: JournalIO, runId: string, body: Effect.Effect<A, E, TurnMemory | TurnToolbox | TurnEvents | TurnTasks | RunContext | Scope.Scope>) =>
  Effect.scoped(body).pipe(Effect.provide(TurnLive(turnInput(journal, runId))), Effect.provide(services))

describe("TurnLive", () => {
  test("nothing is recorded before persistMessage, which is once; the journal sees every event first", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      return yield* inTurn(journal.io, "run-1", Effect.gen(function* () {
        const turn = yield* TurnMemory
        const run = yield* RunContext
        const before = yield* Effect.result(turn.number)
        const recordedBefore = (yield* turn.entries).length
        // A later subscriber sees each event already queued for the journal.
        const journaledFirst = yield* Ref.make<ReadonlyArray<string>>([])
        yield* run.events.subscribe(Option.some, (event) => run.flush.pipe(
          Effect.andThen(names(journal)),
          Effect.flatMap((stored) => Ref.update(journaledFirst, (all) => [...all, `${event._tag}:${stored.includes(event._tag)}`])),
        ))
        const number = yield* turn.persistMessage
        const again = yield* Effect.result(turn.persistMessage)
        yield* run.flush
        return {
          before: before._tag === "Failure" ? before.failure.code : "started",
          recordedBefore, number, numberAfter: yield* turn.number,
          again: again._tag === "Failure" ? again.failure.code : "twice",
          journal: yield* names(journal),
          journaledFirst: yield* Ref.get(journaledFirst),
        }
      }))
    }))
    expect(seen).toEqual({
      before: "turn.unstarted", recordedBefore: 0, number: 1, numberAfter: 1, again: "turn.persisted",
      journal: ["memory.entries", "turn.started"], journaledFirst: ["turn.started:true"],
    })
  })

  test("the tools open once, with the opener's services, and RunContext.activate uses them", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      return yield* inTurn(journal.io, "run-1", Effect.gen(function* () {
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
      const journal = yield* inMemoryJournal
      yield* inTurn(journal.io, "run-1", Effect.gen(function* () {
        const turn = yield* TurnMemory
        const outcome: TurnOutcome = { outcome: "completed", reply: Option.some("hi") }
        yield* turn.persistReply(outcome)
        yield* turn.persistMessage
        yield* turn.persistReply(outcome)
        yield* turn.persistReply(outcome)
        yield* (yield* RunContext).flush
      }))
      return yield* names(journal)
    }))
    expect(journalNames.filter((name) => name.startsWith("turn."))).toEqual(["turn.started", "turn.ended"])
  })
})

describe("guardTurn", () => {
  const guarded = <E>(journal: JournalIO, body: Effect.Effect<TurnOutcome, E, TurnMemory | TurnTasks | TurnEvents | RunContext | Scope.Scope>) =>
    inTurn(journal, "run-1", guardTurn(Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      return yield* body
    })))
  const endings = (journal: Effect.Success<typeof inMemoryJournal>) => Ref.get(journal.stored).pipe(
    Effect.map((all) => all.filter((event) => event.name === "turn.ended").map((event) => event.data.outcome)),
  )

  test("a success joins the tasks, then records turn.ended with the outcome", async () => {
    const journalNames = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      yield* guarded(journal.io, Effect.gen(function* () {
        const run = yield* RunContext
        yield* run.tasks.fork("late", Effect.sleep("5 millis").pipe(Effect.andThen(run.events.publish({ _tag: "host", name: "task.done", data: {} }))))
        return { outcome: "completed", reply: Option.some("done") } satisfies TurnOutcome
      }))
      return yield* names(journal)
    }))
    expect(journalNames.filter((name) => name !== "memory.entries").slice(-2)).toEqual(["task.done", "turn.ended"])
  })

  test("a failure keeps its cause and records turn.ended failed, once", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      const exit = yield* Effect.result(guarded(journal.io, Effect.fail({ _tag: "HostFailure" as const })))
      return { exit, ended: yield* endings(journal) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { _tag: "HostFailure" } })
    expect(ended).toEqual(["failed"])
  })

  test("an interrupt records turn.ended failed, once", async () => {
    const ended = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(guarded(journal.io, Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* endings(journal)
    }))
    expect(ended).toEqual(["failed"])
  })

  test("a HarnessError carried as a defect fails the turn, typed", async () => {
    const { exit, ended } = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* inMemoryJournal
      const exit = yield* Effect.result(guarded(journal.io, Effect.die(new HarnessError({ code: "reaction.failed", message: "a subscriber failed" }))))
      return { exit, ended: yield* endings(journal) }
    }))
    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "reaction.failed" } })
    expect(ended).toEqual(["failed"])
  })
})
