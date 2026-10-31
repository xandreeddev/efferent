/**
 * A real agent's durable inbox across SIGKILL, shared by the source Bun
 * journey and packed Node/Bun verification. No provider or credentials.
 * Each holder's stdin belongs to the controller, so orphan holders stop.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ConversationId, defineCapability, defineSkill, defineTool, DrainActivity,
  entriesOfEvents, Failure, InboxItemId, InboxRunner, journalSchemaOf,
  mediaFromBase64, processActivity, readStored, RunId, SessionLog, Sessions,
  STORED_FORMAT, StoredData, toolCallStatesOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { textReply } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { InboxDrainLive, SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, agentInboxRunner } from "@xandreed/sdk"

const [mode = "journey", directory = "", scenario = "tool"] = process.argv.slice(2)
const address = { id: ConversationId.make("00000000-0000-4000-8000-000000005539"), owner: "restart-journey" }
const steerText = "Durable steer: inspect this pixel before finishing."
const nextText = "Queued next request: report the second answer."
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const ttlMs = 120_000
const usage = { inputTokens: { total: 2 }, outputTokens: { total: 1 } }
const Block = Tool.make("restart_block", {
  description: "Wait for a restart checkpoint.", parameters: Schema.Struct({}),
  success: Schema.String, failure: Failure, failureMode: "return",
})
const say = (line) => Effect.sync(() => { process.stdout.write(`${line}\n`) })
const check = (condition, message) => Effect.sync(() => assert.ok(condition, message))
const userTexts = (messages) => messages.filter((message) => message.role === "user").map((message) =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"))
const countText = (messages, text) => userTexts(messages).filter((value) => value.includes(text)).length
const sessionsLayer = (root) => SessionsLive({
  ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" },
}).pipe(Layer.provideMerge(Layer.merge(SessionLogFilesLive(root), TurnAdmissionOpen)))
const composeAgent = (handler) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities: [defineCapability({
    id: "restart-checkpoint", version: "1",
    tools: [defineTool({ tool: Block, handler, annotations: { readOnly: true } })],
    skills: [defineSkill({ id: "restart-checkpoint", summary: "Wait at a restart checkpoint.", tools: [Block.name], always: true })],
  })],
  turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 4 },
})
const oneRun = (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})),
  Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) })))
const until = (condition) => condition.pipe(Effect.flatMap((done) => done ? Effect.void
  : Effect.sleep(10).pipe(Effect.andThen(until(condition)))))

/** Read every stored kind through its shipped decoder, then rebuild memory and tool-call evidence. */
const audit = (sessions, log) => Effect.gen(function* () {
  const events = yield* sessions.read(address)
  yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
    onNone: () => Effect.die(`the restart journal contains an unrecognized kind: ${event.kind}`),
    onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
  }), { concurrency: 1, discard: true })
  yield* Effect.forEach(Object.keys(StoredData), (kind) => readStored(kind, events), { concurrency: 1, discard: true })
  const entries = yield* entriesOfEvents(events)
  const calls = yield* toolCallStatesOf(events)
  const starts = yield* readStored("turn.started", events)
  const endings = yield* readStored("turn.ended", events)
  const receipts = yield* readStored("inbox.taken", events)
  const queued = yield* readStored("inbox.queued", events)
  const head = yield* log.head(address.id)
  yield* check(head.state.sessions?.format === STORED_FORMAT, "the session head did not use the current stored format")
  yield* check(calls.length === 1 && calls[0]._tag === "Started" && calls[0].toolCallId === "blocked-call", "the original blocked tool is not durably Started")
  return { events, entries, starts, endings, receipts, queued, sequence: head.seq, format: head.state.sessions.format }
})

const holder = (root) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(sessionsLayer(root))
  const sessions = Context.get(context, Sessions)
  const log = Context.get(context, SessionLog)
  yield* sessions.create(address)
  const agent = yield* composeAgent(() => audit(sessions, log).pipe(
    Effect.andThen(say("tool-ready")), Effect.andThen(Effect.never),
  ))
  const model = yield* LanguageModel.make({
    generateText: () => Effect.succeed([
      { type: "tool-call", id: "blocked-call", name: Block.name, params: {}, providerExecuted: false },
      { type: "finish", reason: "tool-calls", usage },
    ]), streamText: () => Stream.die("not scripted"),
  })
  yield* agent.turn({ turn: { session: address, runId: RunId.make("restart-original"), userMessage: new UserMessage({ text: "Complete the original work." }) },
    services: Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(Sessions, sessions)),
  }, oneRun)
  yield* Effect.die("the holder escaped its blocking tool")
}))

