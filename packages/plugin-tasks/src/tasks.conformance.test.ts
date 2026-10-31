import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { SessionLog, SessionLogMemoryLive, Sessions, TaskActivity, TaskExecutor, TaskRefused, TaskRunner, Tasks, TurnAdmissionOpen, TurnRefused, TurnShutdown } from "@xandreed/core"
import { taskRunnerConformance, tasksConformance } from "@xandreed/core/conformance"
import type { ConformanceCheck, TasksDependencies, TasksFixture } from "@xandreed/core/conformance"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { tasksDefaults } from "./task-records.entity.js"
import { isFinished } from "./task.entity.functions.js"
import { InProcessTaskRunnerLive } from "./task-runner.adapter.js"
import { TasksLive } from "./tasks.adapter.js"

const passes = (checks: ReadonlyArray<ConformanceCheck>) => checks.map((check) => test(check.name, async () => {
  const exit = await Effect.runPromise(Effect.result(check.run))
  expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
}, 30_000))

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) => Effect.runPromise(Effect.forEach(checks, (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

/** The in-process runner as the kit builds it, with its TaskActivity. */
const inProcess = (options?: { readonly maxMs?: number }) => taskRunnerConformance(Layer.build(InProcessTaskRunnerLive(options)).pipe(Effect.map((context) => ({
  runner: Context.get(context, TaskRunner),
  activity: Context.getOption(context, TaskActivity),
}))))

describe("InProcessTaskRunnerLive conforms to the TaskRunner contract", () => {
  passes(inProcess())
})

describe("InProcessTaskRunnerLive with a deadline (maxMs) conforms to the TaskRunner contract", () => {
  passes(inProcess({ maxMs: 60_000 }))
})

/** One in-memory log for every check: the kit uses fresh owners and sessions. */
const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))

type SessionsService = TasksFixture["sessions"]

/**
 * TasksLive over SessionsLive (with its default lease and keep-alive) over
 * the shared log, or a careless wrapper of it, with the kit's runner and
 * executor.
 */
const tasksOver = (dependencies: TasksDependencies, wrap: (sessions: SessionsService) => SessionsService = (sessions) => sessions) => Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
  Layer.effectContext(Effect.gen(function* () {
    const sessions = yield* Sessions
    return Context.make(Sessions, wrap(sessions)).pipe(Context.add(TurnShutdown, yield* TurnShutdown))
  })).pipe(Layer.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))),
  Layer.succeed(TaskRunner, dependencies.runner),
  Layer.succeed(TaskExecutor, dependencies.executor),
)))).pipe(Effect.map((context): TasksFixture => ({ sessions: Context.get(context, Sessions), tasks: Context.get(context, Tasks), shutdown: Context.getOption(context, TurnShutdown) })))

describe("TasksLive conforms to the Tasks contract", () => {
  passes(tasksConformance((dependencies) => tasksOver(dependencies)))
})

/** TasksLive with one of its calls made careless. */
const careless = (change: (tasks: TasksFixture["tasks"], sessions: TasksFixture["sessions"]) => Partial<TasksFixture["tasks"]>) => (dependencies: TasksDependencies) =>
  tasksOver(dependencies).pipe(Effect.map((fixture): TasksFixture => ({ ...fixture, tasks: Tasks.of({ ...fixture.tasks, ...change(fixture.tasks, fixture.sessions) }) })))

