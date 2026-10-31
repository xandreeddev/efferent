import { expect, test } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Logger, Option, References, Schema, Tracer } from "effect"
import {
  ConversationId, HarnessError, RunId, RunOrdinal, SessionLogMemoryLive, Sessions, TaskActivity,
  TaskExecutor, TaskQuestionId, Tasks, TurnAdmissionOpen, turnEndingOf,
} from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { answerInputId } from "./task-controls.entity.functions.js"
import { TaskStarted, tasksDefaults } from "./task-records.entity.js"
import { InProcessTaskRunnerLive } from "./task-runner.adapter.js"
import { TasksLive } from "./tasks.adapter.js"

const remote = Tracer.externalSpan({ traceId: "b".repeat(32), spanId: "b".repeat(16), sampled: false })
const setup = (turn: Context.Service.Shape<typeof TaskExecutor>["turn"]) => Effect.gen(function* () {
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
    SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))),
    InProcessTaskRunnerLive(), Layer.succeed(TaskExecutor, TaskExecutor.of({ turn, react: () => Effect.void })),
  ))))
  const sessions = Context.get(built, Sessions)
  const tasks = Context.get(built, Tasks)
  const parent = { owner: "task-trace", id: ConversationId.make("00000000-0000-4000-8000-000000003061") }
  yield* sessions.create(parent)
  return { sessions, tasks, parent, idle: Context.get(built, TaskActivity).idle }
})

test.each(["failure", "interruption"] as const)("a traced queued execution preserves its %s and records one failed task.run", (mode) => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  const failure = new HarnessError({ code: "task.turn", message: "scripted follow-up failure" })
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const questionId = TaskQuestionId.make("trace-question")
    const h = yield* setup((writer) => writer.admitted.origin === "task" ? Tasks.pipe(Effect.flatMap((tasks) => tasks.ask(writer, {
      questionId, text: "Which trace should I follow?",
      askedBy: { run: { id: writer.admitted.runId, turn: writer.admitted.turn, ordinal: RunOrdinal.make(0) }, step: 0 },
    })), Effect.orDie, Effect.as({ outcome: "waiting" as const, reply: Option.none() }))
      : mode === "failure" ? Effect.fail(failure) : Effect.interrupt,
    ).pipe(Effect.withParentSpan(Tracer.externalSpan({ traceId: "a".repeat(32), spanId: "a".repeat(16) })))
    const task = yield* h.tasks.start(h.parent, { instructions: "wait for trace input", mode: "spawn" }).pipe(Effect.withParentSpan(remote))
    yield* h.idle
    const row = (yield* h.sessions.read(h.parent, { kinds: ["task.started"] }))[0]
    const saved = yield* Schema.decodeUnknownEffect(TaskStarted)(row?.data)
    if (saved.traceParent === undefined) return yield* Effect.die("the task's trace ancestry was not captured")
    const ancestry = saved.traceParent
    expect(ancestry.sampled).toBe(false)
    expect(spans.filter((span) => span.name === "task.run")).toHaveLength(1)
    yield* h.tasks.answer(h.parent, task.taskId, { questionId, text: "Keep the original trace." })
    const child = { owner: h.parent.owner, id: task.child }
    const exit = yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* h.sessions.begin(child, { _tag: "Queued", input: answerInputId(task.taskId, questionId), runId: RunId.make(`traced-${mode}`) })
      const result = yield* Effect.exit(h.tasks.execute(writer))
      yield* writer.end(turnEndingOf(result))
      return result
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(mode === "failure" ? Option.contains(Cause.findErrorOption(exit.cause), failure) : Cause.hasInterrupts(exit.cause)).toBe(true)
    const executions = spans.filter((span) => span.name === "task.run")
    expect(executions).toHaveLength(2)
    expect(executions.map((span) => [span.traceId, Option.map(span.parent, (parent) => parent.spanId), span.sampled]))
      .toEqual(executions.map(() => [ancestry.traceId, Option.some(ancestry.spanId), false]))
    const last = executions.at(-1)
    expect(last?.status._tag === "Ended" && Exit.isFailure(last.status.exit)).toBe(true)
    expect((yield* h.sessions.get(child)).pending).toBe(1)
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("pending")
    expect((yield* h.sessions.read(child, { kinds: ["task.result"] }))).toHaveLength(0)
  })).pipe(Effect.withTracer(tracer), Effect.timeout("3 seconds")))
})

test("invalid custom ancestry logs fixed Debug text and never prevents task completion", () => {
  const lines: Array<readonly [string, string]> = []
  const logger = Logger.layer([Logger.make((options) => { lines.push([options.logLevel, [options.message].flat().join(" ")]) })])
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const h = yield* setup(() => Effect.succeed({ outcome: "completed", reply: Option.none() }))
    const task = yield* h.tasks.start(h.parent, { instructions: "tracing is optional", mode: "spawn" }).pipe(
      Effect.withParentSpan(Tracer.externalSpan({ traceId: "invalid-custom-trace", spanId: "invalid-custom-span" })),
    )
    yield* h.idle
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("completed")
    expect((yield* h.sessions.read(h.parent, { kinds: ["task.started"] })).every((event) => !Object.hasOwn(event.data, "traceParent"))).toBe(true)
    expect(lines.filter(([, message]) => message.includes("trace parent"))).toEqual([
      ["Debug", "the task's trace parent is invalid; durable ancestry was omitted"],
    ])
  })).pipe(Effect.provide(logger), Effect.provideService(References.MinimumLogLevel, "Debug"), Effect.timeout("3 seconds")))
})