const enqueue = (root) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(sessionsLayer(root))
  const sessions = Context.get(context, Sessions)
  const image = yield* mediaFromBase64(pixelPng, { name: "steer.png", alt: "one durable pixel" })
  yield* sessions.enqueue(address, { id: InboxItemId.make("restart-steer"), delivery: "steer", source: { channel: "restart-controller" },
    userMessage: new UserMessage({ text: steerText, attachments: [image] }) })
  yield* sessions.enqueue(address, { id: InboxItemId.make("restart-next"), delivery: "next", source: { channel: "restart-controller" }, userMessage: new UserMessage({ text: nextText }) })
  const before = yield* audit(sessions, Context.get(context, SessionLog))
  yield* check(before.starts.length === 1 && before.endings.length === 0, "enqueuing changed the held original turn")
  yield* say("enqueued")
}))

const recover = (root, stopAfterTake) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(sessionsLayer(root))
  const sessions = Context.get(context, Sessions)
  const log = Context.get(context, SessionLog)
  const prompts = yield* Ref.make([])
  const agent = yield* composeAgent(() => Effect.die("recovery reexecuted the original blocked tool"))
  const model = yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const messages = options.prompt.content
      yield* Ref.update(prompts, (all) => [...all, messages])
      if (stopAfterTake) {
        const taken = yield* audit(sessions, log)
        yield* check(taken.receipts.length === 1 && taken.receipts[0].data.id === "restart-steer", "the recovery request preceded the durable steering receipt")
        yield* check(countText(messages, steerText) === 1, "the atomically taken steer is absent or duplicated in the first resumed prompt")
        yield* say("take-ready")
        return yield* Effect.never
      }
      return [...textReply(countText(messages, nextText) > 0 ? "Completed the next request." : "Recovered the original work.")]
    }), streamText: () => Stream.die("not scripted"),
  })
  const services = Context.make(LanguageModel.LanguageModel, model)
  const runner = agentInboxRunner(agent, { services }).pipe(Layer.provide(Layer.succeed(Sessions, sessions)))
  const built = yield* Layer.build(InboxDrainLive({
    owners: [address.owner], concurrency: 1, sweepIntervalMs: 20, pageSize: 1,
    backoff: { initialMs: 10, maxMs: 50 }, resume: { _tag: "Before" }, takeOver: true,
  }).pipe(Layer.provideMerge(runner), Layer.provideMerge(Layer.succeedContext(context))))
  if (stopAfterTake) return yield* Effect.never
  yield* until(sessions.read(address, { kinds: ["turn.ended"] }).pipe(Effect.flatMap((events) => readStored("turn.ended", events)),
    Effect.map((ends) => ends.filter((end) => end.data.reason === "completed").length === 2)))
  yield* Context.get(built, DrainActivity).idle
  const record = yield* audit(sessions, log)
  const seen = yield* Ref.get(prompts)
  yield* check(seen.length === 2, "recovery did not make exactly one resume request followed by one next-input request")
  yield* check(JSON.stringify(seen[0]).includes("ToolInterrupted"), "the resumed model did not see ToolInterrupted")
  yield* check(countText(seen[0], steerText) === 1 && countText(seen[0], nextText) === 0, "the resumed model did not receive exactly its durable steer")
  yield* check(countText(seen[1], nextText) === 1, "the queued next input was not its own later user message")
  yield* check(record.receipts.length === 1 && record.receipts[0].data.id === "restart-steer", "steering was not consumed exactly once")
  const steers = record.entries.filter((entry) => entry.body._tag === "Message" && entry.body.inbox === "restart-steer")
  yield* check(steers.length === 1 && steers[0].body.message.role === "user", "the durable steer message was lost or duplicated")
  yield* check(JSON.stringify(steers[0].body.message).includes(pixelPng), "the durable steering attachment was lost")
  const nextStarts = record.starts.filter((start) => start.data.input === "restart-next")
  const resumes = record.starts.filter((start) => start.data.resumes !== undefined)
  yield* check(nextStarts.length === 1 && resumes.length >= 1 && resumes.every((start) => start.data.resumes === 1), "recovery used a different root or reran queued input")
  const completed = record.endings.filter((end) => end.data.reason === "completed")
  yield* check(completed.length === 2 && Option.contains(completed[0].event.turn, Option.getOrElse(resumes.at(-1).event.turn, () => -1))
    && Option.contains(completed[1].event.turn, Option.getOrElse(nextStarts[0].event.turn, () => -1)), "the original work did not complete before the next input")
  yield* check(record.endings[0].data.failure._tag === "Some" && record.endings[0].data.failure.value.code === "turn.takeover", "startup did not take over the original live lease")
  yield* check((yield* sessions.get(address)).pending === 0, "recovery left queued input pending")
  const activity = yield* processActivity.pipe(Effect.provide(built))
  yield* check(!activity.busy && !activity.inFlight && activity.queuedInput === 0, "the drained runtime still reports work")
  yield* say(`result ${JSON.stringify({ starts: record.starts.length, completed: 2, steers: steers.length, next: nextStarts.length, tool: "Started", interrupted: true, format: record.format, sequence: record.sequence })}`)
}))

