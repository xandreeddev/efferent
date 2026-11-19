// The chat's one queue (lesson 17, ADR 0018): the person's messages and the
// reports of background tasks wait in the same queue, in the order they came.
// A program takes one input at a time (`Chat.inputs`) and runs one turn for
// it; `drain` takes the messages waiting and leaves the reports, so a message
// sent during a turn steers it and a report waits for a turn of its own. A
// report still waiting when the program stops is dropped. The program here is
// a test's own, typed, with a step held on a signal: no model, no lesson.
import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Result, Stream } from "effect"
import { assistantMessage, dataOf, SessionId, Sessions, turnEndedEvent, userMessage } from "@xandreed/core"
import type { StoredEvent } from "@xandreed/core"
import { TaskId, taskReport, TaskReports, turnsOf } from "@xandreed/sdk"
import type { TaskReport } from "@xandreed/sdk"
import type { Lesson, PageParts } from "./lesson.ts"
import { loadEcho } from "./models/mock.ts"
import { Chat } from "./page-chat.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/**
 * The program: each input is one turn. A report is stored with `taskReport` in the session that started the task,
 * a message in the chat's. The turn drains the messages waiting, then takes one slow step, held until `step` is
 * done, then drains again (the messages sent meanwhile steer it), and answers.
 */
const program = (parts: PageParts, step: Deferred.Deferred<void>) => Effect.gen(function* () {
  const chat = yield* Chat
  const sessions = yield* Sessions
  yield* Stream.runForEach(chat.inputs, (input) => Effect.scoped(Effect.gen(function* () {
    const session = yield* sessions.open(input._tag === "Report" ? input.report.parent : chat.session)
    yield* session.append(input._tag === "Report" ? taskReport(input.report) : userMessage(input.text))
    for (const text of yield* chat.drain) yield* session.append(userMessage(text))
    yield* chat.status("step 1: slow")
    yield* Deferred.await(step)
    for (const text of yield* chat.drain) yield* session.append(userMessage(text))
    yield* session.append(assistantMessage("done"))
  })).pipe(Effect.andThen(chat.reply("done"))))
}).pipe(
  Effect.provide(parts.chatOn(parts.pane)),
  Effect.provide(parts.sessions()),
  Effect.provide(parts.inProcessJournal()),
  Effect.provide(parts.kernel()),
)

/** A lesson that runs that program, and hands the test the page's reports part of each build. */
const queueLesson = (step: Deferred.Deferred<void>, builds: Array<Layer.Layer<TaskReports>>): Lesson => ({
  slug: "queue", files: [], mainFile: "", chips: [], three: [], fill: [], controls: {}, experiments: {},
  evaluate: (_sources, parts) => {
    builds.push(parts.reportsOn(parts.pane))
    return Result.succeed(program(parts, step))
  },
})

const start = async () => {
  const step = await Effect.runPromise(Deferred.make<void>())
  const builds: Array<Layer.Layer<TaskReports>> = []
  const runtime = await LessonRuntime.create(queueLesson(step, builds))
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start({})).toEqual({ _tag: "Built" })
  const until = (match: (trace: Trace) => boolean) => new Promise<void>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (match(trace)) { stop(); resolve() } })
  })
  /** A report of the latest build's tasks, delivered as the plugin delivers one. */
  const deliver = (report: TaskReport) => {
    const reports = builds.at(-1)
    if (reports === undefined) throw new Error("no build has run")
    return Effect.runPromise(Effect.gen(function* () { yield* (yield* TaskReports).deliver(report) }).pipe(Effect.provide(reports)))
  }
  const release = () => Effect.runPromise(Deferred.succeed(step, undefined))
  /** Resolves once `count` replies in all were heard. */
  const replies = (count: number) => until(() => heard.filter((one) => one._tag === "Reply").length >= count)
  return { runtime, heard, until, deliver, release, replies }
}

const reportOf = (parent: SessionId, task: string, text: string): TaskReport =>
  ({ task: TaskId.make(task), parent, session: SessionId.make(`session-of-${task}`), outcome: "Finished", text })

/** Each turn's messages, a report by who sent it. */
const turnsSaid = (journal: ReadonlyArray<StoredEvent>) =>
  turnsOf(journal).map((turn) => turn.messages.map((message) => (message.from === undefined ? message.text : `report from ${message.from}`)))

