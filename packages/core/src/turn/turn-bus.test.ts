import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Deferred, Effect, Option, Ref, Schema } from "effect"
import { Failure } from "../domain/failure.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { makeTurnEvents, makeTurnTasks } from "./turn-bus.js"
import { defineHostEvent, journalBodyOf, onEvent, onTool, subscribeAll } from "./turn-event.entity.functions.js"
import type { TurnEvent } from "./turn-event.entity.js"

const started = (step: number): TurnEvent => ({ _tag: "step.started", step, planned: false, activeTools: [] })
const Lookup = Tool.make("lookup", {
  parameters: { query: Schema.String },
  success: Schema.Struct({ id: Schema.String }),
  failure: Failure,
  failureMode: "return",
})
const completed = (tool: string, input: unknown, result: unknown): TurnEvent => ({
  _tag: "tool.completed", step: 0, invocationId: "i1", tool, input, ok: true, result, encoded: result, durationMs: 1, labels: {}, stage: Option.none(),
})
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.either(effect))

describe("the turn event bus", () => {
  test("delivers inline, in subscription order and depth-first", async () => {
    const log = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (text: string) => Ref.update(seen, (all) => [...all, text])
      yield* onEvent("step.started", (event) => note(`a${event.step}`).pipe(Effect.zipRight(event.step === 0 ? events.publish(started(1)) : Effect.void)))(events)
      yield* onEvent("step.started", (event) => note(`b${event.step}`))(events)
      yield* events.publish(started(0))
      yield* note("after")
      return yield* Ref.get(seen)
    })))
    expect(log).toEqual(["a0", "a1", "b1", "b0", "after"])
  })

  test("a reaction cycle hits the depth cap and fails the publisher", async () => {
    const exit = await run(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 3 })
      yield* onEvent("step.started", (event) => events.publish(started(event.step + 1)))(events)
      yield* events.publish(started(0))
    })))
    expect(exit._tag === "Left" ? exit.left.code : "none").toBe("events.depth")
  })

  test("a failing handler fails the publisher, and a subscription ends with its scope", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const failing = yield* Effect.either(Effect.scoped(Effect.gen(function* () {
        yield* onEvent("step.started", () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "no" })))(events)
        yield* events.publish(started(0))
      })))
      const afterScope = yield* Effect.either(events.publish(started(1)))
      return { failing: failing._tag === "Left" ? failing.left.code : "none", afterScope: afterScope._tag }
    })))
    expect(outcome).toEqual({ failing: "reaction.failed", afterScope: "Right" })
  })

  test("onTool narrows to the tool's own schemas and skips what does not decode", async () => {
    const ids = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* subscribeAll(events, [onTool(Lookup, ({ input, result }) => Ref.update(seen, (all) => [...all, `${input.query}:${result.id}`]))])
      yield* events.publish(completed("lookup", { query: "alpha" }, { id: "r1" }))
      yield* events.publish(completed("lookup", { query: 7 }, { id: "r2" }))
      yield* events.publish(completed("other", { query: "beta" }, { id: "r3" }))
      return yield* Ref.get(seen)
    })))
    expect(ids).toEqual(["alpha:r1"])
  })

  test("host events round-trip through their schema", async () => {
    const pages = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const Page = defineHostEvent("page.ready", Schema.Struct({ id: Schema.String, at: Schema.DateFromNumber }))
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Page.on((page) => Ref.update(seen, (all) => [...all, `${page.id}@${page.at.getTime()}`]))(events)
      yield* Page.publish(events, { id: "p1", at: new Date(5) })
      return yield* Ref.get(seen)
    })))
    expect(pages).toEqual(["p1@5"])
  })

  test("the journal form drops transient events and decoded results", () => {
    expect(Option.isNone(journalBodyOf("run-1", { _tag: "assistant.delta", step: 0, channel: "text", id: "t", delta: "hi" }))).toBe(true)
    const body = Option.getOrThrow(journalBodyOf("run-1", completed("lookup", { query: "alpha" }, { id: "r1" })))
    expect(body.name).toBe("tool.completed")
    expect(body.runId).toBe("run-1")
    expect("result" in body.data).toBe(false)
    expect(body.data.encoded).toEqual({ id: "r1" })
    expect(body.data.stage).toBeNull()
  })
})

describe("turn tasks", () => {
  test("await joins tagged tasks, including the ones they fork meanwhile", async () => {
    const log = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const tasks = yield* makeTurnTasks(scope)
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (text: string) => Ref.update(seen, (all) => [...all, text])
      yield* tasks.fork("page", Effect.sleep("10 millis").pipe(
        Effect.zipRight(note("first")),
        Effect.zipRight(tasks.fork("page", Effect.sleep("10 millis").pipe(Effect.zipRight(note("second"))))),
      ))
      yield* tasks.fork("other", Effect.never)
      const pendingBefore = yield* tasks.pending("page")
      yield* tasks.await(["page"])
      return { seen: yield* Ref.get(seen), pendingBefore, pendingAfter: yield* tasks.pending("page"), other: yield* tasks.pending("other") }
    })))
    expect(log).toEqual({ seen: ["first", "second"], pendingBefore: true, pendingAfter: false, other: true })
  })

  test("closing the scope interrupts running tasks; a failed task fails await", async () => {
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      yield* Effect.scoped(Effect.gen(function* () {
        const tasks = yield* makeTurnTasks(yield* Effect.scope)
        yield* tasks.fork("slow", Deferred.succeed(running, undefined).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ))
        yield* Deferred.await(running)
      }))
      const failed = yield* Effect.either(Effect.scoped(Effect.gen(function* () {
        const tasks = yield* makeTurnTasks(yield* Effect.scope)
        yield* tasks.fork("broken", Effect.fail(new HarnessError({ code: "task.failed", message: "no" })))
        yield* tasks.await([])
      })))
      return { interrupted: yield* Deferred.isDone(interrupted), failed: failed._tag === "Left" ? failed.left.code : "none" }
    }))
    expect(outcome).toEqual({ interrupted: true, failed: "task.failed" })
  })
})
