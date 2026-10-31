import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref } from "effect"
import { ConversationId, RunContext, SessionLogError, SessionMissing, TaskMissing, TaskRefused, TaskConflict, TaskQuestionId, Tasks } from "@xandreed/core"
import type { TaskView } from "@xandreed/core"
import { tasksCapability } from "./tasks-capability.adapter.js"

const [startTask, taskStatus] = tasksCapability.tools

describe("the model's task tools", () => {
  test("start_task says what a fork sees, that instructions carry the rest, and that tasks do not nest", () => {
    expect(startTask!.tool.description).toBe("Start a background task: another run of you works on the instructions while this conversation goes on, and its result comes back here when it finishes, for you to answer then. Use it for long work the user need not wait for, and say that you started it. Put everything the task needs in instructions: with mode spawn it sees only them; with mode fork it also sees this conversation up to the user's latest message, but not that message or anything you did since. A background task cannot start another.")
    expect(taskStatus!.tool.description).toBe("Check a background task this conversation started: whether it is running, needs an answer, or has finished. When it needs an answer, use its question id with answer_task.")
  })

  test("helper controls describe waiting, durable answers, steering and cancellation exactly", () => {
    expect(tasksCapability.version).toBe("2")
    expect(tasksCapability.tools.slice(2).map((entry) => entry.tool.description)).toEqual([
      "Ask the conversation that started this background task for information you need. Returns a question id and ends this turn while you wait; the answer arrives in a later turn. Ask one question per turn. Use this only from a background task, and include everything needed to answer.",
      "Send a course correction to a background task this conversation started. Returns whether the message was queued and how many inputs are pending. The task reads it at its next step or turn. If the task needs an answer, use answer_task instead.",
      "Answer a question from a background task this conversation started. Give the question id from its notice or task_status. Returns accepted once the answer is stored and enqueued when it reached the task's inbox; an accepted answer waits for space automatically. The task continues in a later turn. Use steer_task for a course correction when no question is pending.",
      "Cancel a background task this conversation started. Returns whether it was cancelled. A task that already finished stays finished; a cancelled task does no more work and sends no result.",
    ])
    expect(tasksCapability.tools.slice(2).map((entry) => entry.requires)).toEqual(Array.from({ length: 4 }, () => [RunContext.key, Tasks.key]))
  })

  test("both tools declare the run and the tasks they read, so a run without them does not open its tools", () => {
    expect([startTask!.requires, taskStatus!.requires]).toEqual([[RunContext.key, Tasks.key], [RunContext.key, Tasks.key]])
  })

  test("start_task starts the task with the turn's own meta, unchanged, and the turn whose run started it", async () => {
    const started = await Effect.runPromise(Effect.gen(function* () {
      const inputs = yield* Ref.make<ReadonlyArray<unknown>>([])
      const taskId = ConversationId.make("00000000-0000-4000-8000-0000000007a1")
      const view: TaskView = {
        taskId, parent: ConversationId.make("00000000-0000-4000-8000-0000000007a2"), child: taskId, instructions: "x", mode: "spawn",
        status: "pending", reply: Option.none(), failure: Option.none(), delivered: false,
      }
      const tasks = Tasks.of({ start: (_parent: unknown, input: unknown) => Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as(view)) } as never)
      const run = RunContext.of({ session: { id: view.parent, owner: "owner-1" }, runId: "run-7", admitted: { turn: 3, meta: { tenant: "acme" } } } as never)
      // The handler declares the services it reads, the run and the tasks, and gets them where it runs.
      const output = yield* startTask!.handler({ instructions: "count", mode: "spawn" }).pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run))
      return { output, inputs: yield* Ref.get(inputs) }
    }))
    expect(started).toEqual({
      output: { taskId: "00000000-0000-4000-8000-0000000007a1", status: "pending" },
      inputs: [{ instructions: "count", mode: "spawn", meta: { tenant: "acme" }, startedBy: { runId: "run-7", turn: 3 } }],
    })
  })

  test("task_status answers a task id no task has as UnknownTask, and asks the tasks only for an id that can be one", async () => {
    const parent = ConversationId.make("00000000-0000-4000-8000-0000000007b1")
    const stranger = ConversationId.make("00000000-0000-4000-8000-0000000007b2")
    const asked = await Effect.runPromise(Effect.gen(function* () {
      const looked = yield* Ref.make<ReadonlyArray<string>>([])
      const tasks = Tasks.of({
        status: (_parent: unknown, taskId: ConversationId) => Ref.update(looked, (all) => [...all, taskId]).pipe(Effect.andThen(Effect.fail(new TaskMissing({ session: parent, taskId })))),
      } as never)
      const run = RunContext.of({ session: { id: parent, owner: "owner-1" } } as never)
      const answer = (taskId: string) => Effect.flip(taskStatus!.handler({ taskId }).pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run)))
      return { answers: [yield* answer("task-1"), yield* answer(stranger)], looked: yield* Ref.get(looked) }
    }))
    expect(asked).toEqual({
      answers: [
        { error: "UnknownTask", message: "No task task-1 was started in this conversation" },
        { error: "UnknownTask", message: `No task ${stranger} was started in this conversation` },
      ],
      looked: [stranger],
    })
  })

  test("a refused start returns the refusal's message; any other failure of either tool says the tasks are unavailable", async () => {
    const parent = ConversationId.make("00000000-0000-4000-8000-0000000007c1")
    const task = ConversationId.make("00000000-0000-4000-8000-0000000007c2")
    const answers = await Effect.runPromise(Effect.gen(function* () {
      const refusing = yield* Ref.make(true)
      const tasks = Tasks.of({
        start: () => Ref.get(refusing).pipe(Effect.flatMap((refuse) => Effect.fail(refuse
          ? new TaskRefused({ session: parent, reason: "depth", message: "a background task cannot start another task" })
          : new SessionLogError({ code: "store.io", message: "the store is down" })))),
        status: () => Effect.fail(new SessionMissing({ session: parent })),
      } as never)
      const run = RunContext.of({ session: { id: parent, owner: "owner-1" }, runId: "run-8", admitted: { meta: {} } } as never)
      const provided = <A, E>(effect: Effect.Effect<A, E, Tasks | RunContext>) => Effect.flip(effect.pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run)))
      const refused = yield* provided(startTask!.handler({ instructions: "deeper", mode: "spawn" }))
      yield* Ref.set(refusing, false)
      return [refused, yield* provided(startTask!.handler({ instructions: "deeper", mode: "spawn" })), yield* provided(taskStatus!.handler({ taskId: task }))]
    }))
    expect(answers).toEqual([
      { error: "TaskRefused", message: "a background task cannot start another task" },
      { error: "TasksUnavailable", message: "Background tasks are unavailable right now; try again later, or do the work in this conversation" },
      { error: "TasksUnavailable", message: "Background tasks are unavailable right now; try again later, or do the work in this conversation" },
    ])
  })
})