describe("the Tasks kit catches careless backends", () => {
  test("one whose ask returns without a durable question fails the question check", async () => {
    const checks = tasksConformance(careless(() => ({ ask: (_writer, input) => Effect.succeed(input) })))
      .filter((check) => check.name.startsWith("a durable question"))
    expect(await failedChecks(checks)).toEqual(["question"])
  }, 30_000)

  test("one that omits the executor's waiting control fails the sticky question check", async () => {
    const checks = tasksConformance((dependencies) => tasksOver({ ...dependencies, executor: TaskExecutor.of({
      ...dependencies.executor,
      turn: (writer, task) => dependencies.executor.turn(writer, task),
    }) })).filter((check) => check.name.startsWith("an early answer"))
    expect(await failedChecks(checks)).toEqual(["question-sticky"])
  }, 30_000)

  test("one whose answer accepts without enqueueing fails the answer check", async () => {
    const checks = tasksConformance(careless(() => ({ answer: () => Effect.succeed({ accepted: true, enqueued: false }) })))
      .filter((check) => check.name.startsWith("an answer queues"))
    expect(await failedChecks(checks)).toEqual(["answer"])
  }, 30_000)

  test("one whose steer returns without enqueueing fails the steer check", async () => {
    const checks = tasksConformance(careless(() => ({ steer: () => Effect.succeed({ enqueued: false, pending: 0 }) })))
      .filter((check) => check.name.startsWith("steering an active task"))
    expect(await failedChecks(checks)).toEqual(["steer"])
  }, 30_000)

  test("one whose cancel answers yes and stops nothing fails only the cancel check", async () => {
    expect(await failedChecks(tasksConformance(careless(() => ({ cancel: () => Effect.succeed(true) }))))).toEqual(["cancel"])
  }, 30_000)

  test("one that starts a new task whatever id it is given fails only the checks that start a task by its id", async () => {
    expect(await failedChecks(tasksConformance(careless((tasks) => ({
      start: (parent, input) => tasks.start(parent, { instructions: input.instructions, mode: input.mode }),
    }))))).toEqual(["start-once", "task-id"])
  }, 30_000)

  test("one that judges depth by a session's lineage, refusing a host's fork, fails only the depth check", async () => {
    expect(await failedChecks(tasksConformance(careless((tasks, sessions) => ({
      start: (parent, input) => sessions.get(parent).pipe(Effect.flatMap((view) => Option.isSome(view.header.parent)
        ? Effect.fail(new TaskRefused({ session: parent.id, reason: "depth", message: "a forked session cannot start a task" }))
        : tasks.start(parent, input))),
    }))))).toEqual(["depth"])
  }, 30_000)

  test("one whose child turns begin as a user's, the task in their command, fails the run and answer checks", async () => {
    const asUser = (sessions: SessionsService): SessionsService => Sessions.of({
      ...sessions,
      begin: (address, input) => sessions.begin(address, input._tag === "Task"
        ? { _tag: "User", userMessage: input.userMessage, runId: input.runId, key: input.key, command: { task: input.task.taskId }, ...(input.meta === undefined ? {} : { meta: input.meta }) }
        : input),
    })
    expect(await failedChecks(tasksConformance((dependencies) => tasksOver(dependencies, asUser)))).toEqual(["answer", "run"])
  }, 30_000)

  test("one whose reconcile does nothing fails only the reconcile checks", async () => {
    expect(await failedChecks(tasksConformance(careless(() => ({ reconcile: () => Effect.succeed({ delivered: 0, started: 0 }) })))))
      .toEqual(["reconcile", "reconcile-delivery"])
  }, 30_000)

  test("one whose reconcile leaves a result whose delivery was lost undelivered fails only the reconcile-delivery check", async () => {
    expect(await failedChecks(tasksConformance(careless((tasks) => ({
      reconcile: (parent) => tasks.list(parent).pipe(Effect.flatMap((all) => all.some((task) => isFinished(task.status) && !task.delivered)
        ? Effect.succeed({ delivered: 0, started: 0 })
        : tasks.reconcile(parent))),
    }))))).toEqual(["reconcile-delivery"])
  }, 30_000)

  test("one that runs its executor's turns without itself in context fails only the executor-tasks check", async () => {
    // The port's type asks for Tasks around the executor's turns: taking it away compiles only through this cast.
    const withoutTasks = <A, E>(turn: Effect.Effect<A, E, Tasks>) => turn.pipe(Effect.updateContext((context: Context.Context<never>) => Context.omit(Tasks)(context) as Context.Context<Tasks>))
    expect(await failedChecks(tasksConformance((dependencies) => tasksOver({
      ...dependencies,
      executor: TaskExecutor.of({
        turn: (writer, task, controls) => withoutTasks(dependencies.executor.turn(writer, task, controls)),
        react: (writer) => withoutTasks(dependencies.executor.react(writer)),
      }),
    })))).toEqual(["executor-tasks"])
  }, 30_000)

  test("one that fails a task its shutdown refused, as if the host had refused it, fails only the shutdown check", async () => {
    const unaware = (sessions: SessionsService): SessionsService => Sessions.of({
      ...sessions,
      begin: (address, input) => sessions.begin(address, input).pipe(Effect.catchTag("TurnRefused", (refused) =>
        Effect.fail(new TurnRefused({ session: refused.session, reason: "budget", message: refused.message })))),
    })
    expect(await failedChecks(tasksConformance((dependencies) => tasksOver(dependencies, unaware)))).toEqual(["shutdown"])
  }, 30_000)

  test("one that lists no task fails the checks that read the list", async () => {
    expect(await failedChecks(tasksConformance(careless(() => ({ list: () => Effect.succeed([]) })))))
      .toEqual(["run", "start-once"])
  }, 30_000)
})
