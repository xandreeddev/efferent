import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema, Tracer } from "effect"
import { failureCode } from "../conformance.functions.js"
import { Failure } from "../domain/failure.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { CurrentTraceContent } from "../loop/traceContent.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { turnEndingOf } from "../session/sessions.entity.functions.js"
import { ReservedKind, SessionContended, TurnClosed } from "../session/sessions.entity.js"
import { harnessDefectsAsFailures, makeTurnEvents, makeTurnTasks } from "./turn-bus.js"
import { defineHostEvent, onEvent, onTool, subscribeAll } from "./turn-event.entity.functions.js"
import type { TurnEvent } from "./turn-event.entity.js"

const started = (step: number): TurnEvent => ({ _tag: "step.started", step, planned: false, activeTools: [] })
const session = ConversationId.make("00000000-0000-4000-8000-0000000000e1")
const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ id: Schema.String }),
  failure: Failure,
  failureMode: "return",
})
const completed = (tool: string, input: unknown, result: unknown): TurnEvent => ({
  _tag: "tool.completed", step: 0, invocationId: "i1", tool, input, ok: true, result, encoded: result, durationMs: 1, labels: {}, stage: Option.none(),
})
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.result(effect))

describe("the turn event bus", () => {
  test("delivers inline, in subscription order and depth-first", async () => {
    const log = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (text: string) => Ref.update(seen, (all) => [...all, text])
      yield* onEvent("step.started", (event) => note(`a${event.step}`).pipe(Effect.andThen(event.step === 0 ? events.publish(started(1)) : Effect.void)))(events)
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
    expect(exit._tag === "Failure" ? failureCode(exit.failure) : "none").toBe("events.depth")
  })

  test("a failing handler fails the publisher, and a subscription ends with its scope", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const failing = yield* Effect.result(Effect.scoped(Effect.gen(function* () {
        yield* onEvent("step.started", () => Effect.fail(new HarnessError({ code: "reaction.failed", message: "no" })))(events)
        yield* events.publish(started(0))
      })))
      const afterScope = yield* Effect.result(events.publish(started(1)))
      return { failing: failing._tag === "Failure" ? failureCode(failing.failure) : "none", afterScope: afterScope._tag }
    })))
    expect(outcome).toEqual({ failing: "reaction.failed", afterScope: "Success" })
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
      const Page = defineHostEvent("page.ready", Schema.Struct({ id: Schema.String, at: Schema.DateFromMillis }))
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Page.on((page) => Ref.update(seen, (all) => [...all, `${page.id}@${page.at.getTime()}`]))(events)
      yield* Page.publish(events, { id: "p1", at: new Date(5) })
      return yield* Ref.get(seen)
    })))
    expect(pages).toEqual(["p1@5"])
  })

  test("a host event carries its encoded payload as JSON: an undefined field is left out, a BigInt fails with events.encode", async () => {
    const Note = defineHostEvent("note.saved", Schema.Struct({ id: Schema.String, draft: Schema.optional(Schema.String) }))
    const Tally = defineHostEvent("tally.saved", Schema.Struct({ n: Schema.BigInt }))
    const note = await Effect.runPromise(Note.make({ id: "a", draft: undefined }))
    const tally = await run(Tally.make({ n: 1n }))
    expect(note._tag === "host" ? note.data : {}).toStrictEqual({ id: "a" })
    expect(tally._tag === "Failure" ? failureCode(tally.failure) : "made").toBe("events.encode")
  })

  test("a background subscription handles events in order, off the publisher's path, and drain waits for it", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const gate = yield* Deferred.make<void>()
      const seen = yield* Ref.make<ReadonlyArray<number>>([])
      yield* onEvent("step.started", (event) => Deferred.await(gate).pipe(Effect.andThen(Ref.update(seen, (all) => [...all, event.step]))), { mode: "background" })(events)
      yield* Effect.forEach([0, 1, 2], (step) => events.publish(started(step)), { discard: true })
      const beforeDrain = yield* Ref.get(seen)
      yield* Deferred.succeed(gate, undefined)
      yield* events.drain
      return { beforeDrain, afterDrain: yield* Ref.get(seen) }
    })))
    expect(outcome).toEqual({ beforeDrain: [], afterDrain: [0, 1, 2] })
  })

  test("drain also waits for what background handlers publish meanwhile", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      yield* onEvent("step.started", (event) => Effect.sleep("5 millis").pipe(
        Effect.andThen(Ref.update(log, (all) => [...all, `first${event.step}`])),
        Effect.andThen(event.step === 0 ? events.publish(started(1)) : Effect.void),
      ), { mode: "background" })(events)
      yield* onEvent("step.started", (event) => Effect.sleep("5 millis").pipe(Effect.andThen(Ref.update(log, (all) => [...all, `second${event.step}`]))), { mode: "background" })(events)
      yield* events.publish(started(0))
      yield* events.drain
      return yield* Ref.get(log)
    })))
    expect([...seen].sort()).toEqual(["first0", "first1", "second0", "second1"])
  })

  test("a failed background handler fails the drain and the next delivery, and skips the rest", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<number>>([])
      yield* onEvent("step.started", (event) => event.step === 1
        ? Effect.fail(new HarnessError({ code: "reaction.failed", message: "no" }))
        : Ref.update(seen, (all) => [...all, event.step]), { mode: "background" })(events)
      yield* Effect.forEach([0, 1, 2], (step) => events.publish(started(step)), { discard: true })
      const drained = yield* Effect.result(events.drain)
      const next = yield* Effect.result(events.publish(started(3)))
      return {
        drained: drained._tag === "Failure" ? failureCode(drained.failure) : "none",
        next: next._tag === "Failure" ? failureCode(next.failure) : "none",
        seen: yield* Ref.get(seen),
      }
    })))
    expect(outcome).toEqual({ drained: "reaction.failed", next: "reaction.failed", seen: [0] })
  })

  test("a background handler's defect stays a defect: the drain and the next delivery die with it, and no failure carries its stack", async () => {
    // Made here, so its stack names this file.
    const defect = new Error("renderer crashed")
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      yield* onEvent("step.started", () => Effect.die(defect), { mode: "background" })(events)
      yield* events.publish(started(0))
      return { drained: yield* Effect.exit(events.drain), next: yield* Effect.exit(events.publish(started(1))) }
    })))
    const causes = [outcome.drained, outcome.next].map((exit) => exit._tag === "Failure" ? exit.cause : Cause.empty)
    expect(causes.map((cause) => [Cause.hasFails(cause), Cause.squash(cause) === defect])).toEqual([[false, true], [false, true]])
    // How the turn ends on it: the defect's message, without the stack.
    const ending = turnEndingOf(Exit.map(outcome.drained, () => ({ outcome: "completed" as const })))
    expect(Option.getOrThrow(ending.failure)).toEqual({ code: "turn.defect", message: "Error: renderer crashed" })
  })

  test("a HarnessError a background handler dies with is still the typed error the drain fails with; an interruption fails it with events.background", async () => {
    const drainedAfter = (handle: () => Effect.Effect<void, HarnessError>) => run(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      yield* onEvent("step.started", handle, { mode: "background" })(events)
      yield* events.publish(started(0))
      yield* events.drain
    })))
    const codes = await Promise.all([() => Effect.die(new HarnessError({ code: "reaction.died", message: "no" })), () => Effect.interrupt].map(async (handle) => {
      const drained = await drainedAfter(handle)
      return drained._tag === "Failure" ? `${failureCode(drained.failure)}: ${drained.failure.message}` : "none"
    }))
    expect(codes).toEqual(["reaction.died: no", "events.background: a background handler was interrupted"])
    const closed = await drainedAfter(() => Effect.die(new TurnClosed({ session, turn: 1, reason: "cancelled" })))
    expect(closed._tag === "Failure" ? [closed.failure._tag, failureCode(closed.failure)] : "none").toEqual(["TurnClosed", "turn.closed"])
  })

  test("harnessDefectsAsFailures restores a TurnError carried as a defect, from any copy of core, as the failure it is; any other defect stays one", async () => {
    const restored = (defect: unknown) => Effect.runPromise(Effect.exit(harnessDefectsAsFailures(Effect.die(defect)))).then((exit) =>
      Option.match(Exit.findErrorOption(exit), { onSome: (error) => `${error._tag} ${failureCode(error)}`, onNone: () => Exit.hasDies(exit) ? "died" : "other" }))
    const outcomes = await Promise.all([
      new TurnClosed({ session, turn: 1, reason: "cancelled" }),
      { _tag: "TurnClosed", session, turn: 1, reason: "removed" },
      new ReservedKind({ kind: "turn.ended" }),
      new SessionContended({ session, attempts: 3 }),
      new SessionLogError({ code: "store.io", message: "the disk is full" }),
      new HarnessError({ code: "reaction.died", message: "no" }),
      new Error("boom"),
      { code: "ENOENT", message: "no such file" },
      { _tag: "TurnClosed" },
    ].map(restored))
    expect(outcomes).toEqual([
      "TurnClosed turn.closed", "TurnClosed turn.closed", "ReservedKind events.reserved", "SessionContended session.contended",
      "SessionLogError session.log", "HarnessError reaction.died", "died", "died", "died",
    ])
  })

  test("a background handler that publishes what it takes, past its queue's size, neither deadlocks nor drops or reorders it", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<number>>([])
      yield* onEvent("step.started", (event) => Ref.update(seen, (all) => [...all, event.step]).pipe(
        Effect.andThen(event.step === 0 ? Effect.forEach([1, 2, 3], (step) => events.publish(started(step)), { discard: true }) : Effect.void),
      ), { mode: "background", capacity: 1 })(events)
      yield* events.publish(started(0))
      const drained = yield* events.drain.pipe(Effect.timeoutOption("2 seconds"))
      return { drained: Option.isSome(drained), seen: yield* Ref.get(seen) }
    })))
    expect(outcome).toEqual({ drained: true, seen: [0, 1, 2, 3] })
  })

  test("a publisher waiting for room in a full background queue can be interrupted, even where it is uninterruptible", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const entered = yield* Deferred.make<void>()
      yield* onEvent("step.started", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)), { mode: "background", capacity: 1 })(events)
      yield* events.publish(started(0))
      yield* Deferred.await(entered)
      // The handler is stuck on the first event; the second fills the queue; the third waits for room.
      yield* events.publish(started(1))
      const waiting = yield* Effect.forkChild(Effect.uninterruptible(events.publish(started(2))))
      yield* Effect.yieldNow
      const interrupted = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("2 seconds"))
      return Option.isSome(interrupted)
    })))
    expect(outcome).toBe(true)
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
        Effect.andThen(note("first")),
        Effect.andThen(tasks.fork("page", Effect.sleep("10 millis").pipe(Effect.andThen(note("second"))))),
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
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ))
        yield* Deferred.await(running)
      }))
      const failed = yield* Effect.result(Effect.scoped(Effect.gen(function* () {
        const tasks = yield* makeTurnTasks(yield* Effect.scope)
        yield* tasks.fork("broken", Effect.fail(new HarnessError({ code: "task.failed", message: "no" })))
        yield* tasks.await([])
      })))
      return { interrupted: yield* Deferred.isDone(interrupted), failed: failed._tag === "Failure" ? failureCode(failed.failure) : "none" }
    }))
    expect(outcome).toEqual({ interrupted: true, failed: "task.failed" })
  })
})

