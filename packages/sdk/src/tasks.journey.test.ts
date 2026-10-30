import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, RunId, SessionLogMemoryLive, Sessions, TaskActivity, TaskExecutor, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { SessionLogEvent, Turn } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, tasksCapability, TasksLive, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import { agentTaskExecutor } from "./task-executor.adapter.js"

/*
 * A journey, key-free, with scripted models: a user's turn starts a
 * background task through the model's `start_task`; the task's child turn
 * runs through the same agent (`agentTaskExecutor`), its result is
 * delivered to the parent's inbox while the parent's turn is still open, the
 * turn's end counts it as `pending`, and the caller's drain lets the parent
 * answer it.
 */

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const text = (answer: string): Part => [{ type: "text", text: answer }, { type: "finish", reason: "stop", usage }]

/** A scripted provider: its answers in order, and the prompt of every request it was sent. */
const scripted = (script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.map((index) => (script[index] ?? text("unscripted")) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { prompts, model }
})

const session = { id: ConversationId.make("00000000-0000-4000-8000-0000000000ab"), owner: "journey" }
const ofKind = (events: ReadonlyArray<SessionLogEvent>, kind: string) => events.filter((event) => event.kind === kind)

/** The agent, and Tasks beside it over in-memory sessions, its executor the agent's own turns (`agentTaskExecutor`), with the session created. */
const tasksBeside = (executor: (agent: Agent) => Layer.Layer<TaskExecutor>) => Effect.gen(function* () {
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [tasksCapability],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 4 },
  })
  const sessionsLayer = SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(sessionsLayer, InProcessTaskRunnerLive(), executor(agent)))))
  const sessions = Context.get(built, Sessions)
  yield* sessions.create({ owner: session.owner, id: session.id })
  return { agent, built, sessions, tasks: Context.get(built, Tasks), idle: Context.get(built, TaskActivity).idle }
})

