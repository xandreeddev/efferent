import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BackgroundWorkers } from "../ports/background-workers.port.js"
import { TaskActivity } from "../ports/activity.port.js"
import { processActivity, shutdownGracefully } from "./activity.entity.functions.js"
import { backgroundWorkersConformance } from "./background-workers.conformance.js"
import type { BackgroundWorkersSubject } from "./background-workers.conformance.js"

const subject: BackgroundWorkersSubject = {
  activity: (workers, tasks) => processActivity.pipe(
    Effect.provideService(BackgroundWorkers, workers),
    Effect.provideService(TaskActivity, { running: Effect.succeed(tasks), idle: Effect.void }),
    Effect.orDie,
  ),
  shutdown: (workers, options) => shutdownGracefully(options).pipe(Effect.provideService(BackgroundWorkers, workers)),
}

describe("backgroundWorkersConformance", () => {
  backgroundWorkersConformance(subject).forEach((check) => test(check.name, () => Effect.runPromise(check.run)))

  test("the check names are stable and every check catches a consumer that ignores workers", async () => {
    const checks = backgroundWorkersConformance({ activity: () => processActivity.pipe(Effect.orDie), shutdown: (_workers, options) => shutdownGracefully(options) })
    expect(checks.map((check) => check.name)).toEqual([
      "background worker activity preserves task counts", "sleeping background workers are idle", "background worker shutdown stops claims", "background worker shutdown interrupts remaining work",
    ])
    const results = await Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.every((result) => result._tag === "Failure")).toBe(true)
  })
})
