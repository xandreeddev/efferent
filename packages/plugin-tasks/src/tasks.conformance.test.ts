import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { SessionLog, SessionLogMemoryLive, Sessions, TaskActivity, TaskExecutor, TaskRunner, Tasks, taskRunnerConformance, tasksConformance, TurnAdmissionOpen } from "@xandreed/core"
import type { ConformanceCheck, TasksDependencies, TasksFixture } from "@xandreed/core"
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

/** TasksLive over SessionsLive (with its default lease and keep-alive) over the shared log, with the kit's runner and executor. */
const tasksOver = (dependencies: TasksDependencies) => Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
  SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))),
  Layer.succeed(TaskRunner, dependencies.runner),
  Layer.succeed(TaskExecutor, dependencies.executor),
)))).pipe(Effect.map((context): TasksFixture => ({ sessions: Context.get(context, Sessions), tasks: Context.get(context, Tasks) })))

describe("TasksLive conforms to the Tasks contract", () => {
  passes(tasksConformance(tasksOver))
})

/** TasksLive with one of its calls made careless. */
const careless = (change: (tasks: TasksFixture["tasks"]) => Partial<TasksFixture["tasks"]>) => (dependencies: TasksDependencies) =>
  tasksOver(dependencies).pipe(Effect.map((fixture): TasksFixture => ({ ...fixture, tasks: Tasks.of({ ...fixture.tasks, ...change(fixture.tasks) }) })))

describe("the Tasks kit catches careless backends", () => {
  test("one whose cancel answers yes and stops nothing fails only the cancel check", async () => {
    expect(await failedChecks(tasksConformance(careless(() => ({ cancel: () => Effect.succeed(true) }))))).toEqual(["cancel"])
  }, 30_000)

  test("one that starts a new task whatever id it is given fails only the checks that start a task by its id", async () => {
    expect(await failedChecks(tasksConformance(careless((tasks) => ({
      start: (parent, input) => tasks.start(parent, { instructions: input.instructions, mode: input.mode }),
    }))))).toEqual(["start-once", "task-id"])
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

  test("one that lists no task fails the checks that read the list", async () => {
    expect(await failedChecks(tasksConformance(careless(() => ({ list: () => Effect.succeed([]) })))))
      .toEqual(["run", "start-once"])
  }, 30_000)
})
