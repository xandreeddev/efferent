import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Tracer } from "effect"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { OpenSession, SessionId } from "@xandreed/core/kernel"
import { callTool, inbox, Inbox, inProcessJournal, sessions, taskReport, TaskReports, tasks, taskTools, taskHandlers } from "./index.js"
import type { TaskReport } from "./index.js"

/*
 * The turns a plugin runs on a fiber of its own (ADR 0030): the inbox's, one per message it takes, and a background
 * task's. Each is a trace of its own, a root `session.turn`, never a child of the span that was current where its
 * fiber was forked (the message's `inbox.enqueue`, the task's `tasks.start` inside the `tool.call` that asked for
 * it), which has ended long before the turn does.
 */

/** A tracer that keeps every span it opens, as Effect's own native spans. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  return { spans, tracer }
}

const parentName = (spans: ReadonlyArray<Tracer.NativeSpan>, span: Tracer.NativeSpan): string =>
  Option.match(span.parent, { onNone: () => "(root)", onSome: (parent) => spans.find((candidate) => candidate.spanId === parent.spanId)?.name ?? "(external)" })

const turnsOf = (spans: ReadonlyArray<Tracer.NativeSpan>, session: SessionId) =>
  spans.filter((span) => span.name === "session.turn" && span.attributes.get("efferent.session.id") === session)

const store = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

describe("a turn a plugin runs on a fiber of its own is a trace of its own", () => {
  test("the inbox's: three messages queued together, and three each queued after the last reply", async () => {
    const { spans, tracer } = recording()
    // The host's turn for a message: it stores the message and answers.
    const turn = (session: SessionId, message: string) => Effect.orDie(Effect.flatMap(Sessions, (all) => all.turn(session, (open) => Effect.as(open.append(userMessage(message)), `ok ${message}`))))
    const sessionsOf = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      const queue = yield* Inbox
      const together = yield* all.create({ owner: "host" })
      const queued = yield* Effect.forEach(["a", "b", "c"], (message) => queue.enqueue(together, message), { concurrency: 1 })
      yield* Effect.forEach(queued, (one) => one.reply, { concurrency: 1 })
      const oneByOne = yield* all.create({ owner: "host" })
      yield* Effect.forEach(["d", "e", "f"], (message) => Effect.flatMap(queue.enqueue(oneByOne, message), (one) => one.reply), { concurrency: 1 })
      return [together, oneByOne] as const
    }).pipe(Effect.withSpan("host.program"))).pipe(
      Effect.provide(inbox(turn).pipe(Layer.provideMerge(store))),
      Effect.withTracer(tracer),
    ))
    for (const session of sessionsOf) {
      const turns = turnsOf(spans, session)
      expect(turns.length).toBe(3)
      expect(turns.map((span) => parentName(spans, span))).toEqual(["(root)", "(root)", "(root)"])
      expect(new Set(turns.map((span) => span.traceId)).size).toBe(3)
    }
  })

  test("a background task's: started by a tool call in a turn, run in a turn of its own, reported in a turn of the host's", async () => {
    const { spans, tracer } = recording()
    const run = (session: OpenSession, task: string) => Effect.as(session.append(userMessage(task)), `${task} done`)
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reports = yield* Queue.unbounded<TaskReport>()
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const toolkit = yield* taskTools
        const parent = yield* all.create({ owner: "host" })
        yield* all.turn(parent, (open) => Effect.andThen(open.append(userMessage("start it")), callTool(toolkit, { id: "c1", name: "startTask", params: { task: "find it" } }, open)))
          .pipe(Effect.withSpan("host.first_turn"))
        const report = yield* Queue.take(reports)
        // The report, in a turn of the host's own, under the span the host holds.
        yield* all.turn(parent, (open) => open.append(taskReport(report))).pipe(Effect.withSpan("host.report_turn"))
        return { parent, task: report.session }
      }).pipe(Effect.provide(Layer.mergeAll(taskHandlers, tasks(run)).pipe(
        Layer.provide(Layer.succeed(TaskReports, TaskReports.of({ deliver: (report) => Effect.asVoid(Queue.offer(reports, report)) }))),
      )))
    }).pipe(Effect.provide(store), Effect.withTracer(tracer), Effect.timeout("5 seconds"))))
    const [taskTurn] = turnsOf(spans, out.task)
    expect(parentName(spans, taskTurn!)).toBe("(root)")
    expect(turnsOf(spans, out.parent).map((span) => parentName(spans, span))).toEqual(["host.first_turn", "host.report_turn"])
    expect(new Set([taskTurn!.traceId, ...turnsOf(spans, out.parent).map((span) => span.traceId)]).size).toBe(3)
  })
})
