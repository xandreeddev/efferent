/**
 * The real agent over a local Messages fixture, on source Bun and packed
 * Node/Bun. Thinking signatures are opaque fake bytes: this proves request
 * preservation and framework behavior, not acceptance by a real provider.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import {
  ConversationId, CurrentModelCallPolicy, defineCapability, defineSkill,
  defineTool, entriesOfEvents, Failure, journalSchemaOf, readStored,
  replayModelRequest, RunId, SessionLog, SessionLogMemoryLive, Sessions,
  STORED_FORMAT, StoredData, toolCallStatesOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const modelId = "claude-fable-5-1"
const selection = `gateway:${modelId}`
const placeholder = "opaque-gateway-placeholder:+/=literal"
const signature = "opaque-signature:+/=\nline-two-\u2028-\ud83c\udf20"
const redactedData = "opaque-redacted:+/=\nline-two-\u2028-\ud83c\udf20"
const reasoning = "A fixture reasoning summary.\nKeep its signature unchanged."
const answer = "Messages endpoint complete."
const endpointBeta = "fixture-messages-2026-10-31"
const bindingBeta = "thinking-binding-controls-2026-08-01"
const sdkBeta = "structured-outputs-2025-11-13"
const apiVersion = "2026-10-21"
const Probe = Tool.make("messages_probe", {
  description: "Return the fixture checkpoint.", parameters: Tool.EmptyParams,
  success: Schema.String, failure: Failure, failureMode: "return",
})
const check = (condition, message) => Effect.sync(() => assert.ok(condition, message))
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const contentOf = (callId, first) => first ? [
  { type: "thinking", thinking: reasoning, signature },
  { type: "redacted_thinking", data: redactedData },
  { type: "tool_use", id: callId, name: Probe.name, input: {} },
] : [{ type: "text", text: answer }]
const messageOf = (callId, first) => ({
  id: first ? "msg_fixture_tool" : "msg_fixture_answer", type: "message", role: "assistant", model: modelId,
  content: contentOf(callId, first), stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null,
  usage, input_transformations: [],
})

/** Emit the documented event shapes through a real HTTP response stream. */
const eventsOf = (callId, first) => [
  { type: "message_start", message: { ...messageOf(callId, first), content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
  ...contentOf(callId, first).flatMap((part, index) => part.type === "thinking" ? [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part.thinking } },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature: part.signature } },
    { type: "content_block_stop", index },
  ] : part.type === "redacted_thinking" ? [
    { type: "content_block_start", index, content_block: part },
    { type: "content_block_stop", index },
  ] : part.type === "tool_use" ? [
    { type: "content_block_start", index, content_block: { ...part, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index },
  ] : [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text: part.text } },
    { type: "content_block_stop", index },
  ]),
  { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
  { type: "message_stop" },
]

const startServer = async (callId) => {
  const seen = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const first = seen.length === 0
        seen.push({ url: request.url, method: request.method, headers: request.headers, body })
        response.statusCode = 200
        response.setHeader("content-type", body.stream ? "text/event-stream" : "application/json")
        response.end(body.stream
          ? eventsOf(callId, first).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
          : JSON.stringify(messageOf(callId, first)))
      } catch (error) {
        response.statusCode = 400
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error.message } }))
      }
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { seen, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) }
}

