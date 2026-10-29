import { Clock, Context, Deferred, Effect, Exit, Fiber, FiberSet, Option, Ref, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "../conformance.entity.js"
import { check, eventually, expect, fail, freshId, kindsOf, settles } from "../conformance.functions.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { TaskActivity } from "../ports/activity.port.js"
import type { Sessions, TurnWriter } from "../ports/sessions.port.js"
import { TaskExecutor, TaskRunner } from "../ports/tasks.port.js"
import type { Tasks } from "../ports/tasks.port.js"
import type { TurnOutcome } from "../ports/turn.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import type { SessionLogError, SessionLogEvent, SessionMissing } from "./session-log.entity.js"
import type { AdmittedTurn, SessionAddress } from "./sessions.entity.js"
import type { TaskView } from "./tasks.entity.js"

type Runner = Context.Service.Shape<typeof TaskRunner>
type Executor = Context.Service.Shape<typeof TaskExecutor>

/** How long the task kits wait, on the live clock, for work they expect to happen. */
const WAIT = "2 seconds"

/** `effect`, failing `id` with `message` unless it ends within `WAIT`. */
const within = <A, E, R>(id: string, message: string) => (effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ConformanceFailure, R> =>
  Effect.timeoutOrElse(effect, { duration: WAIT, orElse: () => fail(id, message) })

/** A service the caller of `run` has and the work must not see. */
const CallerProbe = Context.Reference<string>("efferent/conformance/TaskRunnerCaller", { defaultValue: () => "none" })

/** A task runner as the kit builds one. */
export interface TaskRunnerFixture {
  readonly runner: Runner
  /** Its `TaskActivity`, when it provides one: then checked against the work it runs. */
  readonly activity: Option.Option<Context.Service.Shape<typeof TaskActivity>>
}

/**
 * The TaskRunner contract, as checks: `run` returns once the work is handed
 * over, before it ends, and the work runs once; it goes on when the caller
 * that handed it over is interrupted and its scope closed; the deadline it
 * is told is none or not in the past; it runs without the caller's
 * services (a task outlives the turn that started it); with a
 * `TaskActivity`, the work counts from the moment `run` hands it over until
 * it ends, and `idle` waits for all of it; and closing the scope the runner
 * was made in interrupts the work still running (it counts no more), so a
 * task's turn ends interrupted rather than lost.
 *
 * `make` is run afresh for each check, in a scope the kit closes. A runner
 * that hands work to something outside this process's scope (a serverless
 * `waitUntil`) cannot interrupt it: give it `{ interruptsOnClose: false }`
 * to leave that check out. The checks wait up to two seconds on the live
 * clock for work they expect, so run the kit on the live clock.
 */
export const taskRunnerConformance = (
  make: Effect.Effect<TaskRunnerFixture, unknown, Scope.Scope>,
  options: { readonly interruptsOnClose?: boolean } = {},
): ReadonlyArray<ConformanceCheck> => {
  const scoped = (name: string, id: string, body: (fixture: TaskRunnerFixture) => Effect.Effect<void, unknown, Scope.Scope>): ConformanceCheck =>
    check(name, id, () => Effect.scoped(make.pipe(Effect.flatMap(body))))
  /** Hand `work` over, failing `id` when `run` does not return while the work still runs. */
  const handOver = (runner: Runner, id: string, work: (deadline: Option.Option<number>) => Effect.Effect<void>) =>
    runner.run(work).pipe(within(id, `run did not return within ${WAIT} of being called: it must return once the work is handed over, not when the work ends`))

  return [
    scoped("run returns once the work is handed over, before it ends, and the work runs once", "hand-over", ({ runner }) => Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const release = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<void>()
      const handing = yield* Effect.forkChild(runner.run(() => Ref.update(runs, (count) => count + 1).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(ended, undefined)),
      )))
      const returned = yield* Effect.timeoutOption(Fiber.await(handing), WAIT)
      yield* Deferred.succeed(release, undefined)
      yield* expect("hand-over", Option.isSome(returned), `run did not return within ${WAIT} while its work waited: it runs the work instead of handing it over`)
      yield* expect("hand-over", Option.exists(returned, Exit.isSuccess), "run failed")
      yield* Deferred.await(ended).pipe(within("hand-over", `the work never ended within ${WAIT} of being released`))
      yield* Effect.yieldNow
      const count = yield* Ref.get(runs)
      yield* expect("hand-over", count === 1, `the work ran ${count} times`)
    })),

    scoped("the work goes on when the caller that handed it over is interrupted and its scope closed", "outlives-caller", ({ runner }) => Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<void>()
      const handed = yield* Deferred.make<void>()
      const caller = yield* Effect.forkChild(Effect.scoped(runner.run(() => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(ended, undefined)),
      ))).pipe(Effect.andThen(Deferred.succeed(handed, undefined)), Effect.andThen(Effect.never)))
      yield* Deferred.await(started).pipe(within("outlives-caller", `the work did not start within ${WAIT}`))
      yield* Deferred.await(handed).pipe(within("outlives-caller", `run did not return within ${WAIT} while its work waited`))
      yield* Fiber.interrupt(caller)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(ended).pipe(within("outlives-caller", "the work stopped with the caller that handed it over"))
    })),

    scoped("the work is told a deadline that is none or not in the past", "deadline", ({ runner }) => Effect.gen(function* () {
      const told = yield* Deferred.make<Option.Option<number>>()
      const before = yield* Clock.currentTimeMillis
      yield* handOver(runner, "deadline", (deadline) => Deferred.succeed(told, deadline).pipe(Effect.asVoid))
      const deadline = yield* Deferred.await(told).pipe(within("deadline", `the work did not run within ${WAIT}`))
      yield* expect("deadline", Option.match(deadline, { onNone: () => true, onSome: (at) => at >= before }), `the work was told a deadline ${Option.getOrNull(deadline)} before the hand-over at ${before}`)
    })),

    scoped("the work runs without the services of the caller that handed it over", "isolation", ({ runner }) => Effect.gen(function* () {
      const seen = yield* Deferred.make<string>()
      yield* handOver(runner, "isolation", () => Effect.service(CallerProbe).pipe(Effect.flatMap((value) => Deferred.succeed(seen, value)), Effect.asVoid))
        .pipe(Effect.provideService(CallerProbe, "the caller's"))
      const value = yield* Deferred.await(seen).pipe(within("isolation", `the work did not run within ${WAIT}`))
      yield* expect("isolation", value !== "the caller's", "the work ran with the services of the caller that handed it over (the turn that starts a task ends before it)")
    })),

    scoped("TaskActivity counts the work from the moment run hands it over until it ends, and idle waits for all of it", "activity", ({ runner, activity }) => Option.match(activity, {
      onNone: () => Effect.void,
      onSome: (probe) => Effect.gen(function* () {
        yield* expect("activity", (yield* probe.running) === 0, "a new runner counts work running")
        yield* expect("activity", yield* settles(yield* Effect.forkChild(probe.idle)), "idle does not complete with nothing running")
        const releases = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
        yield* handOver(runner, "activity", () => Deferred.await(releases[0]!))
        const afterOne = yield* probe.running
        yield* expect("activity", afterOne === 1, `right after run returned, ${afterOne} pieces of work count (the work counts from the hand-over)`)
        yield* handOver(runner, "activity", () => Deferred.await(releases[1]!))
        yield* expect("activity", (yield* probe.running) === 2, `with two pieces of work handed over, ${yield* probe.running} count`)
        const idle = yield* Effect.forkChild(probe.idle)
        yield* expect("activity", !(yield* settles(idle)), "idle completed while work was running")
        yield* Deferred.succeed(releases[0]!, undefined)
        const one = yield* eventually(probe.running, (count) => count === 1)
        yield* expect("activity", one === 1, `after one piece of work ended, ${one} count`)
        yield* expect("activity", !(yield* settles(idle)), "idle completed while work was still running")
        yield* Deferred.succeed(releases[1]!, undefined)
        yield* Fiber.join(idle).pipe(within("activity", `idle did not complete within ${WAIT} of the last work ending`))
        yield* expect("activity", (yield* probe.running) === 0, `after all the work ended, ${yield* probe.running} pieces count`)
      }),
    })),

    ...(options.interruptsOnClose === false ? [] : [
      check("closing the scope the runner was made in interrupts the work still running, which then counts no more", "scope-close", () => Effect.scoped(Effect.gen(function* () {
        const runnerScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const fixture = yield* make.pipe(Scope.provide(runnerScope))
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        yield* Effect.forkChild(fixture.runner.run(() => Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        )))
        yield* Deferred.await(started).pipe(within("scope-close", `the work did not start within ${WAIT}`))
        yield* Scope.close(runnerScope, Exit.void)
        yield* Deferred.await(interrupted).pipe(within("scope-close", `the work was not interrupted within ${WAIT} of the runner's scope closing`))
        yield* Option.match(fixture.activity, {
          onNone: () => Effect.void,
          onSome: (probe) => eventually(probe.running, (count) => count === 0).pipe(Effect.flatMap((count) =>
            expect("scope-close", count === 0, `after the runner's scope closed, ${count} pieces of work count`))),
        })
      }))),
    ]),
  ]
}

