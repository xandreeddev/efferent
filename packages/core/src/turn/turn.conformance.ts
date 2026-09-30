import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type { Scope } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { IntentMatcher } from "../ports/capability.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { Sessions } from "../ports/sessions.port.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import type { SessionAddress } from "../session/sessions.entity.js"
import type { TurnRunner } from "../ports/turn.port.js"
import { UserMessage } from "./user-message.entity.js"

const fail = (check: string) => (message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check)(message)

/** The conformance session: the Sessions of the turn services, and one session made for the check. */
interface Session {
  readonly sessions: Context.Service.Shape<typeof Sessions>
  readonly address: SessionAddress
}

const stored = (session: Session) => session.sessions.read(session.address).pipe(
  Effect.mapError((error) => new HarnessError({ code: "conformance.session", message: error._tag })),
)
/** The events of the turn run `runId` began. */
const ofRun = (all: ReadonlyArray<SessionLogEvent>, runId: string): ReadonlyArray<SessionLogEvent> => {
  const turn = Option.flatMap(Option.fromNullishOr(all.find((event) => event.kind === "turn.started" && event.data.runId === runId)), (event) => event.turn)
  return Option.match(turn, { onNone: () => [], onSome: (number) => all.filter((event) => Option.contains(event.turn, number)) })
}
const names = (session: Session, runId: string) => stored(session).pipe(Effect.map((all) => ofRun(all, runId).map((event) => event.kind)))

/**
 * The turn contract, as checks any composition of the turn must pass (an
 * `Agent`, or a host's own composition of `TurnLive` and the lifecycle):
 * the session's writer is the bus's first subscriber; the user's message
 * is in memory before the matcher reads the history; the reply is recorded
 * and the turn ended exactly once on success, failure and interrupt; tasks
 * are joined before the reply; and the host layer sees only earlier turns.
 *
 * `runner` is acquired afresh for each check. `services` are merged into
 * every turn's services (the model, the `Sessions` the turns begin with, and
 * whatever else the runner requires); each check makes its own session, and
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
    body: (runner: TurnRunner, session: Session, history: Ref.Ref<ReadonlyArray<ReadonlyArray<AgentMessage>>>) => Effect.Effect<void, ConformanceFailure | HarnessError, Scope.Scope>,
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
      const sessions = yield* Option.match(Context.getOption(services, Sessions), {
        onNone: () => fail(id)("the turn services hold no Sessions to begin turns with"),
        onSome: (found) => Effect.succeed(found),
      })
      const view = yield* sessions.create({ owner: "conformance" }).pipe(Effect.mapError((error) => new HarnessError({ code: "conformance.session", message: error._tag })))
      const acquired = yield* runner
      yield* body({
        turn: (input, use) => acquired.turn({ ...input, services: Context.merge(Context.merge(services, matcher), input.services) }, use),
      }, { sessions, address: { id: view.header.id, owner: "conformance" } }, history)
    })).pipe(Effect.catchTag("HarnessError", (error) => fail(id)(`${error.code}: ${error.message}`))),
  })
  const input = (session: Session, runId: string) => ({
    turn: { session: session.address, userMessage: new UserMessage({ text: `the message of ${runId}` }), runId }, services: Context.empty(),
  })
  const reply = (text: string) => Effect.succeed({ outcome: "completed" as const, reply: Option.some(text) })

  return [
    check("the session's writer is the bus's first subscriber", "journal-first", (turns, session) => Effect.gen(function* () {
      const outcome = yield* turns.turn(input(session, "run-1"), (turn) => Effect.gen(function* () {
        const journaled = yield* Ref.make(false)
        yield* turn.events.subscribe(
          (event) => event._tag === "host" && event.name === "conformance.probe" ? Option.some(event) : Option.none(),
          () => turn.flush.pipe(Effect.andThen(names(session, "run-1")), Effect.flatMap((kinds) => Ref.set(journaled, kinds.includes("conformance.probe")))),
        )
        yield* turn.events.publish({ _tag: "host", name: "conformance.probe", data: {} })
        return yield* reply((yield* Ref.get(journaled)) ? "journaled first" : "not journaled")
      }))
      yield* expect("journal-first", Option.contains(outcome.reply, "journaled first"), "a subscriber ran before the session stored the event it received")
    })),
    check("the user's message is recorded before the matcher reads the history", "message-first", (turns, session, history) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), (turn) => turn.tools.match(turn.userMessage).pipe(Effect.andThen(reply("matched"))))
      const seen = yield* Ref.get(history)
      const last = Option.fromNullishOr(seen.at(-1)?.at(-1))
      yield* expect("message-first", seen.length === 1, `the matcher was consulted ${seen.length} times, not once`)
      yield* expect("message-first", Option.exists(last, (message) => message.role === "user" && JSON.stringify(message.content).includes("the message of run-1")),
        "the matcher's history does not end with the turn's own message")
    })),
    check("the reply is recorded and the turn ended exactly once, on success, failure and interrupt", "ended-once", (turns, session) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), () => reply("done"))
      yield* Effect.result(turns.turn(input(session, "run-2"), () => Effect.fail(new HarnessError({ code: "conformance.host", message: "the host failed" }))))
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(turns.turn(input(session, "run-3"), () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const all = yield* stored(session)
      const per = (runId: string, kind: string, field: (event: SessionLogEvent) => unknown) => ofRun(all, runId).filter((event) => event.kind === kind).map(field).join("+")
      const replies = ["run-1", "run-2", "run-3"].map((runId) => `${runId}:${per(runId, "turn.reply", (event) => (event.data.body as { readonly outcome?: unknown } | undefined)?.outcome)}`)
      const endings = ["run-1", "run-2", "run-3"].map((runId) => `${runId}:${per(runId, "turn.ended", (event) => event.data.reason)}`)
      yield* expect("ended-once", replies.join() === "run-1:completed,run-2:failed,run-3:failed", `the replies were ${replies.join()}`)
      yield* expect("ended-once", endings.join() === "run-1:completed,run-2:failed,run-3:interrupted", `the turns ended ${endings.join()}`)
    })),
    check("tasks are joined before the reply", "tasks-joined", (turns, session) => Effect.gen(function* () {
      yield* turns.turn(input(session, "run-1"), (turn) => turn.tasks.fork("late", Effect.sleep("10 millis").pipe(
        Effect.andThen(turn.events.publish({ _tag: "host", name: "conformance.task", data: {} })),
      )).pipe(Effect.andThen(reply("forked"))))
      const kinds = yield* names(session, "run-1")
      yield* expect("tasks-joined", kinds.includes("conformance.task") && kinds.indexOf("conformance.task") < kinds.indexOf("turn.reply"),
        `the task's event came ${kinds.includes("conformance.task") ? "after the reply" : "never"}`)
    })),
    check("the host layer is built before the message: it sees only earlier turns", "layer-before-message", (turns, session) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = Layer.effectDiscard(Effect.gen(function* () {
        const run = yield* RunContext
        const own = (yield* run.memory.entries).filter((entry) => entry.runId === run.runId).length
        const turn = yield* run.memory.turn
        yield* Ref.update(seen, (all) => [...all, `${run.runId}:turn ${turn}, own entries ${own}`])
      }))
      yield* turns.turn({ ...input(session, "run-1"), layer }, () => reply("first"))
      yield* turns.turn({ ...input(session, "run-2"), layer }, () => reply("second"))
      const built = (yield* Ref.get(seen)).join("; ")
      yield* expect("layer-before-message", built === "run-1:turn 0, own entries 0; run-2:turn 1, own entries 0", `the host layer saw ${built}`)
    })),
  ]
}
