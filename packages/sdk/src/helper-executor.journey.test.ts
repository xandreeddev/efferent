import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId, ConversationMemory, definePlugin, entriesOfEvents, InboxItemId, InboxQueuedData, InboxRunner, mediaFromBase64,
  openLogSession, RunId, SessionLogMemoryLive, Sessions, TaskActivity, Tasks, ToolInterceptor,
  TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { MemoryPolicy, SessionLogEvent, Turn, TurnError, TurnOutcome, TurnServices } from "@xandreed/core"
import type { Scope } from "effect"
import { textReply } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TaskAnswered, TaskQuestioned, TasksLive, tasksCapability, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import { agentInboxRunner } from "./inbox-runner.adapter.js"
import { agentTaskExecutor } from "./task-executor.adapter.js"
import { taskInboxRunner } from "./task-inbox-runner.adapter.js"

const finish = { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } }
const ask = (id: string, text: string): ReadonlyArray<Response.PartEncoded> => [{ type: "tool-call", id, name: "ask_parent", params: { text } }, finish]
const ofKind = (events: ReadonlyArray<SessionLogEvent>, kind: string) => events.filter((event) => event.kind === kind)
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const scripted = (reply: (index: number) => Effect.Effect<ReadonlyArray<Response.PartEncoded>>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<ReadonlyArray<Prompt.Message>>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): readonly [number, ReadonlyArray<ReadonlyArray<Prompt.Message>>] => [all.length, [...all, options.prompt.content]]).pipe(
      Effect.flatMap(reply), Effect.map((parts) => [...parts]),
    ),
    streamText: () => Stream.die("not scripted"),
  })
  return { model, prompts: Ref.get(prompts) }
})

const environment = (id: string, model: LanguageModel.LanguageModel, options: {
  readonly interceptor?: Context.Service.Shape<typeof ToolInterceptor>
  readonly maxPending?: number
  readonly child?: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>
  readonly maintenance?: Ref.Ref<ReadonlyArray<string>>
} = {}) => Effect.gen(function* () {
  const maintenance = options.maintenance
  const policy: MemoryPolicy = {
    strategy: { id: "helper-executor-journey", version: "1" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
    digestOnWrite: Option.none(),
    maintain: ({ signal }) => (maintenance === undefined ? Effect.void : Ref.update(maintenance, (phases) => [...phases, signal.phase])).pipe(Effect.as({ actions: [], digest: [] })),
  }
  const observedMemory = definePlugin({
    id: "fixture/helper-executor-memory", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ConversationMemory],
    layer: () => Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: (input) => openLogSession(input.log, policy, { runId: input.runId }) }),
  })
  const agent = yield* Agent.define({
    plugins: [maintenance === undefined ? memoryWindowPlugin : observedMemory, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [tasksCapability], turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 4 },
  })
  const sessionsLayer = SessionsLive({ ...sessionsDefaults,
    ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" },
    inbox: { ...sessionsDefaults.inbox, maxPending: options.maxPending ?? 20 },
  }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
  const services = options.interceptor === undefined ? Context.make(LanguageModel.LanguageModel, model)
    : Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(ToolInterceptor, options.interceptor))
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
    sessionsLayer, InProcessTaskRunnerLive(), agentTaskExecutor(agent, { services,
      ...(options.child === undefined ? {} : { child: options.child }),
      react: (turn) => turn.reply("The task notice is available."),
    }),
  ))))
  const sessions = Context.get(built, Sessions)
  const tasks = Context.get(built, Tasks)
  const parent = { owner: "helper-executor-journey", id: ConversationId.make(id) }
  yield* sessions.create(parent)
  const base = Context.get(yield* Layer.build(agentInboxRunner(agent, { services }).pipe(Layer.provide(Layer.succeed(Sessions, sessions)))), InboxRunner)
  const runner = Context.get(yield* Layer.build(taskInboxRunner(base).pipe(Layer.provide(Layer.merge(
    Layer.succeed(Sessions, sessions), Layer.succeed(Tasks, tasks),
  )))), InboxRunner)
  const idle = Context.get(built, TaskActivity).idle
  const start = (suffix: string) => tasks.start(parent, { taskId: ConversationId.make(`00000000-0000-4000-8000-${suffix}`), instructions: "Check the helper input.", mode: "spawn" })
  const queued = (child: ConversationId, input: InboxItemId, key: string) => Effect.scoped(Effect.gen(function* () {
    const writer = yield* sessions.begin({ owner: parent.owner, id: child }, { _tag: "Queued", input, runId: RunId.make(key) })
    const result = yield* runner.run(writer)
    const ending = { reason: result.outcome, failure: Option.none() }
    yield* writer.end(ending)
    if (runner.afterEnd !== undefined) yield* runner.afterEnd(writer, ending)
    return { result, admitted: writer.admitted, writer }
  }))
  const answerInput = (child: ConversationId, text: string) => sessions.read({ owner: parent.owner, id: child }).pipe(
    Effect.flatMap((events) => Effect.forEach(ofKind(events, "task.answered"), (event) => Schema.decodeUnknownEffect(TaskAnswered)(event.data), { concurrency: 1 })),
    Effect.flatMap((answers) => {
      const found = answers.find((answer) => answer.text === text)
      return found === undefined ? Effect.die("the answer intent is missing") : Effect.succeed(found.input.id)
    }),
  )
  const question = (taskId: ConversationId) => tasks.status(parent, taskId).pipe(Effect.flatMap((task) =>
    task.question === undefined ? Effect.die("the helper question is missing") : Effect.succeed(task.question)))
  return { agent, sessions, tasks, parent, idle, start, queued, answerInput, question, runner }
})