/** What the kit's executor gives the tasks backend. */
export interface TasksDependencies {
  readonly runner: Runner
  readonly executor: Executor
}

/** A tasks backend as the kit builds one: its `Tasks` and the `Sessions` they run over. */
export interface TasksFixture {
  readonly sessions: Context.Service.Shape<typeof Sessions>
  readonly tasks: Context.Service.Shape<typeof Tasks>
}

/** One child turn as the kit's executor ran it. */
interface ChildTurn {
  readonly admitted: AdmittedTurn
  readonly task: TaskView
  /** The child's history before the turn, as `kind@turn`. */
  readonly history: string
}

const ofKind = (events: ReadonlyArray<SessionLogEvent>, kind: string) => events.filter((event) => event.kind === kind)
const reasons = (events: ReadonlyArray<SessionLogEvent>) => ofKind(events, "turn.ended").map((event) => String(event.data.reason)).join()

/** The most items the kit delivers to fill a parent's inbox. */
const FILL = 256

/**
 * Deliver items to `parent` until its inbox refuses one (`InboxFull`): true
 * once it is full, false when it took `FILL` items without refusing any.
 */
const fillInbox = (sessions: Context.Service.Shape<typeof Sessions>, parent: SessionAddress, n = 0): Effect.Effect<boolean, SessionMissing | SessionLogError> =>
  n >= FILL ? Effect.succeed(false) : sessions.deliver(parent, { id: `fill-${n}`, source: { kind: "conformance", id: `fill-${n}` }, content: `filler ${n}` }).pipe(
    Effect.as(false),
    Effect.catchTag("InboxFull", () => Effect.succeed(true)),
    Effect.flatMap((full) => full ? Effect.succeed(true) : fillInbox(sessions, parent, n + 1)),
  )