/** Three full owner scans prove a fresh drainer reopens without an extra delivery. */
const reopen = (root) => Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(sessionsLayer(root))
  const sessions = Context.get(context, Sessions)
  const log = Context.get(context, SessionLog)
  const before = yield* audit(sessions, log)
  const scans = yield* Ref.make(0)
  const observed = Sessions.of({ ...sessions, list: (query) => sessions.list(query).pipe(Effect.tap(() =>
    query.parent === undefined && query.before === undefined ? Ref.update(scans, (count) => count + 1) : Effect.void)) })
  const calls = yield* Ref.make(0)
  const runner = InboxRunner.of({ run: () => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.die("a fresh drainer redelivered completed input"))) })
  yield* Layer.build(InboxDrainLive({ owners: [address.owner], concurrency: 1, sweepIntervalMs: 20, takeOver: true }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(Sessions, observed), Layer.succeed(InboxRunner, runner))),
  ))
  yield* until(Ref.get(scans).pipe(Effect.map((count) => count >= 3)))
  yield* check((yield* Ref.get(calls)) === 0, "a fresh drainer reran completed work")
  const after = yield* audit(sessions, log)
  yield* check(after.sequence === before.sequence, "reopening added journal records for completed input")
  yield* check((yield* sessions.get(address)).pending === 0, "reopening restored acknowledged input")
  yield* say("reopened")
}))

const self = fileURLToPath(import.meta.url)
const journey = async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-inbox-restart-"))
  const children = new Set()
  const start = (action, storage, name) => {
    const child = spawn(process.execPath, [self, action, storage, name], { stdio: ["pipe", "pipe", "pipe"] })
    children.add(child)
    const output = { text: "", errors: "", waiters: [] }
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal }) })
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      output.text += chunk
      output.waiters.forEach((notify) => notify())
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { output.errors += chunk })
    const lines = () => output.text.split("\n")
    const waitFor = async (line) => {
      const ready = new Promise((resolve) => {
        const inspect = () => { if (lines().includes(line)) resolve() }
        output.waiters.push(inspect)
        inspect()
      })
      await Promise.race([ready, completion.then((ended) => { throw new Error(`${action} exited before ${line}: ${JSON.stringify(ended)}\n${output.text}\n${output.errors}`) })])
    }
    const done = async () => {
      const ended = await completion
      assert.equal(ended.code, 0, `${action} failed: ${output.text}\n${output.errors}`)
      return lines()
    }
    const kill = async () => {
      child.kill("SIGKILL")
      assert.equal((await completion).signal, "SIGKILL", `${action} was not killed at its checkpoint`)
    }
    return { waitFor, done, kill }
  }
  try {
    const results = []
    for (const name of ["tool", "taken"]) {
      const storage = join(root, name)
      const began = performance.now()
      const held = start("holder", storage, name)
      await held.waitFor("tool-ready")
      await start("enqueue", storage, name).done()
      await held.kill()
      if (name === "taken") {
        const taking = start("take", storage, name)
        await taking.waitFor("take-ready")
        await taking.kill()
      }
      const lines = await start("recover", storage, name).done()
      const result = JSON.parse(lines.find((line) => line.startsWith("result "))?.slice(7) ?? "null")
      assert.equal(result?.starts, name === "tool" ? 3 : 4, "an input was redelivered or a recovery attempt disappeared")
      assert.ok(performance.now() - began < ttlMs / 2, "recovery waited for the original lease instead of taking over")
      await start("reopen", storage, name).done()
      results.push({ checkpoint: name, ...result })
    }
    console.log(`inbox-restart ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", scenarios: results })}`)
  } finally {
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    await rm(root, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error(`inbox restart fixture timed out in ${mode} (${scenario})`); process.exit(2) }, 45_000)
watchdog.unref()
if (mode === "journey") await journey()
else {
  process.stdin.resume()
  process.stdin.once("end", () => process.exit(0))
  const work = mode === "holder" ? holder(directory) : mode === "enqueue" ? enqueue(directory)
    : mode === "take" ? recover(directory, true) : mode === "recover" ? recover(directory, false) : mode === "reopen" ? reopen(directory) : Effect.die(`unknown fixture action ${mode}`)
  await Effect.runPromise(work.pipe(Effect.timeout("35 seconds")))
  process.stdin.pause()
}
clearTimeout(watchdog)
