import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { ConversationId, InboxItemId, RunId, SessionLogMemoryLive, Sessions, TaskActivity, TaskRunner, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksLive, tasksCapability, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import { agentTaskExecutor } from "./task-executor.adapter.js"

test.each(["spawn", "fork"] as const)("an early queued steer cannot bypass a %s helper's original task admission", (mode) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.update(prompts, (all) => [...all, JSON.stringify(options.prompt.content)]).pipe(Effect.as([
      { type: "text", text: "The original task and its steer were applied." },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
    ])),
    streamText: () => Stream.die("not scripted"),
  })
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [tasksCapability],
    turnServices: [LanguageModel.LanguageModel], limits: { streaming: false },
  })
  const workers = yield* Layer.build(InProcessTaskRunnerLive())
  const runner = Context.get(workers, TaskRunner)
  const activity = Context.get(workers, TaskActivity)
  const dropping = yield* Ref.make(true)
  const controlled = TaskRunner.of({ run: (work) => Ref.get(dropping).pipe(Effect.flatMap((drop) => drop ? Effect.void : runner.run(work))) })
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
    SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))),
    Layer.succeed(TaskRunner, controlled),
    agentTaskExecutor(agent, { services: Context.make(LanguageModel.LanguageModel, model), react: (turn) => turn.reply("The task result is available.") }),
  ))))
  const sessions = Context.get(built, Sessions)
  const tasks = Context.get(built, Tasks)
  const parent = { owner: "helper-admission-journey", id: ConversationId.make(mode === "spawn"
    ? "00000000-0000-4000-8000-000000003051" : "00000000-0000-4000-8000-000000003052") }
  yield* sessions.create(parent)
  // A fork's first own turn has an inherited turn-number offset.
  yield* Effect.scoped(sessions.begin(parent, { _tag: "User", runId: RunId.make(`seed-${mode}`), key: `seed-${mode}`,
    userMessage: new UserMessage({ text: "Earlier parent context." }), command: {},
  }).pipe(Effect.flatMap((writer) => writer.end({ reason: "completed", failure: Option.none() }))))
  const task = yield* tasks.start(parent, { taskId: ConversationId.make(mode === "spawn"
    ? "00000000-0000-4000-8000-000000003151" : "00000000-0000-4000-8000-000000003152"), instructions: "Inspect the original task source.", mode })
  const steer = { id: InboxItemId.make(`early-steer-${mode}`), userMessage: new UserMessage({ text: "Check its changelog before editing." }), source: { kind: "journey" } }
  yield* tasks.steer(parent, task.taskId, steer)
  const child = { owner: parent.owner, id: task.child }
  const bookkeeping = yield* Effect.scoped(Effect.gen(function* () {
    const writer = yield* sessions.begin(child, { _tag: "Queued", runId: RunId.make(`early-queued-${mode}`), input: steer.id })
    const outcome = yield* tasks.execute(writer)
    yield* writer.end({ reason: outcome.outcome, failure: Option.none() })
    return outcome
  }))
  expect(bookkeeping).toEqual({ outcome: "waiting", reply: Option.none() })
  expect(yield* Ref.get(prompts)).toEqual([])
  expect((yield* tasks.status(parent, task.taskId)).status).toBe("pending")
  const before = yield* sessions.read(child)
  expect(before.filter((event) => event.kind === "turn.started").map((event) => event.data.userMessage)).toEqual([{ text: steer.userMessage.text }])
  expect(before.filter((event) => event.kind === "task.result")).toHaveLength(0)
  yield* Ref.set(dropping, false)
  yield* tasks.reconcile(parent)
  yield* activity.idle
  yield* tasks.reconcile(parent)
  yield* activity.idle
  const sent = yield* Ref.get(prompts)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain("Inspect the original task source.")
  expect(sent[0]).toContain("Check its changelog before editing.")
  expect((yield* tasks.status(parent, task.taskId)).status).toBe("completed")
  const events = yield* sessions.read(child)
  expect(events.filter((event) => event.kind === "turn.started").map((event) => [event.data.origin, event.data.key])).toEqual([
    ["user", `input:${steer.id}`], ["task", `task:${task.taskId}`],
  ])
  expect(events.filter((event) => event.kind === "task.result")).toHaveLength(1)
})).pipe(Effect.timeout("8 seconds"))))