describe("a subscriber's trace", () => {
  test("a handler is traced where it is delivered: an inline one under the publisher's span and annotations, both with the publisher's trace content", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const reads = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 4 })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (mode: string) => () => Effect.service(CurrentTraceContent).pipe(
        Effect.flatMap((capture) => Ref.update(seen, (all) => [...all, `${mode}:${capture}`])),
        Effect.withSpan(`${mode}.handler`),
      )
      // Subscribed under a span of its own, annotated, with the switch on.
      yield* Effect.all([
        events.subscribe(Option.some, note("inline")),
        events.subscribe(Option.some, note("background"), { mode: "background" }),
      ]).pipe(Effect.provideService(CurrentTraceContent, true), Effect.annotateSpans({ "subscribed": true }), Effect.withSpan("subscribed.here"))
      yield* events.publish(started(0)).pipe(Effect.annotateSpans({ "efferent.turn": 1 }), Effect.withSpan("published.here"))
      yield* events.drain
      return yield* Ref.get(seen)
    })).pipe(Effect.withTracer(tracer)))
    expect([...reads].sort()).toEqual(["background:false", "inline:false"])
    const byId = new Map(spans.map((span) => [span.spanId, span] as const))
    const named = (name: string) => spans.find((span) => span.name === name)
    const parentOf = (name: string) => Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(named(name)), (span) => Option.flatMap(span.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId)?.name))))
    expect([parentOf("inline.handler"), parentOf("background.handler")]).toEqual(["published.here", "subscribed.here"])
    expect(["efferent.turn", "subscribed"].map((key) => named("inline.handler")?.attributes.get(key))).toEqual([1, undefined])
  })
})