const runCase = async ({ auth, streaming, path, policy }) => {
  const callId = `toolu_fixture_${auth}_${streaming ? "stream" : "settled"}`
  const server = await startServer(callId)
  const workspace = await mkdtemp(join(tmpdir(), "efferent-messages-")).catch(async (error) => { await server.close(); throw error })
  try {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
        Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
      ))
      const sessions = Context.get(context, Sessions)
      const log = Context.get(context, SessionLog)
      const address = { id: ConversationId.make("00000000-0000-4000-8000-000000005540"), owner: "messages-journey" }
      yield* sessions.create(address)
      const calls = yield* Ref.make(0)
      const durable = yield* Ref.make(false)
      const handler = () => Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1)
        const states = yield* toolCallStatesOf(yield* sessions.read(address))
        yield* check(states.length === 1 && states[0]._tag === "Started" && states[0].toolCallId === callId,
          "the handler ran before its assistant call and tool.started were durable")
        yield* Ref.set(durable, true)
        return "probe done"
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false, model: selection,
          endpoints: { gateway: { api: "anthropic-messages", url: `${server.origin}${path}`, auth,
            apiKey: Redacted.make(placeholder), apiVersion, images: true,
            betas: [endpointBeta, bindingBeta, endpointBeta],
          } },
          modelSettings: { [selection]: { thinking: { _tag: "Adaptive" }, effort: "xhigh", limits: { maxOutputTokens: 512 } } },
        } }],
        capabilities: [defineCapability({ id: "messages-fixture", version: "1",
          tools: [defineTool({ tool: Probe, handler, annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "messages-fixture", summary: "Use the fixture checkpoint.", always: true, tools: [Probe.name] })],
        })],
        workspace, limits: { streaming, maxSteps: 3 },
      })
      const runId = RunId.make(`messages-${auth}-${streaming}`)
      const outcome = yield* agent.turn({ turn: { session: address, runId, userMessage: new UserMessage({ text: "Run the checkpoint, then answer." }) }, services: Context.make(Sessions, sessions) },
        (turn) => turn.tools.select(turn.userMessage).pipe(
          Effect.andThen(turn.run({}).pipe(Effect.provideService(CurrentModelCallPolicy, policy))),
          Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })),
        ))
      yield* check(outcome.outcome === "completed" && Option.contains(outcome.reply, answer), "the real agent did not complete the two-step tool turn")
      yield* check((yield* Ref.get(calls)) === 1 && (yield* Ref.get(durable)), "the tool did not run exactly once after durable admission")
      const events = yield* sessions.read(address)
      yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
        onNone: () => Effect.die(`the Messages journey stored an unrecognized kind ${event.kind}`),
        onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
      }), { concurrency: 1, discard: true })
      yield* Effect.forEach(Object.keys(StoredData), (kind) => readStored(kind, events), { concurrency: 1, discard: true })
      const entries = yield* entriesOfEvents(events)
      const states = yield* toolCallStatesOf(events)
      yield* check(states.length === 1 && states[0]._tag === "Completed" && states[0].toolCallId === callId && states[0].result.encoded === "probe done",
        "the final journal did not preserve the provider call id and durable result")
      const headers = yield* readStored("request.prepared", events)
      yield* check(headers.length === 2, "the two-step turn did not store two replayable request headers")
      const replayed = yield* Effect.forEach(headers, ({ data }) => replayModelRequest(events, runId, data.step, data.run), { concurrency: 1 })
      yield* check(replayed.every((request) => Option.exists(request.model, (model) => model.provider === "gateway" && model.model === modelId)),
        "the request headers lost the resolved gateway/model identity")
      yield* check(replayed.every((request) => Option.isSome(policy)
        ? Option.exists(request.callPolicy, (value) => value.effort === "max" && value.maxOutputTokens === 321)
        : Option.isNone(request.callPolicy)), "the request headers lost the call policy")
      yield* Effect.forEach(replayed, (request) => Effect.sync(() => assert.deepEqual(Option.getOrThrow(request.model).settings, {
        fallback: null, policy: Option.getOrElse(policy, () => null), model: modelId,
        max_tokens: Option.isSome(policy) ? 321 : 512, output_config: { effort: Option.isSome(policy) ? "max" : "xhigh" },
        thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        endpoint: { api: "anthropic-messages", url: `${server.origin}${path.replace(/\/+$/, "").replace(/\/v1$/, "")}`,
          auth, apiVersion, betas: [endpointBeta, bindingBeta, endpointBeta] },
        thinkingPrefixMismatch: "drop_block",
      }, "the replayed request lost resolved Messages controls or public endpoint configuration")), { concurrency: 1, discard: true })
      const history = JSON.stringify(events)
      yield* check(!history.includes(placeholder), "a credential entered the durable journal")
      yield* check(JSON.stringify(entries).includes(JSON.stringify(signature).slice(1, -1))
        && JSON.stringify(entries).includes(JSON.stringify(redactedData).slice(1, -1)), "the durable memory lost opaque thinking bytes")
      const head = yield* log.head(address.id)
      yield* check(head.state.sessions?.format === STORED_FORMAT, "the Messages journey did not use the current stored format")
      return { toolCalls: yield* Ref.get(calls), headers: headers.length, format: head.state.sessions.format, replayed: replayed.length }
    })).pipe(Effect.timeout("15 seconds")))

    assert.equal(server.seen.length, 2, "the server did not receive exactly two requests")
    const expectedPath = `${path.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages${streaming ? "" : "?beta=true"}`
    for (const request of server.seen) {
      assert.equal(request.method, "POST")
      assert.equal(request.url, expectedPath, "the endpoint base URL was joined incorrectly")
      assert.equal(request.headers["anthropic-version"], apiVersion)
      assert.match(request.headers["content-type"], /^application\/json/)
      assert.equal(request.headers["x-api-key"], auth === "x-api-key" ? placeholder : undefined)
      assert.equal(request.headers.authorization, auth === "bearer" ? `Bearer ${placeholder}` : undefined)
      const betas = request.headers["anthropic-beta"].split(",")
      assert.deepEqual(betas, [sdkBeta, endpointBeta, bindingBeta], "endpoint/binding flags replaced or duplicated the SDK's inferred beta")
      assert.equal(request.body.model, modelId)
      assert.deepEqual(request.body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } })
      assert.deepEqual(request.body.output_config, { effort: Option.isSome(policy) ? "max" : "xhigh" })
      assert.equal(request.body.max_tokens, Option.isSome(policy) ? 321 : 512)
      assert.equal(request.body.stream === true, streaming)
      assert.equal(JSON.stringify(request.body).includes("You are Claude Code"), false, "a gateway received the subscription prelude")
      assert.ok(!["temperature", "top_p", "top_k"].some((field) => field in request.body), "the explicit modern API request sent unsupported sampling fields")
    }
    const assistant = server.seen[1].body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content)
    assert.deepEqual(assistant.filter((part) => part.type === "thinking"), [{ type: "thinking", thinking: reasoning, signature }], "the second request changed signed thinking")
    assert.deepEqual(assistant.filter((part) => part.type === "redacted_thinking"), [{ type: "redacted_thinking", data: redactedData }], "the second request changed redacted thinking")
    const results = server.seen[1].body.messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result")
    assert.equal(results.length, 1)
    assert.equal(results[0].tool_use_id, callId)
    assert.ok(JSON.stringify(results[0].content).includes("probe done"))
    assert.deepEqual(await readdir(workspace), [], "memory configuration wrote to the workspace")
    return { auth, streaming, requests: server.seen.length, signedRoundTrip: true, ...result }
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error("the Messages fixture timed out"); process.exit(2) }, 40_000)
watchdog.unref()
try {
  const scenarios = [
    await runCase({ auth: "x-api-key", streaming: false, path: "/gateway/v1/", policy: Option.some({ effort: "max", maxOutputTokens: 321 }) }),
    await runCase({ auth: "bearer", streaming: true, path: "/", policy: Option.none() }),
  ]
  console.log(`anthropic-messages ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", scenarios })}`)
} finally { clearTimeout(watchdog) }