describe("journey: a background task through the agent", () => {
  test("start a task, its child turn runs through the agent, its result waits for the turn in flight, and the caller's drain answers it", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // The task's turns (the child's, then the parent's reaction) talk to their own scripted provider.
      const background = yield* scripted([text("alpha is 42"), text("The task found that alpha is 42.")])
      const { agent, built, sessions, tasks, idle } = yield* tasksBeside((agent) => agentTaskExecutor(agent, { services: Context.make(LanguageModel.LanguageModel, background.model) }))

      // 1. ask: the model starts a task, then says so; the turn waits until the task's work has ended.
      const parent = yield* scripted([call("c1", "start_task", { instructions: "look up alpha", mode: "spawn" }), text("I started a background task.")])
      const services = Context.mergeAll(Context.make(LanguageModel.LanguageModel, parent.model), Context.make(Sessions, sessions), Context.make(Tasks, tasks))
      const asked = yield* agent.turn({ turn: { session, userMessage: new UserMessage({ text: "find alpha in the background" }), runId: RunId.make("run-1") }, services }, (turn: Turn) => Effect.gen(function* () {
        yield* turn.tools.select(turn.userMessage)
        const result = yield* turn.run({})
        // The child's turn runs, its result is delivered, and the drain that follows finds this turn open.
        yield* idle
        return { outcome: result.outcome, reply: Option.some(result.text) }
      }))
      const [task] = yield* tasks.list(session)
      const child = { id: task!.child, owner: session.owner }
      const childEvents = yield* sessions.read(child)
      const beforeDrain = yield* sessions.read(session)

      // 2. the caller drains what the turn's end left waiting: the parent answers the task's result.
      const drained = yield* sessions.drain(session, Context.get(built, TaskExecutor).react)
      return {
        asked, task: task!, childEvents, beforeDrain, drained,
        afterDrain: yield* sessions.read(session),
        status: yield* tasks.status(session, task!.taskId),
        backgroundPrompts: yield* Ref.get(background.prompts),
      }
    })))

    const { asked, task, childEvents, beforeDrain, drained, afterDrain, status, backgroundPrompts } = observed
    // 1. The turn answered, and its end counted the task's result waiting for the caller.
    expect([asked.outcome, Option.getOrNull(asked.reply), asked.pending]).toEqual(["completed", "I started a background task.", 1])
    // The parent recorded the task with the turn that started it, and the turn's meta unchanged.
    const [started] = ofKind(beforeDrain, "task.started")
    expect(started?.data).toMatchObject({ taskId: task.taskId, instructions: "look up alpha", mode: "spawn", meta: {}, startedBy: { runId: "run-1", turn: 1 } })
    // The child's one turn is a task's: begun with the task's ref, the instructions its message, answered by the agent.
    expect(ofKind(childEvents, "turn.started").map((event) => [event.data.origin, event.data.task, (event.data.userMessage as { readonly text: string }).text]))
      .toEqual([["task", { taskId: task.taskId, parent: session.id }, "look up alpha"]])
    expect(childEvents.map((event) => event.kind).slice(-3)).toEqual(["task.result", "turn.reply", "turn.ended"])
    expect(ofKind(childEvents, "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])
    expect(backgroundPrompts[0]).toContain("look up alpha")
    // Delivered to the parent's inbox while its turn was open, and not answered then.
    expect(ofKind(beforeDrain, "inbox.queued").map((event) => event.data.id)).toEqual([`task:${task.taskId}`])
    expect(ofKind(beforeDrain, "turn.started")).toHaveLength(1)

    // 2. The drain ran one inbox turn, which took the notice and answered it.
    expect(drained.turns).toBe(1)
    const reaction = ofKind(afterDrain, "turn.started")[1]
    expect([reaction?.data.origin, reaction?.data.claimed, reaction?.data.task ?? null]).toEqual(["inbox", [`task:${task.taskId}`], null])
    expect(backgroundPrompts[1]).toContain(`[Background task ${task.taskId} completed]`)
    expect(backgroundPrompts[1]).toContain("alpha is 42")
    expect(ofKind(afterDrain, "turn.reply").map((event) => (event.data.body as { readonly reply: string | null }).reply))
      .toEqual(["I started a background task.", "The task found that alpha is 42."])
    expect(ofKind(afterDrain, "turn.ended").map((event) => event.data.reason)).toEqual(["completed", "completed"])
    expect([status.status, Option.getOrNull(status.reply), status.delivered]).toEqual(["completed", "alpha is 42", true])
  })

  test("a host's child and react run in place of the default run: the child given its task, both on turns the tasks plugin began and ends", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const unused = yield* scripted([])
      const { sessions, tasks, idle } = yield* tasksBeside((agent) => agentTaskExecutor(agent, {
        services: Context.make(LanguageModel.LanguageModel, unused.model),
        child: (turn, task) => turn.reply(`counted ${task.instructions} on a ${turn.admitted.origin} turn`),
        react: (turn) => turn.reply(`heard ${turn.admitted.claimed.map((item) => item.id).join()}`),
      }))
      // A host starts the task outside any turn: the session is free, so the deliverer's own drain reacts.
      const task = yield* tasks.start(session, { instructions: "the rows", mode: "spawn" })
      yield* idle
      return { task: yield* tasks.status(session, task.taskId), parent: yield* sessions.read(session), prompts: yield* Ref.get(unused.prompts) }
    })))
    expect([observed.task.status, Option.getOrNull(observed.task.reply), observed.task.delivered]).toEqual(["completed", "counted the rows on a task turn", true])
    expect(ofKind(observed.parent, "turn.reply").map((event) => (event.data.body as { readonly reply: string | null }).reply)).toEqual([`heard task:${observed.task.taskId}`])
    expect(ofKind(observed.parent, "turn.ended").map((event) => event.data.reason)).toEqual(["completed"])
    expect(observed.prompts).toEqual([])
  })
})