test("helper control failures preserve safe exact context and conflict guidance", async () => {
  const parent = ConversationId.make("00000000-0000-4000-8000-0000000007d1")
  const taskId = ConversationId.make("00000000-0000-4000-8000-0000000007d2")
  const run = RunContext.of({ session: { id: parent, owner: "owner-1" }, admitted: {} } as never)
  const tasks = Tasks.of({ answer: () => Effect.fail(new TaskConflict({ session: parent, taskId })) } as never)
  const answers = await Effect.runPromise(Effect.gen(function* () {
    const ask = tasksCapability.tools.find((entry) => entry.tool.name === "ask_parent")!
    const answer = tasksCapability.tools.find((entry) => entry.tool.name === "answer_task")!
    return [
      yield* Effect.flip(ask.handler({ text: "Question" }).pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run))),
      yield* Effect.flip(answer.handler({ taskId, questionId: TaskQuestionId.make("q"), text: "Answer" }).pipe(Effect.provideService(Tasks, tasks), Effect.provideService(RunContext, run))),
    ]
  }))
  expect(answers).toEqual([
    { error: "TaskContextRequired", message: "Use this control from a running step of the conversation or its background task" },
    { error: "TaskConflict", message: "This task control was already stored with different content; check task_status before trying again" },
  ])
})
