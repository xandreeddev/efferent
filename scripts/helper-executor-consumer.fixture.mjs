/** Real Agent/files helper-question evidence, shared by source Bun and packed Node/Bun. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { ConversationId, InboxQueuedData, InboxRunner, RunId, SessionLog, Sessions, TaskActivity, TaskExecutor, Tasks, TurnAdmissionOpen } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TaskAnswered, TaskQuestioned, TasksLive, tasksCapability, tasksDefaults } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, agentInboxRunner, agentTaskExecutor, taskInboxRunner } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const directory = process.argv[3]
const parent = { owner: "helper-executor-fixture", id: ConversationId.make("00000000-0000-4000-8000-000000003000") }
const taskId = ConversationId.make("00000000-0000-4000-8000-000000003010")
const child = { owner: parent.owner, id: taskId }
const query = { after: 0, limit: Option.none(), kinds: [] }
const answerText = "Use the durably accepted checkpoint."
const finish = (reason = "stop") => ({ type: "finish", reason, usage: { inputTokens: { total: 4 }, outputTokens: { total: 1 } } })
const say = (line) => Effect.sync(() => process.stdout.write(`${line}\n`))
const done = (value) => say(`result ${JSON.stringify(value)}`)

const logLayer = (root) => SessionLogFilesLive(join(root, "sessions"))
const openLog = (root) => Layer.build(logLayer(root)).pipe(Effect.map(Context.get(SessionLog)))
const audit = (raw) => Effect.gen(function* () {
  const events = yield* raw.read(taskId, query)
  const questions = yield* Effect.forEach(events.filter((row) => row.kind === "task.questioned"), (row) => Schema.decodeUnknownEffect(TaskQuestioned)(row.data), { concurrency: 1 })
  const answers = yield* Effect.forEach(events.filter((row) => row.kind === "task.answered"), (row) => Schema.decodeUnknownEffect(TaskAnswered)(row.data), { concurrency: 1 })
  const queues = events.filter((row) => row.kind === "inbox.queued")
  const ends = events.filter((row) => row.kind === "turn.ended")
  const starts = events.filter((row) => row.kind === "turn.started")
  return { events, questions, answers, queues, ends, starts, head: yield* raw.head(taskId) }
})

const phaseMatches = (phase, id, commit) => id === taskId && commit.events.some((row) =>
  phase === "question" ? row.kind === "task.questioned"
    : phase === "answer" ? row.kind === "task.answered"
      : phase === "enqueue" ? row.kind === "inbox.queued" && row.data.input?.delivery === "next"
        : phase === "bookkeeping-begin" ? row.kind === "turn.started" && row.data.key.startsWith('["task-waiting",')
        : phase === "waiting-end" ? row.kind === "turn.ended" && row.data.reason === "waiting"
          : phase === "completed-end" ? row.kind === "turn.ended" && row.data.reason === "completed" : false)

const build = (root, options = {}) => Effect.gen(function* () {
  const raw = yield* openLog(root)
  const independent = yield* openLog(root)
  const armed = { value: true }
  const counters = { executor: 0, provider: 0 }
  const log = options.hold === undefined ? raw : SessionLog.of({ ...raw, commit: (id, commit) => raw.commit(id, commit).pipe(
    Effect.tap((committed) => Effect.gen(function* () {
      if (!armed.value || !phaseMatches(options.hold, id, commit)) return
      armed.value = false
      // The second files adapter, not a callback-entered signal, proves the
      // durable journal facts before the controller is allowed to kill us.
      const state = yield* audit(independent)
      committed.events.forEach((event) => assert.deepEqual(state.events.find((row) => row.seq === event.seq), event, "independent reader did not see the exact held commit"))
      yield* say(`held-${options.hold}`)
      return yield* Effect.never
    })),
  ) })
  const sessionsLayer = SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  )
  const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [tasksCapability],
    turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3 } })
  const model = yield* LanguageModel.make({ generateText: () => Effect.sync(() => {
    counters.provider++
    assert.notEqual(options.forbid, true, "recovery invoked a provider before bookkeeping")
    return options.asking ? [{ type: "tool-call", id: "fixture-question", name: "ask_parent", params: { text: "Which checkpoint should I use?" } }, finish("tool-calls")]
      : [{ type: "text", text: "The checkpoint is complete." }, finish()]
  }), streamText: () => Stream.die("not scripted") })
  const services = Context.make(LanguageModel.LanguageModel, model)
  const executor = Context.get(yield* Layer.build(agentTaskExecutor(agent, { services, react: (turn) => turn.reply("The task notice is available.") })), TaskExecutor)
  const countedExecutor = Layer.succeed(TaskExecutor, TaskExecutor.of({
    turn: (...args) => Effect.sync(() => { counters.executor++ }).pipe(Effect.andThen(executor.turn(...args))), react: executor.react,
  }))
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(sessionsLayer, InProcessTaskRunnerLive(), countedExecutor))))
  const sessions = Context.get(built, Sessions)
  const tasks = Context.get(built, Tasks)
  const base = Context.get(yield* Layer.build(agentInboxRunner(agent, { services }).pipe(Layer.provide(Layer.succeed(Sessions, sessions)))), InboxRunner)
  const runner = Context.get(yield* Layer.build(taskInboxRunner(base).pipe(Layer.provide(Layer.merge(
    Layer.succeed(Sessions, sessions), Layer.succeed(Tasks, tasks),
  )))), InboxRunner)
  const idle = Context.get(built, TaskActivity).idle
  const runAnswer = () => Effect.scoped(Effect.gen(function* () {
    const state = yield* audit(raw)
    assert.equal(state.answers.length, 1)
    const input = state.answers[0].input
    const writer = yield* sessions.begin(child, { _tag: "Queued", input: input.id, runId: RunId.make("fixture-answer") })
    assert.equal(writer.admitted.origin, "user")
    assert.equal(writer.admitted.task, undefined)
    const outcome = yield* runner.run(writer)
    const ending = { reason: outcome.outcome, failure: Option.none() }
    yield* writer.end(ending)
    if (runner.afterEnd) yield* runner.afterEnd(writer, ending)
    return outcome
  }))
  return { raw, sessions, tasks, idle, counters, runAnswer }
})

const seed = (root, hold) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { asking: true, ...(hold === undefined ? {} : { hold }) })
  yield* env.sessions.create(parent)
  yield* env.tasks.start(parent, { taskId, instructions: "Find the checkpoint.", mode: "spawn" })
  yield* env.idle
  const state = yield* audit(env.raw)
  assert.equal(state.questions.length, 1)
  assert.equal(state.ends.at(-1).data.reason, "waiting")
  assert.deepEqual(env.counters, { executor: 1, provider: 1 })
  return { seeded: true, questionId: state.questions[0].question.questionId }
}))

const inspect = (root, phase) => Effect.scoped(Effect.gen(function* () {
  const raw = yield* openLog(root)
  const state = yield* audit(raw)
  assert.equal(state.questions.length, 1)
  if (phase === "answer" || phase === "enqueue" || phase === "completed-end") assert.equal(state.answers.length, 1)
  if (phase === "enqueue" || phase === "completed-end") assert.equal(state.queues.filter((row) => row.data.id === state.answers[0].input.id).length, 1)
  if (phase === "waiting-end") assert.ok(state.ends.some((row) => row.data.reason === "waiting"))
  if (phase === "bookkeeping-begin") assert.ok(state.starts.length >= 2)
  if (phase === "completed-end") {
    assert.equal(state.ends.at(-1).data.reason, "completed")
    assert.equal(state.events.filter((row) => row.kind === "task.result").length, 1)
  }
  return { durableWitness: true, phase, seq: state.head.seq, revision: state.head.revision, questions: state.questions.length, answers: state.answers.length,
    starts: state.starts.length, ends: state.ends.map((row) => row.data.reason) }
}))

const preserve = (root) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { forbid: true })
  const before = yield* audit(env.raw)
  yield* env.tasks.reconcile(parent)
  yield* env.idle
  const after = yield* audit(env.raw)
  assert.equal(after.starts.length, before.starts.length, "default reconcile took over a live holder")
  assert.equal(after.ends.length, before.ends.length, "default reconcile closed a live holder")
  assert.deepEqual(env.counters, { executor: 0, provider: 0 })
  return { liveHolderPreserved: true, executorZero: true }
}))

const bookkeeping = (root, hold) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { forbid: true, ...(hold === undefined ? {} : { hold }) })
  yield* env.tasks.reconcile(parent, { takeOver: true })
  yield* env.idle
  const state = yield* audit(env.raw)
  assert.deepEqual(env.counters, { executor: 0, provider: 0 })
  assert.equal((yield* env.tasks.status(parent, taskId)).status, "waiting")
  assert.equal(state.events.filter((row) => row.kind === "task.result").length, 0)
  assert.ok(state.ends.some((row) => row.data.reason === "waiting"))
  const keys = state.starts.map((row) => row.data.key)
  assert.equal(new Set(keys).size, keys.length, "bookkeeping reused a begun turn key")
  const recoveryStarts = state.starts.filter((row) => row.data.key.startsWith('["task-waiting",'))
  assert.equal(recoveryStarts.length, 2, "the second abandoned writer was not repaired")
  recoveryStarts.forEach((row, index) => {
    const previous = state.starts[state.starts.indexOf(row) - 1]
    assert.deepEqual(JSON.parse(row.data.key), ["task-waiting", state.questions[0].question.questionId, previous.turn.value])
    assert.equal(JSON.parse(row.data.key)[2], index + 1, "bookkeeping key omitted the abandoned turn")
  })
  return { bookkeepingWithoutExecutor: true, repeatedKillRepair: true, uniqueRecoveryKeys: true, abandonedTurnKeysVerified: true, keys, starts: state.starts.length }
}))

const answer = (root, hold) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { forbid: true, ...(hold === undefined ? {} : { hold }) })
  const state = yield* audit(env.raw)
  const questionId = state.questions[0].question.questionId
  const accepted = yield* env.tasks.answer(parent, taskId, { questionId, text: answerText })
  assert.equal(accepted.accepted, true)
  return { answerAccepted: true, enqueued: accepted.enqueued }
}))

const recoverAnswer = (root) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root)
  const before = yield* audit(env.raw)
  assert.equal(before.answers.length, 1)
  const exact = before.answers[0].input
  yield* env.tasks.reconcile(parent)
  yield* env.idle
  const queued = yield* audit(env.raw)
  assert.equal(queued.answers.length, 1)
  assert.equal(queued.queues.filter((row) => row.data.id === exact.id).length, 1)
  const queuedData = yield* Schema.decodeUnknownEffect(InboxQueuedData)(queued.queues.find((row) => row.data.id === exact.id).data)
  assert.deepEqual({ id: queuedData.id, source: queuedData.source, ...queuedData.input }, exact, "reconcile rebuilt the accepted answer payload")
  assert.deepEqual(env.counters, { executor: 0, provider: 0 }, "reconcile unexpectedly drained child input")
  const outcome = yield* env.runAnswer()
  assert.equal(outcome.outcome, "completed")
  yield* env.idle
  yield* env.tasks.reconcile(parent)
  const after = yield* audit(env.raw)
  assert.equal(after.answers.length, 1)
  assert.equal(after.queues.filter((row) => row.data.id === exact.id).length, 1)
  assert.equal(after.events.filter((row) => row.kind === "task.result").length, 1)
  assert.equal((yield* env.sessions.get(child)).pending, 0)
  assert.deepEqual(env.counters, { executor: 1, provider: 1 })
  return { exactOutboxRepaired: true, answerOnce: true, borrowedTaskRoute: true, providerCalls: env.counters.provider }
}))

const complete = (root) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { hold: "completed-end" })
  yield* env.runAnswer()
  return { completed: true }
}))

const recoverEnd = (root) => Effect.scoped(Effect.gen(function* () {
  const env = yield* build(root, { forbid: true })
  const before = yield* audit(env.raw)
  assert.equal(before.ends.at(-1).data.reason, "completed")
  yield* env.tasks.reconcile(parent)
  yield* env.idle
  yield* env.tasks.reconcile(parent)
  const after = yield* audit(env.raw)
  const parentEvents = yield* env.sessions.read(parent)
  assert.equal(after.events.filter((row) => row.kind === "task.result").length, 1)
  assert.equal(after.starts.length, before.starts.length)
  assert.deepEqual(env.counters, { executor: 0, provider: 0 })
  assert.equal(parentEvents.filter((row) => row.kind === "inbox.queued" && row.data.id === `task:${taskId}`).length, 1)
  return { lostEndAckRecovered: true, terminalResultOnce: true, executorZero: true }
}))

const startChild = (action, root, children) => {
  const childProcess = spawn(process.execPath, [self, action, root], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(childProcess)
  const output = { text: "", errors: "", waiters: [] }
  const completion = new Promise((resolve, reject) => {
    childProcess.once("error", reject)
    childProcess.once("close", (code, signal) => { children.delete(childProcess); resolve({ code, signal }) })
  })
  const append = (key, chunk) => {
    output[key] += chunk
    if (Buffer.byteLength(output[key]) > 1_048_576) { output[key] = output[key].slice(0, 65_536); childProcess.kill("SIGKILL") }
    output.waiters.forEach((inspect) => inspect())
  }
  childProcess.stdout.setEncoding("utf8"); childProcess.stderr.setEncoding("utf8")
  childProcess.stdout.on("data", (chunk) => append("text", chunk)); childProcess.stderr.on("data", (chunk) => append("errors", chunk))
  const lines = () => output.text.split("\n")
  return { output,
    waitFor: (line) => Promise.race([new Promise((resolve) => { const inspect = () => { if (lines().includes(line)) resolve() }; output.waiters.push(inspect); inspect() }), completion.then((ended) => { throw new Error(`${action} ended before ${line}: ${JSON.stringify(ended)}\n${output.text}\n${output.errors}`) })]),
    done: async () => { const ended = await completion; assert.equal(ended.code, 0, `${action} failed: ${output.text}\n${output.errors}`); assert.equal(output.errors, "", `${action} wrote unexpected diagnostics`); const result = lines().find((line) => line.startsWith("result ")); assert.ok(result, `${action} produced no evidence`); return JSON.parse(result.slice(7)) },
    kill: async () => { assert.equal(childProcess.kill("SIGKILL"), true); assert.equal((await completion).signal, "SIGKILL") },
  }
}

const journey = async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-helper-executor-"))
  const children = new Set()
  const deadline = { timer: undefined }
  const killAll = () => children.forEach((childProcess) => childProcess.kill("SIGKILL"))
  process.once("exit", killAll)
  try {
    await Promise.race([(async () => {
      const questionRoot = join(root, "question")
      const asking = startChild("question-holder", questionRoot, children)
      await asking.waitFor("held-question")
      const questionWitness = await startChild("inspect-question", questionRoot, children).done()
      const live = await startChild("preserve", questionRoot, children).done()
      await asking.kill()
      const firstRepair = startChild("bookkeeping-begin-holder", questionRoot, children)
      await firstRepair.waitFor("held-bookkeeping-begin")
      const beginWitness = await startChild("inspect-bookkeeping-begin", questionRoot, children).done()
      await firstRepair.kill()
      const repairing = startChild("bookkeeping-holder", questionRoot, children)
      await repairing.waitFor("held-waiting-end")
      const bookkeepingWitness = await startChild("inspect-waiting-end", questionRoot, children).done()
      await repairing.kill()
      const repaired = await startChild("bookkeeping", questionRoot, children).done()
      const reports = { questionWitness, live, beginWitness, bookkeepingWitness, repaired }
      for (const phase of ["answer", "enqueue"]) {
        const phaseRoot = join(root, phase)
        await startChild("seed", phaseRoot, children).done()
        const holding = startChild(`${phase}-holder`, phaseRoot, children)
        await holding.waitFor(`held-${phase}`)
        reports[`${phase}Witness`] = await startChild(`inspect-${phase}`, phaseRoot, children).done()
        await holding.kill()
        reports[`${phase}Recovered`] = await startChild("recover-answer", phaseRoot, children).done()
      }
      const endRoot = join(root, "end")
      await startChild("seed", endRoot, children).done()
      await startChild("answer", endRoot, children).done()
      const ending = startChild("end-holder", endRoot, children)
      await ending.waitFor("held-completed-end")
      reports.endWitness = await startChild("inspect-completed-end", endRoot, children).done()
      await ending.kill()
      reports.endRecovered = await startChild("recover-end", endRoot, children).done()
      const flags = Object.fromEntries(Object.values(reports).flatMap(Object.entries).filter(([, value]) => typeof value === "boolean"))
      console.log(`helper-executor ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", ...flags, sigkillRecoveryVerified: true, reports })}`)
    })(), new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("helper-executor controller deadline elapsed")), 75_000) })])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((childProcess) => new Promise((resolve) => { childProcess.once("close", resolve); childProcess.kill("SIGKILL") })))
    process.off("exit", killAll)
    await rm(root, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error(`helper-executor fixture timed out in ${mode}`); process.exit(2) }, 90_000)
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "seed" ? seed(directory) : mode === "question-holder" ? seed(directory, "question")
      : mode.startsWith("inspect-") ? inspect(directory, mode.slice(8)) : mode === "preserve" ? preserve(directory)
        : mode === "bookkeeping-begin-holder" ? bookkeeping(directory, "bookkeeping-begin") : mode === "bookkeeping-holder" ? bookkeeping(directory, "waiting-end") : mode === "bookkeeping" ? bookkeeping(directory)
          : mode === "answer-holder" ? answer(directory, "answer") : mode === "enqueue-holder" ? answer(directory, "enqueue")
            : mode === "answer" ? answer(directory) : mode === "recover-answer" ? recoverAnswer(directory)
              : mode === "end-holder" ? complete(directory) : mode === "recover-end" ? recoverEnd(directory) : Effect.die(`unknown helper-executor fixture mode ${mode}`)
    await Effect.runPromise(work.pipe(Effect.timeout("30 seconds"), Effect.flatMap(done)))
  }
} finally { clearTimeout(watchdog) }