describe("journey: helper questions and durable follow-up turns", () => {
  ;(["deny", "respond", "replace"] as const).forEach((decision, index) => {
    test(`an intercepted ask ${decision === "replace" ? "still yields after a real commit" : "does not create a question or pause the task"} (${decision})`, () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* scripted((call) => Effect.succeed(call === 0 ? ask(`intercept-${decision}`, "Which accepted checkpoint?") : textReply("No real question was accepted.")))
      const interceptor = ToolInterceptor.of({
        before: (input) => Effect.succeed(input.tool !== "ask_parent" || decision === "replace" ? { _tag: "Allow" }
          : decision === "deny" ? { _tag: "Deny", failure: { error: "QuestionDenied", message: "Use the existing checkpoint." } }
            : { _tag: "Respond", outcome: { _tag: "Success", encoded: { questionId: "synthetic-question" } } }),
        after: (input) => Effect.succeed(input.tool === "ask_parent" && decision === "replace"
          ? { _tag: "Replace", outcome: { _tag: "Success", encoded: { questionId: "synthetic-question" } } } : { _tag: "Keep" }),
      })
      const env = yield* environment(`00000000-0000-4000-8000-00000000301${index}`, model.model, { interceptor })
      const task = yield* env.start(`00000000311${index}`)
      yield* env.idle
      const status = yield* env.tasks.status(env.parent, task.taskId)
      const rows = yield* env.sessions.read({ owner: env.parent.owner, id: task.child })
      expect(ofKind(rows, "task.questioned")).toHaveLength(decision === "replace" ? 1 : 0)
      expect((yield* model.prompts).length).toBe(decision === "replace" ? 1 : 2)
      expect(status.status).toBe(decision === "replace" ? "waiting" : "completed")
      if (decision === "replace") expect(status.question?.questionId).not.toBe("synthetic-question")
      else expect(status.question).toBeUndefined()
    })).pipe(Effect.timeout("8 seconds"))))
  })

  test("a real ask yields before another provider, completion, or end maintenance; later answers use new queued turns", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const phases = yield* Ref.make<ReadonlyArray<string>>([])
    const completions = yield* Ref.make(0)
    const model = yield* scripted((index) => Effect.succeed(index === 0 ? ask("question-one", "Which branch should I inspect?")
      : index === 1 ? ask("question-two", "Which check should I run?") : textReply("Both answers were applied.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003001", model.model, { maintenance: phases,
      child: (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({
        completion: () => Ref.update(completions, (n) => n + 1).pipe(Effect.as({ complete: true, awaiting: [], facts: {} })),
      })), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))),
    })
    const task = yield* env.start("000000003101")
    yield* env.idle
    const first = yield* env.question(task.taskId)
    expect((yield* model.prompts).length).toBe(1)
    expect(yield* Ref.get(completions)).toBe(0)
    expect((yield* Ref.get(phases)).filter((phase) => phase === "turn-end")).toEqual([])
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("waiting")
    const child = { owner: env.parent.owner, id: task.child }
    expect(ofKind(yield* env.sessions.read(child), "task.result")).toHaveLength(0)
    expect(ofKind(yield* env.sessions.read(env.parent), "inbox.queued").some((row) => row.data.id === `task:${task.taskId}`)).toBe(false)
    expect(yield* env.tasks.answer(env.parent, task.taskId, { questionId: first.questionId, text: "Inspect the stable branch." })).toEqual({ accepted: true, enqueued: true })
    const one = yield* env.queued(task.child, yield* env.answerInput(task.child, "Inspect the stable branch."), "helper-answer-one")
    const second = yield* env.question(task.taskId)
    expect(second.questionId).not.toBe(first.questionId)
    expect(one.result.outcome).toBe("waiting")
    expect((yield* model.prompts).length).toBe(2)
    expect(yield* env.tasks.answer(env.parent, task.taskId, { questionId: first.questionId, text: "Inspect the stable branch." })).toEqual({ accepted: true, enqueued: false })
    expect((yield* env.question(task.taskId)).questionId).toBe(second.questionId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: second.questionId, text: "Run the SDK checks." })
    const two = yield* env.queued(task.child, yield* env.answerInput(task.child, "Run the SDK checks."), "helper-answer-two")
    yield* env.idle
    expect(two.result.outcome).toBe("completed")
    expect([one.admitted.origin, two.admitted.origin]).toEqual(["user", "user"])
    expect([one.admitted.task, two.admitted.task]).toEqual([undefined, undefined])
    const events = yield* env.sessions.read(child)
    expect(ofKind(events, "turn.ended").map((row) => row.data.reason)).toEqual(["waiting", "waiting", "completed"])
    expect(ofKind(events, "task.result")).toHaveLength(1)
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
    expect((yield* model.prompts).length).toBe(3)
    expect(JSON.stringify((yield* model.prompts)[1])).toContain("Inspect the stable branch.")
    expect(JSON.stringify((yield* model.prompts)[2])).toContain("Run the SDK checks.")
  })).pipe(Effect.timeout("8 seconds"))))

  test("an answer accepted before the asking tool returns stays in a separate queued turn", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const held = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted((index) => Effect.succeed(index === 0 ? ask("early-question", "Which target?") : textReply("The early answer was applied.")))
    const interceptor = ToolInterceptor.of({ before: () => Effect.succeed({ _tag: "Allow" }), after: (input) => input.tool === "ask_parent"
      ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ _tag: "Keep" as const })) : Effect.succeed({ _tag: "Keep" }) })
    const env = yield* environment("00000000-0000-4000-8000-000000003002", model.model, { interceptor })
    yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(release, undefined))
    const task = yield* env.start("000000003102")
    yield* Deferred.await(held)
    const question = yield* env.question(task.taskId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: question.questionId, text: "Use the early target." })
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    const child = { owner: env.parent.owner, id: task.child }
    expect((yield* model.prompts).length).toBe(1)
    expect(ofKind(yield* env.sessions.read(child), "turn.ended").map((row) => row.data.reason)).toEqual(["waiting"])
    expect((yield* env.sessions.get(child)).pending).toBe(1)
    yield* env.queued(task.child, yield* env.answerInput(task.child, "Use the early target."), "early-answer")
    yield* env.idle
    expect((yield* model.prompts).length).toBe(2)
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
  })).pipe(Effect.timeout("8 seconds"))))

  test("a full child inbox retains the accepted answer and retires old steers without provider work", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted((index) => index === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(ask("full-question", "Which final value?")))
      : Effect.succeed(textReply("The exact accepted answer was applied.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003003", model.model, { maxPending: 2 })
    yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(release, undefined))
    const task = yield* env.start("000000003103")
    yield* Deferred.await(entered)
    const steer = (id: string) => ({ id: InboxItemId.make(id), userMessage: new UserMessage({ text: id }), source: { channel: "helper-journey" } })
    yield* env.tasks.steer(env.parent, task.taskId, steer("old-steer-one"))
    yield* env.tasks.steer(env.parent, task.taskId, steer("old-steer-two"))
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    const question = yield* env.question(task.taskId)
    expect(yield* env.tasks.answer(env.parent, task.taskId, { questionId: question.questionId, text: "Use the retained exact answer." })).toEqual({ accepted: true, enqueued: false })
    yield* env.queued(task.child, InboxItemId.make("old-steer-one"), "retire-old-one")
    yield* env.queued(task.child, InboxItemId.make("old-steer-two"), "retire-old-two")
    expect((yield* model.prompts).length).toBe(1)
    yield* env.tasks.reconcile(env.parent)
    const input = yield* env.answerInput(task.child, "Use the retained exact answer.")
    yield* env.queued(task.child, input, "retained-answer")
    yield* env.idle
    const child = { owner: env.parent.owner, id: task.child }
    const events = yield* env.sessions.read(child)
    expect(ofKind(events, "task.answered")).toHaveLength(1)
    expect(ofKind(events, "inbox.queued").filter((row) => row.data.id === input)).toHaveLength(1)
    expect((yield* env.sessions.get(child)).pending).toBe(0)
    expect((yield* model.prompts).length).toBe(2)
    expect(JSON.stringify((yield* model.prompts)[1])).toContain("Use the retained exact answer.")
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
  })).pipe(Effect.timeout("8 seconds"))))

  test("cancellation of a waiting helper refuses its answer and never invokes the executor again", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const model = yield* scripted((index) => Effect.succeed(index === 0 ? ask("cancel-question", "May I continue?") : textReply("Unexpected continuation.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003004", model.model)
    const task = yield* env.start("000000003104")
    yield* env.idle
    const question = yield* env.question(task.taskId)
    expect(yield* env.tasks.cancel(env.parent, task.taskId)).toBe(true)
    const refused = yield* Effect.exit(env.tasks.answer(env.parent, task.taskId, { questionId: question.questionId, text: "Continue." }))
    expect(Exit.isFailure(refused)).toBe(true)
    yield* env.tasks.reconcile(env.parent)
    yield* env.idle
    expect((yield* model.prompts).length).toBe(1)
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("cancelled")
  })).pipe(Effect.timeout("8 seconds"))))

  test("a second question stays sticky across two-hop resumes and a fresh attempt of the same queued input", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const interrupted = yield* Ref.make(false)
    const interceptor = ToolInterceptor.of({ before: () => Effect.succeed({ _tag: "Allow" }), after: (input) => input.tool === "ask_parent"
      ? Ref.getAndSet(interrupted, true).pipe(Effect.flatMap((already) => already ? Effect.interrupt : Effect.succeed({ _tag: "Keep" as const })))
      : Effect.succeed({ _tag: "Keep" }) })
    const model = yield* scripted((index) => Effect.succeed(index === 0 ? ask("resume-question-one", "Which branch?")
      : index === 1 ? ask("resume-question-two", "Which check?") : textReply("Recovery applied the second answer.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003020", model.model, { interceptor })
    const task = yield* env.start("000000003120")
    yield* env.idle
    const first = yield* env.question(task.taskId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: first.questionId, text: "Use the stable branch." })
    const input = yield* env.answerInput(task.child, "Use the stable branch.")
    const child = { owner: env.parent.owner, id: task.child }
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* env.sessions.begin(child, { _tag: "Queued", input, runId: RunId.make("question-two-interrupted") })
      expect(Exit.isFailure(yield* Effect.exit(env.runner.run(writer)))).toBe(true)
      yield* writer.end({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "The asking turn stopped." }) })
    }))
    const second = yield* env.question(task.taskId)
    expect(second.questionId).not.toBe(first.questionId)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* env.sessions.begin(child, { _tag: "User", userMessage: new UserMessage({ text: "Continue." }), runId: RunId.make("resume-question-two-once"), key: "resume-question-two-once", command: {}, resumes: 2 })
      yield* writer.end({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "The first recovery stopped." }) })
    }))
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* env.sessions.begin(child, { _tag: "User", userMessage: new UserMessage({ text: "Continue again." }), runId: RunId.make("resume-question-two-twice"), key: "resume-question-two-twice", command: {}, resumes: 3 })
      expect((yield* env.runner.run(writer)).outcome).toBe("waiting")
      yield* writer.end({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "The second recovery stopped before its end." }) })
    }))
    const fresh = yield* env.queued(task.child, input, "fresh-question-two-attempt")
    expect(fresh.result.outcome).toBe("waiting")
    expect(fresh.admitted.resumes).toBeUndefined()
    expect((yield* model.prompts).length).toBe(2)
    expect((yield* env.question(task.taskId)).questionId).toBe(second.questionId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: second.questionId, text: "Run the recovery check." })
    yield* env.queued(task.child, yield* env.answerInput(task.child, "Run the recovery check."), "second-answer-after-recovery")
    yield* env.idle
    expect((yield* model.prompts).length).toBe(3)
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
  })).pipe(Effect.timeout("8 seconds"))))

  test("ordinary window rendering gives a running helper text and image steers through Tasks.steer", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted((index) => index === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(textReply("First pass.")))
      : Effect.succeed(textReply("Text and image received.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003005", model.model)
    yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(release, undefined))
    const task = yield* env.start("000000003105")
    yield* Deferred.await(entered)
    const image = yield* mediaFromBase64(pixelPng, { name: "helper-steer.png", alt: "one pixel" })
    yield* env.tasks.steer(env.parent, task.taskId, { id: InboxItemId.make("helper-text"), userMessage: new UserMessage({ text: "Use the updated target." }), source: { channel: "helper-journey" } })
    yield* env.tasks.steer(env.parent, task.taskId, { id: InboxItemId.make("helper-image"), userMessage: new UserMessage({ text: "Inspect this queued image.", attachments: [image] }), source: { channel: "helper-journey" } })
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    const requests = yield* model.prompts
    expect(requests).toHaveLength(2)
    const userParts = requests[1]!.filter((message) => message.role === "user").flatMap((message) => message.content)
    expect(userParts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Check the helper input.", "Use the updated target.", "Inspect this queued image."])
    expect(userParts.filter((part) => part.type === "file")).toHaveLength(1)
    const child = { owner: env.parent.owner, id: task.child }
    expect(ofKind(yield* env.sessions.read(child), "inbox.taken").map((row) => row.data.id)).toEqual(["helper-text", "helper-image"])
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
  })).pipe(Effect.timeout("8 seconds"))))

  test("a tighter follow-up budget can drop old steer text from the prompt while retaining its durable input", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted((index) => index === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(textReply("The first pass is ready.")))
      : Effect.succeed(index === 1 ? ask("window-question", "Which short answer should I use next?") : textReply("The short answer was used.")))
    const env = yield* environment("00000000-0000-4000-8000-000000003021", model.model, {
      child: (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({ budgetTokens: turn.admitted.turn === 1 ? 64_000 : 5_000 })),
        Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))),
    })
    yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(release, undefined))
    const task = yield* env.start("000000003121")
    yield* Deferred.await(entered)
    const oldText = `OLD_STEER_START ${"previous-checkpoint ".repeat(2_000)} OLD_STEER_END`
    yield* env.tasks.steer(env.parent, task.taskId, { id: InboxItemId.make("long-old-steer"), userMessage: new UserMessage({ text: oldText }), source: { channel: "helper-journey" } })
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    const question = yield* env.question(task.taskId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: question.questionId, text: "Use this short answer." })
    yield* env.queued(task.child, yield* env.answerInput(task.child, "Use this short answer."), "tight-window-answer")
    yield* env.idle
    const prompts = yield* model.prompts
    expect(prompts).toHaveLength(3)
    expect(JSON.stringify(prompts[1])).toContain(oldText)
    expect(JSON.stringify(prompts[2])).not.toContain(oldText)
    expect(JSON.stringify(prompts[2])).toContain("Use this short answer.")
    const rows = yield* env.sessions.read({ owner: env.parent.owner, id: task.child })
    const queued = yield* Schema.decodeUnknownEffect(InboxQueuedData)(ofKind(rows, "inbox.queued").find((row) => row.data.id === "long-old-steer")!.data)
    expect(queued.input?.userMessage.text).toBe(oldText)
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
  })).pipe(Effect.timeout("8 seconds"))))

  test("the parent's model can steer, answer and cancel helpers through the actual registered tools", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted((index) => index === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(textReply("The first pass is ready.")))
      : Effect.succeed(index === 1 ? ask("controlled-question", "Which checkpoint should I use?")
        : index === 2 ? textReply("The parent answer was applied.") : ask("cancelled-by-tool", "May this second helper continue?")))
    const env = yield* environment("00000000-0000-4000-8000-000000003022", model.model)
    yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(release, undefined))
    const control = (name: string, params: Record<string, string>, key: string) => Effect.gen(function* () {
      const parentModel = yield* scripted((index) => Effect.succeed(index === 0 ? [{ type: "tool-call", id: key, name, params }, finish] : textReply("The control was applied.")))
      const result = yield* env.agent.turn({
        turn: { session: env.parent, runId: RunId.make(key), userMessage: new UserMessage({ text: `Apply ${name}.` }) },
        services: Context.make(LanguageModel.LanguageModel, parentModel.model).pipe(Context.add(Sessions, env.sessions), Context.add(Tasks, env.tasks)),
      }, (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) }))))
      expect(result.outcome).toBe("completed")
      expect((yield* parentModel.prompts).length).toBe(2)
    })
    const task = yield* env.start("000000003122")
    yield* Deferred.await(entered)
    yield* control("steer_task", { taskId: task.taskId, text: "Use the parent's updated target." }, "parent-tool-steer")
    yield* Deferred.succeed(release, undefined)
    yield* env.idle
    expect((yield* model.prompts).length).toBe(2)
    expect(JSON.stringify((yield* model.prompts)[1])).toContain("Use the parent's updated target.")
    const question = yield* env.question(task.taskId)
    yield* control("answer_task", { taskId: task.taskId, questionId: question.questionId, text: "Use the parent-selected checkpoint." }, "parent-tool-answer")
    yield* env.queued(task.child, yield* env.answerInput(task.child, "Use the parent-selected checkpoint."), "parent-tool-child-answer")
    yield* env.idle
    expect((yield* env.tasks.status(env.parent, task.taskId)).status).toBe("completed")
    const cancelled = yield* env.start("000000003123")
    yield* env.idle
    yield* control("cancel_task", { taskId: cancelled.taskId }, "parent-tool-cancel")
    yield* env.tasks.reconcile(env.parent)
    yield* env.idle
    expect((yield* env.tasks.status(env.parent, cancelled.taskId)).status).toBe("cancelled")
    expect((yield* model.prompts).length).toBe(4)
    const entries = yield* entriesOfEvents(yield* env.sessions.read(env.parent))
    const results = entries.flatMap((entry) => entry.body._tag === "ToolResult" && ["steer_task", "answer_task", "cancel_task"].includes(entry.body.toolName)
      ? [{ name: entry.body.toolName, encoded: entry.body.encoded }] : [])
    expect(results).toEqual([
      { name: "steer_task", encoded: { enqueued: true, pending: 1 } },
      { name: "answer_task", encoded: { accepted: true, enqueued: true } },
      { name: "cancel_task", encoded: { cancelled: true } },
    ])
  })).pipe(Effect.timeout("8 seconds"))))

  test("retrying an older answered ask does not deliver its deferred notice ahead of the current question", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const model = yield* scripted((index) => Effect.succeed(ask(`notice-question-${index}`, `Question ${index + 1}?`)))
    const env = yield* environment("00000000-0000-4000-8000-000000003023", model.model, { maxPending: 1 })
    const task = yield* env.start("000000003124")
    yield* env.idle
    const first = yield* env.question(task.taskId)
    const blocker = InboxItemId.make("parent-queue-blocker")
    yield* env.sessions.enqueue(env.parent, { id: blocker, delivery: "next", userMessage: new UserMessage({ text: "Keep this parent input separate." }), source: { channel: "helper-journey" } })
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: first.questionId, text: "Answer one." })
    const askingSecond = yield* env.queued(task.child, yield* env.answerInput(task.child, "Answer one."), "notice-question-two")
    yield* env.idle
    const second = yield* env.question(task.taskId)
    yield* env.tasks.answer(env.parent, task.taskId, { questionId: second.questionId, text: "Answer two." })
    yield* env.queued(task.child, yield* env.answerInput(task.child, "Answer two."), "notice-question-three")
    yield* env.idle
    const current = yield* env.question(task.taskId)
    const childRows = yield* env.sessions.read({ owner: env.parent.owner, id: task.child })
    const questions = yield* Effect.forEach(ofKind(childRows, "task.questioned"), (row) => Schema.decodeUnknownEffect(TaskQuestioned)(row.data), { concurrency: 1 })
    const oldNotice = questions.find((row) => row.question.questionId === second.questionId)!.notice.id
    const currentNotice = questions.find((row) => row.question.questionId === current.questionId)!.notice.id
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* env.sessions.begin(env.parent, { _tag: "Queued", input: blocker, runId: RunId.make("clear-parent-blocker") })
      yield* writer.end({ reason: "completed", failure: Option.none() })
    }))
    expect(yield* env.tasks.ask(askingSecond.writer, second)).toEqual(second)
    yield* env.tasks.reconcile(env.parent)
    const notices = ofKind(yield* env.sessions.read(env.parent), "inbox.queued")
    expect(notices.filter((row) => row.data.id === oldNotice)).toHaveLength(0)
    expect(notices.filter((row) => row.data.id === currentNotice)).toHaveLength(1)
    expect((yield* env.question(task.taskId)).questionId).toBe(current.questionId)
  })).pipe(Effect.timeout("8 seconds"))))
})
