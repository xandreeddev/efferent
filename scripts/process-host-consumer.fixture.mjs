/** The same real process protocol journey runs against source Bun and packed Node/Bun. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, MutableRef, Option, Schema, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ConversationId, defineCapability, defineSkill, defineTool, Failure,
  processActivity, RunId, SessionLog, Sessions, shutdownGracefully,
  toolCallStatesOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { InboxDrainLive, SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, agentInboxRunner } from "@xandreed/sdk"
import { ProcessCommand, ProcessEvent, ProcessPeer, processPeerConformance, runProcessHost, StdioPeerLive } from "@xandreed/process-host"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const target = { owner: "process-host-fixture", id: ConversationId.make("00000000-0000-4000-8000-000000003201") }
const query = { after: 0, limit: Option.none(), kinds: [] }
const finish = (reason = "stop") => ({ type: "finish", reason, usage: { inputTokens: { total: 4 }, outputTokens: { total: 1 } } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const peerKit = () => Effect.runPromise(Effect.gen(function* () {
  const checks = processPeerConformance({ open: (options = {}) => Effect.gen(function* () {
    const writes = MutableRef.make([])
    const held = MutableRef.make(options.holdWrites ?? false)
    const callbacks = MutableRef.make([])
    const input = new Readable({ read() {} })
    const output = new Writable({ highWaterMark: 1, write(data, _encoding, callback) {
      writes.current = [...writes.current, new Uint8Array(data)]
      if (held.current) callbacks.current = [...callbacks.current, () => callback()]
      else callback()
    } })
    yield* Effect.addFinalizer(() => Effect.sync(() => { input.destroy(); output.destroy() }))
    const { holdWrites: _, ...bounds } = options
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ ...bounds, input, output })), ProcessPeer)
    return {
      peer,
      feed: (bytes) => Effect.sync(() => { input.push(bytes) }),
      finishInput: Effect.sync(() => { input.push(null) }),
      writes: Effect.sync(() => writes.current),
      releaseWrites: Effect.sync(() => { held.current = false; const waiting = callbacks.current; callbacks.current = []; waiting.forEach((callback) => callback()) }),
      failOutput: Effect.sync(() => { output.destroy(new Error("native output failure")) }),
    }
  }) })
  yield* Effect.forEach(checks, (check) => check.run, { concurrency: 1, discard: true })
  return { peerKitVerified: true, peerChecks: checks.length }
}))

const childMain = async (directory, kind, hardDeadlineMs) => runProcessHost({
  owners: [target.owner], maxBegins: 2, maxShortCommands: 2, controlCapacity: 2,
  handshakeTimeoutMs: 2000, shutdown: { deadlineMs: 180, reserveMs: 80 }, hardDeadlineMs,
  setup: (observe) => Effect.gen(function* () {
    yield* Effect.logInfo("process fixture setup")
    if (kind === "stuck-setup") {
      yield* Effect.sync(() => process.stderr.write("setup-entered\n"))
      yield* Effect.uninterruptible(Effect.never)
    }
    if (kind === "stuck-finalizer") yield* Effect.addFinalizer(() => Effect.uninterruptible(Effect.never))
    const raw = Context.get(yield* Layer.build(SessionLogFilesLive(join(directory, "sessions"))), SessionLog)
    const logical = observe.sessionLog(raw)
    const sessionsContext = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
      Layer.provide(Layer.merge(Layer.succeed(SessionLog, logical), TurnAdmissionOpen)),
    ))
    const sessions = Context.get(sessionsContext, Sessions)
    const exists = yield* Effect.result(sessions.get(target))
    if (exists._tag === "Failure") yield* sessions.create(target)
    const Hold = Tool.make("process_fixture_hold", { description: "Wait for the fixture controller.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
    const agent = yield* Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
      capabilities: [defineCapability({ id: "process-host-fixture", version: "1", tools: [defineTool({ tool: Hold, handler: () =>
        Effect.sync(() => process.stderr.write("handler-entered\n")).pipe(Effect.andThen(kind === "stuck-work" ? Effect.uninterruptible(Effect.never) : Effect.never)),
      })], skills: [defineSkill({ id: "process-host-fixture", summary: "Use the fixture checkpoint.", tools: [Hold.name], always: true })] })],
      turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3 },
    })
    const calls = { value: 0 }
    const model = yield* LanguageModel.make({
      generateText: (options) => Effect.gen(function* () {
        calls.value++
        yield* Effect.tryPromise(() => appendFile(join(directory, "calls.ndjson"), `${JSON.stringify(options.prompt.content)}\n`)).pipe(Effect.orDie)
        if ((kind === "block" || kind === "stuck-work") && calls.value === 1) return [{ type: "tool-call", id: "process-held-call", name: Hold.name, params: {} }, finish("tool-calls")]
        if (kind === "stalled-output") {
          yield* Effect.sync(() => process.stderr.write("large-output\n"))
          return [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }, finish()]
        }
        return [{ type: "text", text: "The checkpoint is complete." }, finish()]
      }),
      streamText: () => Stream.die("the fixture uses settled calls"),
    })
    const runner = observe.turnRunner(agent)
    const services = Context.add(sessionsContext, LanguageModel.LanguageModel, model)
    const use = (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) })))
    const context = kind === "drain" ? Context.merge(services, yield* Layer.build(InboxDrainLive({
      owners: [target.owner], concurrency: 1, sweepIntervalMs: 25, takeOver: true,
      resume: { _tag: "Before", userMessage: new UserMessage({ text: "Continue the interrupted checkpoint." }) },
    }).pipe(Layer.provideMerge(agentInboxRunner(runner, { services, use })), Layer.provide(Layer.succeedContext(services))))) : services
    return {
      runner, services: context, use, sessions, tasks: Option.none(),
      activity: processActivity.pipe(Effect.provide(context)),
      shutdown: (options) => shutdownGracefully(options).pipe(Effect.provide(context)),
    }
  }),
})

const start = (directory, kind = "idle", hardDeadlineMs = 1200) => {
  const child = spawn(process.execPath, [self, "child", directory, kind, String(hardDeadlineMs)], { stdio: ["pipe", "pipe", "pipe"] })
  const frames = []
  const errors = []
  const stderr = { text: "" }
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  child.stderr.on("data", (chunk) => { stderr.text += chunk.toString(); if (stderr.text.length > 100000) child.kill("SIGKILL") })
  const reading = (async () => {
    for await (const line of reader) {
      frames.push(await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessEvent))(line)))
      assert.ok(frames.length < 10000, "unbounded fixture output")
    }
  })().then(() => undefined, (error) => { errors.push(error) })
  const until = async (predicate, message, timeout = 10000) => {
    const attempts = Math.ceil(timeout / 10)
    for (let i = 0; i < attempts; i++) {
      if (errors.length > 0) throw errors[0]
      if (predicate()) return
      await sleep(10)
    }
    throw new Error(`${message}; stderr=${stderr.text}; frames=${frames.map((frame) => frame._tag).join(",")}`)
  }
  const send = async (command) => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ProcessCommand)(command))
    const line = await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(ProcessCommand))(decoded))
    await new Promise((resolve, reject) => child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve()))
  }
  const hello = async () => {
    await send({ _tag: "hello", requestId: "hello", protocolVersion: 1 })
    await until(() => frames.some((frame) => frame._tag === "hello"), "no hello")
  }
  const frame = async (tag, requestId) => {
    await until(() => frames.some((event) => event._tag === tag && (requestId === undefined || event.requestId === requestId)), `missing ${tag}/${requestId}`)
    return frames.find((event) => event._tag === tag && (requestId === undefined || event.requestId === requestId))
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    const result = await ended
    await reading
    reader.close()
    return result
  }
  const shutdown = async () => {
    await send({ _tag: "shutdown", requestId: "stop", deadlineMs: 180 })
    await frame("shutdown", "stop")
    const result = await ended
    await reading
    assert.deepEqual(errors, [], "the child wrote malformed or non-protocol stdout")
    assert.equal(result.code, 0, stderr.text)
  }
  return { child, frames, stderr, until, send, hello, frame, close, shutdown, ended }
}

const audit = (directory) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const raw = Context.get(yield* Layer.build(SessionLogFilesLive(join(directory, "sessions"))), SessionLog)
  const events = yield* raw.read(target.id, query)
  return { events, states: yield* toolCallStatesOf(events), head: yield* raw.head(target.id) }
})))
const begin = (requestId = "begin", extra = {}) => ({ _tag: "begin", requestId, session: target, runId: RunId.make(requestId), userMessage: new UserMessage({ text: "Find the checkpoint." }), ...extra })
const queued = (tag, requestId) => ({ _tag: tag, requestId, session: target, input: { id: requestId, userMessage: new UserMessage({ text: `${tag} checkpoint ✈` }), source: { channel: "fixture", exact: requestId } } })

const controls = async (directory) => {
  const peer = start(directory, "block")
  try {
    await peer.hello()
    await peer.send(begin())
    await peer.until(() => peer.stderr.text.includes("handler-entered"), "tool did not enter")
    await peer.send(queued("steer", "steer-one"))
    await peer.send(queued("send", "next-one"))
    assert.equal((await peer.frame("queued", "steer-one")).enqueued, true)
    assert.equal((await peer.frame("queued", "next-one")).enqueued, true)
    await peer.send({ _tag: "ping", requestId: "ping" })
    assert.equal((await peer.frame("pong", "ping")).activity.inFlight, true)
    await peer.send({ _tag: "cancel", requestId: "cancel", session: target, turn: 1 })
    assert.equal((await peer.frame("cancelled", "cancel")).cancelled, true)
    const ended = await peer.frame("turn.ended")
    assert.equal(ended.reason, "cancelled")
    assert.equal(peer.frames.filter((frame) => frame._tag === "turn.ended" && frame.turn === 1).length, 1)
    const state = await audit(directory)
    assert.equal(state.events.find((row) => row.seq === ended.journal.seq).data.reason, "cancelled")
    assert.equal(state.events.filter((row) => row.kind === "inbox.queued").length, 2)
    assert.equal(state.events.filter((row) => row.kind === "inbox.taken").length, 0)
    assert.equal(state.states[0]._tag, "Started")
    assert.ok(peer.stderr.text.includes("process fixture setup"), "default Effect logger did not reach stderr")
    await peer.shutdown()
    return { controlsResponsive: true, durableQueueAck: true, cancelExactTurn: true, lifecycleAckVerified: true, protocolOnlyStdout: true }
  } finally { await peer.close() }
}

const restart = async (directory, signal) => {
  const holder = start(directory, "block")
  try {
    await holder.hello()
    await holder.send(begin())
    await holder.until(() => holder.stderr.text.includes("handler-entered"), "tool did not enter")
    await holder.send(queued("steer", "restart-steer"))
    await holder.send(queued("send", "restart-next"))
    await holder.frame("queued", "restart-steer")
    await holder.frame("queued", "restart-next")
    const before = await audit(directory)
    assert.equal(before.events.filter((row) => row.kind === "inbox.queued").length, 2)
    assert.equal(before.states[0]._tag, "Started")
    holder.child.kill(signal)
    const exit = await holder.ended
    if (signal === "SIGTERM") {
      assert.equal(exit.code, 143, holder.stderr.text)
      const stopped = await audit(directory)
      const ending = stopped.events.filter((row) => row.kind === "turn.ended").at(-1)
      assert.equal(ending.data.reason, "interrupted")
      assert.equal(ending.data.failure.code, "turn.shutdown")
    } else assert.equal(exit.signal, "SIGKILL")
  } finally { await holder.close() }
  const resumed = start(directory, "recover")
  try {
    await resumed.hello()
    await resumed.send(begin("resume", { resumes: 1, takeOver: signal === "SIGKILL", userMessage: new UserMessage({ text: "Continue the checkpoint." }) }))
    await resumed.frame("begin.result", "resume")
    await resumed.shutdown()
  } finally { await resumed.close() }
  const drain = start(directory, "drain")
  try {
    await drain.hello()
    await drain.until(() => drain.frames.some((frame) => frame._tag === "turn.ended" && frame.turn >= 3), "retained next input was not drained")
    await drain.send({ _tag: "ping", requestId: "idle" })
    await drain.frame("pong", "idle")
    await drain.shutdown()
  } finally { await drain.close() }
  const state = await audit(directory)
  assert.equal(state.events.filter((row) => row.kind === "turn.started" && row.data.input === "restart-next").length, 1)
  assert.equal(state.events.filter((row) => row.kind === "inbox.taken" && row.data.id === "restart-steer").length, 1)
  assert.equal(state.events.filter((row) => row.kind === "tool.started").length, 1)
  const requests = (await readFile(join(directory, "calls.ndjson"), "utf8")).trim().split("\n")
  assert.equal(requests.length, 3, "restart repeated committed execution")
  assert.ok(requests[1].includes("ToolInterrupted"), "resume hid the interrupted call")
  assert.ok(requests[1].includes("restart-steer") || requests[1].includes("steer checkpoint"), "resume lost the durable steer")
  return signal === "SIGTERM" ? { sigtermStoredShutdown: true, restartResumeVerified: true, retainedInputOnce: true }
    : { sigkillWitnessVerified: true, explicitTakeoverVerified: true, noDuplicateHandler: true }
}

const nativeDeadlines = async (directory) => {
  const setup = start(join(directory, "setup"), "stuck-setup", 350)
  try {
    await setup.send({ _tag: "hello", requestId: "hello", protocolVersion: 1 })
    await setup.until(() => setup.stderr.text.includes("setup-entered"), "setup did not enter")
    setup.child.kill("SIGTERM")
    assert.equal((await setup.ended).code, 124)
  } finally { await setup.close() }
  const finalizer = start(join(directory, "finalizer"), "stuck-finalizer", 350)
  try {
    await finalizer.hello()
    await finalizer.send({ _tag: "shutdown", requestId: "stop" })
    await finalizer.frame("shutdown", "stop")
    assert.equal((await finalizer.ended).code, 124)
  } finally { await finalizer.close() }
  const second = start(join(directory, "second"), "stuck-setup", 5000)
  try {
    await second.send({ _tag: "hello", requestId: "hello", protocolVersion: 1 })
    await second.until(() => second.stderr.text.includes("setup-entered"), "setup did not enter")
    second.child.kill("SIGTERM")
    await sleep(40)
    second.child.kill("SIGINT")
    assert.equal((await second.ended).code, 130)
  } finally { await second.close() }
  // Bun reads child pipes ahead even when its JS reader is paused. Use a
  // native Node parent for this physical pipe test with either child runtime.
  const controller = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { createInterface } from "node:readline";
    const child = spawn(process.argv[1], [process.argv[2], "child", process.argv[3], "stalled-output", "650"], { stdio: ["pipe", "pipe", "pipe"] });
    const reader = createInterface({input: child.stdout, crlfDelay: Infinity});
    const guard = setTimeout(() => { child.kill("SIGKILL"); process.exit(1); }, 20000);
    let stderr = "", signalled = false;
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    reader.once("line", line => {
      assert.equal(JSON.parse(line)._tag, "hello");
      reader.close(); child.stdout.pause();
      child.stdin.write(JSON.stringify(${JSON.stringify(begin())}) + "\\n");
    });
    const poll = setInterval(() => {
      // Small lifecycle frames can precede the large message. Wait for more
      // unread bytes than all of those frames together before signalling.
      if (!signalled && stderr.includes("large-output") && child.stdout.readableLength >= 32768) {
        signalled = true; child.kill("SIGTERM");
      }
    }, 10);
    child.once("exit", code => {
      clearTimeout(guard); clearInterval(poll); child.stdout.destroy();
      assert.ok(signalled, "no unread native output witness");
      assert.equal(code, 124, stderr);
      process.stdout.write("stalled-output-bounded\\n");
    });
    child.stdin.write(JSON.stringify({ _tag:"hello",requestId:"hello",protocolVersion:1 }) + "\\n");
  `
  const stalled = spawn("node", ["--input-type=module", "-e", controller, process.execPath, self, join(directory, "stalled")], { stdio: ["ignore", "pipe", "pipe"] })
  const output = { text: "", error: "" }
  stalled.stdout.on("data", (chunk) => { output.text += chunk.toString() })
  stalled.stderr.on("data", (chunk) => { output.error += chunk.toString() })
  const code = await new Promise((resolve, reject) => { stalled.once("error", reject); stalled.once("exit", resolve) })
  assert.equal(code, 0, output.error)
  assert.equal(output.text, "stalled-output-bounded\n")
  return { hardDeadlineStuckSetup: true, hardDeadlineStuckFinalizer: true, secondSignalVerified: true, stalledStdoutBounded: true }
}

const nativeExitCodes = async (directory) => {
  const version = start(join(directory, "version"))
  try {
    await version.send({ _tag: "hello", requestId: "hello", protocolVersion: 2 })
    assert.equal((await version.frame("error")).code, "protocol.version")
    assert.equal((await version.ended).code, 2)
    assert.ok(!version.stderr.text.includes("process fixture setup"))
  } finally { await version.close() }
  const malformed = start(join(directory, "malformed"))
  try {
    malformed.child.stdin.end("{invalid-json}\n")
    assert.equal((await malformed.frame("error")).code, "protocol.invalid")
    assert.equal((await malformed.ended).code, 2)
  } finally { await malformed.close() }
  const empty = start(join(directory, "empty"))
  try {
    empty.child.stdin.end()
    assert.equal((await empty.frame("error")).code, "protocol.handshake")
    assert.equal((await empty.ended).code, 2)
  } finally { await empty.close() }
  const config = start(join(directory, "config"), "idle", 0)
  try { assert.equal((await config.ended).code, 1) }
  finally { await config.close() }
  return { nativeExitCodesVerified: true }
}

if (mode === "child") await childMain(process.argv[3], process.argv[4], Number(process.argv[5]))
else {
  const directory = await mkdtemp(join(tmpdir(), "efferent-process-host-"))
  try {
    const report = { runtime: process.release.name === "node" && !process.versions.bun ? `Node ${process.versions.node}` : `Bun ${process.versions.bun}`,
      ...await peerKit(),
      ...await controls(join(directory, "controls")),
      ...await restart(join(directory, "term"), "SIGTERM"),
      ...await restart(join(directory, "kill"), "SIGKILL"),
      ...await nativeDeadlines(directory),
      ...await nativeExitCodes(directory),
    }
    process.stdout.write(`process-host ${JSON.stringify(report)}\n`)
  } finally { await rm(directory, { recursive: true, force: true }) }
}
