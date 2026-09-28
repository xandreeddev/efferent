import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { Scope } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import { inMemoryJournal } from "../memory/memory.conformance.js"
import { IntentMatcher } from "../ports/capability.port.js"
import { RunContext } from "../ports/run-context.port.js"
import type { TurnRunner } from "../ports/turn.port.js"
import { UserMessage } from "./user-message.entity.js"

const conversation = ConversationId.make("00000000-0000-4000-8000-0000000c0f7e")

const fail = (check: string) => (message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check)(message)

type Journal = Effect.Effect.Success<typeof inMemoryJournal>
const names = (journal: Journal, runId: string) => Ref.get(journal.stored).pipe(
  Effect.map((all) => all.filter((event) => event.runId === runId).map((event) => event.name)),
)

/**
 * The turn contract, as checks any composition of the turn must pass (an
 * `Agent`, or a host's own composition of `TurnLive` and the lifecycle):
 * the journal is the bus's first subscriber; the user's message is
 * recorded before the matcher reads the history; `turn.ended` is recorded
 * exactly once on success, failure and interrupt; tasks are joined before
 * it; and the host layer sees only earlier turns.
 *
 * `runner` is acquired afresh for each check. `services` are merged into
 * every turn's services (the model and whatever else the runner requires);
 * the kit adds its own IntentMatcher, which the runner's tools must consult
 * (plugin-tool-discovery does).
 */
export const turnConformance = (
  runner: Effect.Effect<TurnRunner, HarnessError, Scope.Scope>,
  services: Context.Context<never> = Context.empty(),
): ReadonlyArray<ConformanceCheck> => {
  const check = (
    name: string,
    id: string,
    body: (runner: TurnRunner, journal: Journal, history: Ref.Ref<ReadonlyArray<ReadonlyArray<AgentMessage>>>) => Effect.Effect<void, ConformanceFailure | HarnessError, Scope.Scope>,
  ): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const history = yield* Ref.make<ReadonlyArray<ReadonlyArray<AgentMessage>>>([])
      const matcher = Context.make(IntentMatcher, IntentMatcher.of({
        id: "conformance", version: "1",
        match: (request) => Ref.update(history, (all) => [...all, request.history]).pipe(
          Effect.as({ skills: [], probabilities: Option.none(), abstained: true }),
        ),
      }))
      const acquired = yield* runner
      const journal = yield* inMemoryJournal
      yield* body({
        turn: (input, use) => acquired.turn({ ...input, services: Context.merge(Context.merge(services, matcher), input.services) }, use),
      }, journal, history)
    })).pipe(Effect.catchTag("HarnessError", (error) => fail(id)(`${error.code}: ${error.message}`))),
  })
  const input = (journal: Journal, runId: string) => ({
    conversation, runId, userMessage: new UserMessage({ text: `the message of ${runId}` }), journal: journal.io, services: Context.empty(),
  })
  const reply = (text: string) => Effect.succeed({ outcome: "completed" as const, reply: Option.some(text) })

  return [
    check("the journal is the bus's first subscriber", "journal-first", (turns, journal) => Effect.gen(function* () {
      const outcome = yield* turns.turn(input(journal, "run-1"), (turn) => Effect.gen(function* () {
        const journaled = yield* Ref.make(false)
        yield* turn.events.subscribe(
          (event) => event._tag === "host" && event.name === "conformance.probe" ? Option.some(event) : Option.none(),
          () => turn.flush.pipe(Effect.zipRight(names(journal, "run-1")), Effect.flatMap((stored) => Ref.set(journaled, stored.includes("conformance.probe")))),
        )
        yield* turn.events.publish({ _tag: "host", name: "conformance.probe", data: {} })
        return yield* reply((yield* Ref.get(journaled)) ? "journaled first" : "not journaled")
      }))
      yield* expect("journal-first", Option.contains(outcome.reply, "journaled first"), "a subscriber ran before the journal stored the event it received")
    })),
    check("the user's message is recorded before the matcher reads the history", "message-first", (turns, journal, history) => Effect.gen(function* () {
      yield* turns.turn(input(journal, "run-1"), (turn) => turn.tools.match(turn.userMessage).pipe(Effect.zipRight(reply("matched"))))
      const seen = yield* Ref.get(history)
      const last = Option.fromNullable(seen.at(-1)?.at(-1))
      yield* expect("message-first", seen.length === 1, `the matcher was consulted ${seen.length} times, not once`)
      yield* expect("message-first", Option.exists(last, (message) => message.role === "user" && JSON.stringify(message.content).includes("the message of run-1")),
        "the matcher's history does not end with the turn's own message")
    })),
    check("turn.ended is recorded exactly once, on success, failure and interrupt", "ended-once", (turns, journal) => Effect.gen(function* () {
      yield* turns.turn(input(journal, "run-1"), () => reply("done"))
      yield* Effect.either(turns.turn(input(journal, "run-2"), () => Effect.fail(new HarnessError({ code: "conformance.host", message: "the host failed" }))))
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.fork(turns.turn(input(journal, "run-3"), () => Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const ended = (yield* Ref.get(journal.stored)).filter((event: EventBody) => event.name === "turn.ended")
      const outcomes = ended.map((event) => `${event.runId}:${String(event.data.outcome)}`)
      yield* expect("ended-once", outcomes.join() === "run-1:completed,run-2:failed,run-3:failed", `turn.ended was ${outcomes.join() || "never recorded"}`)
    })),
    check("tasks are joined before turn.ended", "tasks-joined", (turns, journal) => Effect.gen(function* () {
      yield* turns.turn(input(journal, "run-1"), (turn) => turn.tasks.fork("late", Effect.sleep("10 millis").pipe(
        Effect.zipRight(turn.events.publish({ _tag: "host", name: "conformance.task", data: {} })),
      )).pipe(Effect.zipRight(reply("forked"))))
      const stored = yield* names(journal, "run-1")
      yield* expect("tasks-joined", stored.includes("conformance.task") && stored.indexOf("conformance.task") < stored.indexOf("turn.ended"),
        `the task's event came ${stored.includes("conformance.task") ? "after turn.ended" : "never"}`)
    })),
    check("the host layer is built before the message: it sees only earlier turns", "layer-before-message", (turns, journal) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = Layer.effectDiscard(Effect.gen(function* () {
        const run = yield* RunContext
        const own = (yield* run.memory.entries).filter((entry) => entry.runId === run.runId).length
        const turn = yield* run.memory.turn
        yield* Ref.update(seen, (all) => [...all, `${run.runId}:turn ${turn}, own entries ${own}`])
      }))
      yield* turns.turn({ ...input(journal, "run-1"), layer }, () => reply("first"))
      yield* turns.turn({ ...input(journal, "run-2"), layer }, () => reply("second"))
      const built = (yield* Ref.get(seen)).join("; ")
      yield* expect("layer-before-message", built === "run-1:turn 0, own entries 0; run-2:turn 1, own entries 0", `the host layer saw ${built}`)
    })),
  ]
}
