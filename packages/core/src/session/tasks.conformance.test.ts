import { describe, expect, test } from "bun:test"
import { Effect, FiberSet, Option } from "effect"
import type { Scope } from "effect"
import { TaskActivity } from "../ports/activity.port.js"
import { TaskRunner } from "../ports/tasks.port.js"
import { taskRunnerConformance } from "./tasks.conformance.js"
import type { TaskRunnerFixture } from "./tasks.conformance.js"

const failedChecks = (make: Effect.Effect<TaskRunnerFixture, unknown, Scope.Scope>) => Effect.runPromise(Effect.forEach(taskRunnerConformance(make), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

/**
 * A runner done right, on fibers of this process: each piece of work forked
 * with the services the runner was made with and added to a set in one
 * step, the set interrupted when the runner's scope closes, and counted
 * from the moment it is added. `lying` replaces its activity with one that
 * always reads idle.
 */
const fiberRunner = (lying = false): Effect.Effect<TaskRunnerFixture, never, Scope.Scope> => Effect.gen(function* () {
  const fibers = yield* FiberSet.make<void>()
  const services = yield* Effect.context<never>()
  return {
    runner: TaskRunner.of({ run: (work) => Effect.sync(() => FiberSet.addUnsafe(fibers, Effect.runForkWith(services)(work(Option.none())))) }),
    activity: Option.some(lying
      ? TaskActivity.of({ running: Effect.succeed(0), idle: Effect.void })
      : TaskActivity.of({ running: FiberSet.size(fibers), idle: FiberSet.awaitEmpty(fibers) })),
  }
})

/** A careless runner that runs the work in the caller, and returns when it ends. */
const inline: Effect.Effect<TaskRunnerFixture> = Effect.succeed({ runner: TaskRunner.of({ run: (work) => work(Option.none()) }), activity: Option.none() })

/** A careless runner that forks the work loose: it keeps the caller's services, and nothing stops it. */
const detached: Effect.Effect<TaskRunnerFixture> = Effect.succeed({
  runner: TaskRunner.of({ run: (work) => Effect.forkDetach(work(Option.none())).pipe(Effect.asVoid) }),
  activity: Option.none(),
})

describe("the TaskRunner kit passes a runner done right", () => {
  taskRunnerConformance(fiberRunner()).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the TaskRunner kit catches careless runners", () => {
  test("one that runs the work in the caller fails the hand-over, the caller's interruption, isolation and the scope's close", async () => {
    expect(await failedChecks(inline)).toEqual(["hand-over", "isolation", "outlives-caller", "scope-close"])
  }, 30_000)

  test("one that forks the work loose fails isolation and the scope's close", async () => {
    expect(await failedChecks(detached)).toEqual(["isolation", "scope-close"])
  }, 30_000)

  test("one whose TaskActivity always reads idle fails only the activity check", async () => {
    expect(await failedChecks(fiberRunner(true))).toEqual(["activity"])
  }, 30_000)

  test("a runner that cannot interrupt its work leaves the scope's close out", () => {
    const names = (options: { readonly interruptsOnClose?: boolean }) => taskRunnerConformance(inline, options).map((check) => check.name)
    expect(names({}).length - names({ interruptsOnClose: false }).length).toBe(1)
  })
})