/**
 * The Tasks contract, as checks: a task runs as one turn of a child session
 * (a spawn starts empty; a fork's history is the parent's up to its last
 * closed turn), its result reaches the parent's inbox once and the parent
 * reacts to it once, after the turn in flight; the parent records
 * `task.started` once per task, and starting a task again runs it once; a
 * failed turn's result says why; a cancel stops the child's turn and
 * delivers nothing; a task does not start tasks; and `reconcile` starts a
 * task whose runner never ran it, and delivers, once, a finished result
 * whose delivery was lost. The kit loses one by filling the parent's inbox
 * until `deliver` fails with `InboxFull` before the task ends: that check
 * relies on the backend leaving a result the full inbox refused for a later
 * `reconcile`, and runs only over a `Sessions` whose inbox refuses an item
 * within 256 deliveries (one that takes them all passes it unchecked).
 *
 * `make` builds the backend for each check over the kit's own `TaskRunner`
 * (each piece of work on a fiber the kit waits for, with the services the
 * check had when it built the runner and none of the caller's, as a
 * conforming runner runs it; or dropped, as by a runner that died) and
 * `TaskExecutor` (a child turn answers
 * `found: <instructions>` unless the check says otherwise; a reaction
 * records the turn it ran on). The checks wait up to two seconds on the live
 * clock for background work to end, so run the kit on the live clock.
 */