const outcomes = (journal: ReadonlyArray<StoredEvent>) => journal.flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)

describe("the chat's one queue (lesson 17)", () => {
  test("a message sent mid-turn steers that turn; a report delivered mid-turn waits, and is answered in a turn of its own after", async () => {
    const { runtime, heard, until, deliver, release, replies } = await start()
    const slow = until((trace) => trace._tag === "Status")
    runtime.send("first")
    await slow
    // While the first turn's slow step runs: a report, then a message, then a second report.
    await deliver(reportOf(runtime.conversation, "t1", "one"))
    runtime.send("steer")
    await deliver(reportOf(runtime.conversation, "t2", "two"))
    const three = replies(3)
    await release()
    await three
    const journal = await runtime.journal()
    // The message steered the first turn; each report was answered in a turn of its own, in the order they came.
    expect(turnsSaid(journal)).toEqual([["first", "steer"], ["report from session-of-t1"], ["report from session-of-t2"]])
    expect(outcomes(journal)).toEqual(["Completed", "Completed", "Completed"])
    // A message taken is said, a report taken is not: two messages, each taken once.
    const order = heard.flatMap((trace) => (trace._tag === "Taken" ? [`taken ${trace.count}`] : trace._tag === "Reported" ? [`reported ${trace.task}`] : trace._tag === "Reply" ? ["reply"] : []))
    expect(order).toEqual(["taken 1", "reported t1", "reported t2", "taken 1", "reply", "reply", "reply"])
  })

  test("drain takes the messages and leaves the reports in their order, in one step", async () => {
    const { runtime, until, deliver, release, replies } = await start()
    const slow = until((trace) => trace._tag === "Status")
    runtime.send("first")
    await slow
    runtime.send("a")
    await deliver(reportOf(runtime.conversation, "t1", "one"))
    runtime.send("b")
    await deliver(reportOf(runtime.conversation, "t2", "two"))
    runtime.send("c")
    const three = replies(3)
    await release()
    await three
    // The first turn took a, b and c as it steered; t1 and t2 waited, in their order.
    expect(turnsSaid(await runtime.journal())).toEqual([["first", "a", "b", "c"], ["report from session-of-t1"], ["report from session-of-t2"]])
  })

  test("a report waiting when the program stops is dropped, on a rebuild, Stop and Clear context alike; a rebuild keeps the messages", async () => {
    const { runtime, heard, until, deliver } = await start()
    const slow = until((trace) => trace._tag === "Status")
    runtime.send("first")
    await slow
    await deliver(reportOf(runtime.conversation, "t1", "one"))
    runtime.send("waits")
    // Rebuild: the turn ends Interrupted, the report is dropped, the message stays and is taken by the next program.
    const next = until((trace) => trace._tag === "Status" && heard.filter((one) => one._tag === "Status").length === 2)
    expect(await runtime.start({})).toEqual({ _tag: "Built" })
    await next
    expect(heard.filter((trace) => trace._tag === "ReportsDropped")).toEqual([{ _tag: "ReportsDropped", sessions: ["session-of-t1"] }])
    // Stop: a report waiting is dropped, and so is a message.
    await deliver(reportOf(runtime.conversation, "t1", "again"))
    runtime.send("dropped by Stop")
    const stopped = await runtime.stop()
    expect(stopped.dropped).toEqual(["dropped by Stop"])
    expect(heard.filter((trace) => trace._tag === "ReportsDropped").at(-1)).toEqual({ _tag: "ReportsDropped", sessions: ["session-of-t1"] })
    // Clear context: the same.
    await deliver(reportOf(runtime.conversation, "t1", "once more"))
    const journalBeforeClear = await runtime.journal()
    expect(await runtime.clear()).toEqual({ _tag: "Built" })
    expect(heard.filter((trace) => trace._tag === "ReportsDropped")).toHaveLength(3)
    // No report was ever taken: none is stored, in the old conversation or the new one.
    expect(turnsSaid(await runtime.journal())).toEqual([])
    expect(heard.some((trace) => trace._tag === "Reply")).toBe(false)
    expect(outcomes(journalBeforeClear)).toEqual(["Interrupted", "Interrupted"])
    expect(turnsSaid(journalBeforeClear)).toEqual([["first"], ["waits"]])
  })
})
