import { Effect, Ref } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect } from "../conformance.functions.js"
import type { BackgroundWorker } from "../ports/background-workers.port.js"
import type { ProcessActivity, ShutdownReport } from "./activity.entity.js"
import type { ShutdownOptions } from "./activity.entity.functions.js"

/** The application edge implemented by processActivity and shutdownGracefully. @public */
export interface BackgroundWorkersSubject {
  readonly activity: (workers: ReadonlyArray<BackgroundWorker>, tasks: number) => Effect.Effect<ProcessActivity>
  readonly shutdown: (workers: ReadonlyArray<BackgroundWorker>, options: ShutdownOptions) => Effect.Effect<ShutdownReport>
}

const idleWorker = (id: string): BackgroundWorker => ({ id, running: Effect.succeed(0), idle: Effect.void, stop: Effect.void, interrupt: Effect.void })

/** Worker accounting, compatibility with TaskActivity and bounded shutdown. @public */
export const backgroundWorkersConformance = (subject: BackgroundWorkersSubject): ReadonlyArray<ConformanceCheck> => [
  check("background worker activity preserves task counts", "activity", () => Effect.gen(function* () {
    const activity = yield* subject.activity([{ ...idleWorker("first"), running: Effect.succeed(1) }, { ...idleWorker("second"), running: Effect.succeed(2) }], 4)
    yield* expect("activity", activity.runningWorkers === 3 && activity.runningTasks === 4 && activity.inFlight, "worker or task counts were replaced or omitted")
  })),
  check("sleeping background workers are idle", "sleeping", () => Effect.gen(function* () {
    const activity = yield* subject.activity([idleWorker("poller")], 0)
    yield* expect("sleeping", activity.runningWorkers === 0 && !activity.inFlight, "an idle poller counted as work")
  })),
  check("background worker shutdown stops claims", "stop", () => Effect.gen(function* () {
    const stopped = yield* Ref.make(false)
    const report = yield* subject.shutdown([{ ...idleWorker("stops"), stop: Ref.set(stopped, true) }], { deadline: "100 millis" })
    yield* expect("stop", (yield* Ref.get(stopped)) && report.idle && !report.left.inFlight, "an idle worker was not stopped before shutdown returned")
  })),
  check("background worker shutdown interrupts remaining work", "interrupt", () => Effect.gen(function* () {
    const running = yield* Ref.make(1)
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const report = yield* subject.shutdown([{
      id: "blocked", running: Ref.get(running), idle: Ref.get(running).pipe(Effect.flatMap((count) => count === 0 ? Effect.void : Effect.never)),
      stop: Ref.update(calls, (all) => [...all, "stop"]),
      interrupt: Ref.update(calls, (all) => [...all, "interrupt"]).pipe(Effect.andThen(Ref.set(running, 0))),
    }], { deadline: "40 millis", reserve: "20 millis" })
    yield* expect("interrupt", (yield* Ref.get(calls)).join() === "stop,interrupt" && !report.left.inFlight, "unfinished work was not stopped and interrupted")
  })),
]