export const tasksConformance = (make: (dependencies: TasksDependencies) => Effect.Effect<TasksFixture, unknown, Scope.Scope>): ReadonlyArray<ConformanceCheck> => {
  const harness = (owner: string, childTurn: (writer: TurnWriter, task: TaskView) => Effect.Effect<TurnOutcome, HarnessError> =
    (_writer, task) => Effect.succeed({ outcome: "completed", reply: Option.some(`found: ${task.instructions}`) })) => Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void>()
    // Each piece of work runs with the services there were when the harness was built, not its caller's, as on a conforming runner.
    const built = yield* Effect.context<never>()
    const dropping = yield* Ref.make(false)
    const turns = yield* Ref.make<ReadonlyArray<ChildTurn>>([])
    const reactions = yield* Ref.make<ReadonlyArray<AdmittedTurn>>([])
    const runner = TaskRunner.of({
      run: (work) => Ref.get(dropping).pipe(Effect.flatMap((drop) => drop ? Effect.void
        : FiberSet.run(fibers, work(Option.none()).pipe(Effect.updateContext((_: Context.Context<never>) => built))).pipe(Effect.asVoid))),
    })
    const react = (writer: TurnWriter) => Ref.update(reactions, (all) => [...all, writer.admitted])
    const executor = TaskExecutor.of({
      turn: (writer, task) => writer.history([]).pipe(
        Effect.flatMap((history) => Ref.update(turns, (all) => [...all, { admitted: writer.admitted, task, history: kindsOf(history) }])),
        Effect.andThen(childTurn(writer, task)),
      ),
      react,
    })
    const fixture = yield* make({ runner, executor })
    const parent = yield* fixture.sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
    return {
      ...fixture,
      parent,
      dropping,
      turns: Ref.get(turns),
      reactions: Ref.get(reactions),
      react,
      /** Wait until every piece of work handed over has ended. */
      idle: (id: string) => FiberSet.awaitEmpty(fibers).pipe(within(id, `the background work did not end within ${WAIT}`)),
      read: (address: SessionAddress) => fixture.sessions.read(address),
    }
  })
  const scoped = (name: string, id: string, body: (owner: string) => Effect.Effect<void, unknown, Scope.Scope>): ConformanceCheck =>
    check(name, id, (owner) => Effect.scoped(body(owner)))
  const done = { reason: "completed", failure: Option.none() } as const

  return [
    scoped("a task runs as one turn of a child session, its result reaches the parent's inbox once, and the parent reacts once", "run", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      const view = yield* h.tasks.start(h.parent, { instructions: "look it up", mode: "spawn" })
      yield* expect("run", view.parent === h.parent.id && view.child === view.taskId && view.instructions === "look it up" && view.mode === "spawn"
        && ["pending", "running", "completed"].includes(view.status), `start returned ${view.status} for ${view.child} under ${view.parent}`)
      yield* h.idle("run")
      const status = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("run", status.status === "completed" && Option.contains(status.reply, "found: look it up") && status.delivered && Option.isNone(status.failure),
        `the finished task reads ${status.status}, reply ${Option.getOrNull(status.reply)}, delivered ${status.delivered}`)
      const child: SessionAddress = { id: view.child, owner }
      const lineage = (yield* h.sessions.get(child)).header.parent
      yield* expect("run", Option.exists(lineage, (at) => at.id === h.parent.id), "the task's session is not a child of the parent")
      const childEvents = yield* h.read(child)
      yield* expect("run", ofKind(childEvents, "turn.started").length === 1 && reasons(childEvents) === "completed",
        `the child holds ${ofKind(childEvents, "turn.started").length} turns, ended ${reasons(childEvents)}`)
      const ran = yield* h.turns
      yield* expect("run", ran.length === 1 && ran[0]!.admitted.session.id === view.child && ran[0]!.task.taskId === view.taskId
        && ran[0]!.task.instructions === "look it up" && ran[0]!.history === "", `the executor ran ${ran.length} child turns, the first with history [${ran[0]?.history ?? ""}]`)
      const reacted = yield* h.reactions
      yield* expect("run", reacted.length === 1 && reacted[0]!.origin === "inbox" && reacted[0]!.session.id === h.parent.id
        && reacted[0]!.claimed.length === 1 && reacted[0]!.claimed[0]!.content.includes("found: look it up"),
      `the parent reacted ${reacted.length} times${reacted.length > 0 ? `, to ${reacted[0]!.claimed.length} items` : ""}`)
      const parentEvents = yield* h.read(h.parent)
      const started = ofKind(parentEvents, "task.started")
      yield* expect("run", started.length === 1 && started[0]!.data.taskId === view.taskId, `the parent records ${started.length} task.started`)
      yield* expect("run", ofKind(parentEvents, "inbox.queued").length === 1, `the parent's inbox took ${ofKind(parentEvents, "inbox.queued").length} deliveries`)
      const listed = (yield* h.tasks.list(h.parent)).map((task) => task.taskId).join()
      yield* expect("run", listed === view.taskId, `the parent lists [${listed}]`)
    })),

    scoped("starting a task again (by its id, while it runs or after) runs it once", "start-once", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      const taskId = yield* freshId
      const input = { taskId, instructions: "once", mode: "spawn" as const }
      const first = yield* h.tasks.start(h.parent, input)
      const again = yield* h.tasks.start(h.parent, input)
      yield* h.idle("start-once")
      const after = yield* h.tasks.start(h.parent, input)
      yield* h.idle("start-once")
      yield* expect("start-once", [first, again, after].every((view) => view.taskId === taskId), "a start of the same task returned another task")
      const counts = {
        listed: (yield* h.tasks.list(h.parent)).length,
        turns: (yield* h.turns).length,
        reactions: (yield* h.reactions).length,
        started: ofKind(yield* h.read(h.parent), "task.started").length,
        delivered: ofKind(yield* h.read(h.parent), "inbox.queued").length,
      }
      yield* expect("start-once", Object.values(counts).every((count) => count === 1), `three starts of one task gave ${JSON.stringify(counts)}`)
    })),

    scoped("a result that arrives during the parent's turn waits for it, and a fork's history is the parent's up to its last closed turn", "after-turn", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      const say = (text: string) => ({ _tag: "User" as const, userMessage: new UserMessage({ text }), runId: `run-${text}`, key: text, command: {} })
      yield* Effect.scoped(h.sessions.begin(h.parent, say("one")).pipe(Effect.tap((writer) => writer.end(done))))
      const open = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const writer = yield* h.sessions.begin(h.parent, say("two")).pipe(Scope.provide(open))
      const view = yield* h.tasks.start(h.parent, { instructions: "compare", mode: "fork" })
      yield* h.idle("after-turn")
      const status = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("after-turn", status.status === "completed" && status.delivered, `the task finished as ${status.status}, delivered ${status.delivered}`)
      yield* expect("after-turn", (yield* h.reactions).length === 0, "the parent reacted while its turn was open")
      const ended = yield* writer.end(done)
      yield* expect("after-turn", ended.pending === 1, `the parent's turn ended with ${ended.pending} items waiting`)
      yield* h.sessions.drain(h.parent, h.react)
      yield* expect("after-turn", (yield* h.reactions).length === 1, `after the parent's turn the drain reacted ${(yield* h.reactions).length} times`)
      const history = (yield* h.turns)[0]?.history ?? "none"
      yield* expect("after-turn", history.startsWith("turn.started@1,") && history.endsWith("turn.ended@1") && !history.includes("@2"),
        `the fork's child turn saw the history [${history}]`)
    })),

    scoped("a failed child turn is a failed task that says why, and the parent still hears of it", "failed", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner, () => Effect.fail(new HarnessError({ code: "conformance.down", message: "the model is down" })))
      const view = yield* h.tasks.start(h.parent, { instructions: "doomed", mode: "spawn" })
      yield* h.idle("failed")
      const status = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("failed", status.status === "failed" && Option.exists(status.failure, (failure) => failure.code === "conformance.down") && status.delivered,
        `the task reads ${status.status}, failure ${JSON.stringify(Option.getOrNull(status.failure))}, delivered ${status.delivered}`)
      yield* expect("failed", reasons(yield* h.read({ id: view.child, owner })) === "failed", "the child's turn did not end failed")
      yield* expect("failed", (yield* h.reactions).length === 1, `the parent reacted ${(yield* h.reactions).length} times`)
    })),

    scoped("a cancel stops the child's turn and delivers nothing; a finished or unknown task is not cancelled", "cancel", (owner) => Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const h = yield* harness(owner, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      const view = yield* h.tasks.start(h.parent, { instructions: "forever", mode: "spawn" })
      yield* Deferred.await(entered).pipe(within("cancel", `the child's turn did not start within ${WAIT}`))
      const running = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("cancel", running.status === "running", `a task in its turn reads ${running.status}`)
      yield* expect("cancel", yield* h.tasks.cancel(h.parent, view.taskId), "cancelling a running task answered false")
      yield* h.idle("cancel")
      const cancelled = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("cancel", cancelled.status === "cancelled" && !cancelled.delivered, `the cancelled task reads ${cancelled.status}, delivered ${cancelled.delivered}`)
      yield* expect("cancel", reasons(yield* h.read({ id: view.child, owner })) === "cancelled", "the child's turn did not end cancelled")
      yield* expect("cancel", (yield* h.reactions).length === 0 && ofKind(yield* h.read(h.parent), "inbox.queued").length === 0, "the cancelled task delivered something")
      yield* expect("cancel", !(yield* h.tasks.cancel(h.parent, view.taskId)), "cancelling a cancelled task answered true")
      const unknown = [yield* Effect.flip(h.tasks.cancel(h.parent, "no-such-task")), yield* Effect.flip(h.tasks.status(h.parent, "no-such-task"))]
      yield* expect("cancel", unknown.every((error) => error._tag === "TaskMissing"), `an unknown task gave ${unknown.map((error) => error._tag).join()}`)
    })),

    scoped("a task does not start tasks", "depth", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      const view = yield* h.tasks.start(h.parent, { instructions: "first", mode: "spawn" })
      yield* h.idle("depth")
      const nested = yield* Effect.flip(h.tasks.start({ id: view.child, owner }, { instructions: "deeper", mode: "spawn" }))
      yield* expect("depth", nested._tag === "TaskRefused" && nested.reason === "depth", `a task's session starting a task gave ${nested._tag}`)
    })),

    scoped("reconcile starts a task its runner never ran, which then delivers; done, it finds nothing more", "reconcile", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      yield* Ref.set(h.dropping, true)
      const view = yield* h.tasks.start(h.parent, { instructions: "never ran", mode: "spawn" })
      const lost = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("reconcile", lost.status === "pending", `a task whose runner dropped it reads ${lost.status}`)
      yield* Ref.set(h.dropping, false)
      const first = yield* h.tasks.reconcile(h.parent)
      yield* expect("reconcile", first.started === 1 && first.delivered === 0, `reconcile answered ${JSON.stringify(first)}`)
      yield* h.idle("reconcile")
      const status = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("reconcile", status.status === "completed" && status.delivered && (yield* h.reactions).length === 1,
        `the reconciled task reads ${status.status}, delivered ${status.delivered}`)
      const second = yield* h.tasks.reconcile(h.parent)
      yield* h.idle("reconcile")
      yield* expect("reconcile", second.started === 0 && second.delivered === 0 && (yield* h.turns).length === 1, `reconciling again answered ${JSON.stringify(second)}`)
    })),

    scoped("reconcile delivers a finished result whose delivery was lost (the parent's inbox was full), once", "reconcile-delivery", (owner) => Effect.gen(function* () {
      const h = yield* harness(owner)
      // An inbox that takes every item cannot lose a delivery this way: nothing to check.
      if (!(yield* fillInbox(h.sessions, h.parent))) return
      const view = yield* h.tasks.start(h.parent, { instructions: "lost on the way", mode: "spawn" })
      yield* h.idle("reconcile-delivery")
      const lost = yield* h.tasks.status(h.parent, view.taskId)
      yield* expect("reconcile-delivery", lost.status === "completed" && !lost.delivered,
        `a task whose result the parent's full inbox refused reads ${lost.status}, delivered ${lost.delivered}`)
      // The host empties the inbox (the backend may already have drained it).
      yield* h.sessions.drain(h.parent, h.react, { maxTurns: FILL + 1 })
      yield* expect("reconcile-delivery", (yield* h.sessions.get(h.parent)).pending === 0, "draining the parent left items waiting")
      const first = yield* h.tasks.reconcile(h.parent)
      yield* expect("reconcile-delivery", first.delivered === 1 && first.started === 0, `reconcile answered ${JSON.stringify(first)}`)
      yield* h.idle("reconcile-delivery")
      const before = (yield* h.reactions).length
      // reconcile's caller drains.
      yield* h.sessions.drain(h.parent, h.react)
      const status = yield* h.tasks.status(h.parent, view.taskId)
      const reacted = yield* h.reactions
      yield* expect("reconcile-delivery", status.delivered && reacted.length === before + 1
        && (reacted.at(-1)?.claimed.some((claimed) => claimed.content.includes("found: lost on the way")) ?? false),
      `after reconcile the task reads delivered ${status.delivered}, and the parent reacted ${reacted.length - before} times to it`)
      const second = yield* h.tasks.reconcile(h.parent)
      yield* expect("reconcile-delivery", second.started === 0 && second.delivered === 0 && (yield* h.turns).length === 1, `reconciling again answered ${JSON.stringify(second)}`)
    })),
  ]
}
