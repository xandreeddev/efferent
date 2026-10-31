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
  replayModelRequest, RunId, RunOrdinal, SessionLog, SessionLogMemoryLive, Sessions,
  STORED_FORMAT, StoredData, toolCallStatesOf, TurnAdmissionOpen, TurnMemory, UserMessage,
} from "@xandreed/core"
import { isVolatileContext } from "@xandreed/core/internal"
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
const applicationInput = { cache_control: "application input" }
const applicationResult = { cache_control: null, nested: { cache_control: "application result" } }
const CacheDataProbe = Tool.make(Probe.name, {
  description: "Return the fixture checkpoint.", parameters: Schema.Struct({ cache_control: Schema.String }),
  success: Schema.Struct({ cache_control: Schema.Null, nested: Schema.Struct({ cache_control: Schema.String }) }), failure: Failure, failureMode: "return",
})
const check = (condition, message) => Effect.sync(() => assert.ok(condition, message))
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const volatileTail = (step) => `Cache fixture volatile step ${step}.`
// Only supported request/block locations are cache positions. Tool inputs,
// schemas, encoded results and image sources remain application data.
const contentBlocks = (blocks) => Array.isArray(blocks) ? blocks.flatMap((block) => [
  ...(block.type === "tool_result" ? contentBlocks(block.content) : []), block,
]) : []
const cacheBlocks = (body) => [
  ...(body.tools ?? []), ...contentBlocks(body.system),
  ...(body.messages ?? []).flatMap((message) => contentBlocks(message.content)),
]
const controlsOf = (body) => [body, ...cacheBlocks(body)].filter((block) => Object.hasOwn(block, "cache_control"))
const nonnullControls = (body) => controlsOf(body).filter((block) => block.cache_control !== null && block.cache_control !== undefined)

const contentOf = (callId, first, input) => first ? [
  { type: "thinking", thinking: reasoning, signature },
  { type: "redacted_thinking", data: redactedData },
  { type: "tool_use", id: callId, name: Probe.name, input },
] : [{ type: "text", text: answer }]
const messageOf = (callId, first, input) => ({
  id: first ? "msg_fixture_tool" : "msg_fixture_answer", type: "message", role: "assistant", model: modelId,
  content: contentOf(callId, first, input), stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null,
  usage, input_transformations: [],
})

/** Emit the documented event shapes through a real HTTP response stream. */
const eventsOf = (callId, first, input) => [
  { type: "message_start", message: { ...messageOf(callId, first, input), content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
  ...contentOf(callId, first, input).flatMap((part, index) => part.type === "thinking" ? [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part.thinking } },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature: part.signature } },
    { type: "content_block_stop", index },
  ] : part.type === "redacted_thinking" ? [
    { type: "content_block_start", index, content_block: part },
    { type: "content_block_stop", index },
  ] : part.type === "tool_use" ? [
    { type: "content_block_start", index, content_block: { ...part, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.input) } },
    { type: "content_block_stop", index },
  ] : [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text: part.text } },
    { type: "content_block_stop", index },
  ]),
  { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
  { type: "message_stop" },
]

const startServer = async (callId, input) => {
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
          ? eventsOf(callId, first, input).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
          : JSON.stringify(messageOf(callId, first, input)))
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

const runCase = async ({ auth, streaming, path, policy, promptCache, cacheControl = true, callerTtl, label = "default" }) => {
  const callId = `toolu_fixture_${auth}_${streaming ? "stream" : "settled"}`
  const server = await startServer(callId, cacheControl ? {} : applicationInput)
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
      const handler = (input) => Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1)
        const states = yield* toolCallStatesOf(yield* sessions.read(address))
        yield* check(states.length === 1 && states[0]._tag === "Started" && states[0].toolCallId === callId,
          "the handler ran before its assistant call and tool.started were durable")
        yield* Ref.set(durable, true)
        if (!cacheControl) yield* check(input.cache_control === applicationInput.cache_control, "cache capability removal changed application tool input")
        return cacheControl ? "probe done" : applicationResult
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false, model: selection,
          endpoints: { gateway: { api: "anthropic-messages", url: `${server.origin}${path}`, auth,
            apiKey: Redacted.make(placeholder), apiVersion, images: true,
            betas: [endpointBeta, bindingBeta, endpointBeta], ...(cacheControl ? {} : { cacheControl: false }),
          } },
          modelSettings: { [selection]: { thinking: { _tag: "Adaptive" }, effort: "xhigh", limits: { maxOutputTokens: 512 }, ...(promptCache === undefined ? {} : { promptCache }) } },
        } }],
        capabilities: [defineCapability({ id: "messages-fixture", version: "1",
          tools: [defineTool({ tool: cacheControl ? Probe : CacheDataProbe, handler, view: { version: "1", render: (result) => typeof result === "string" ? result : JSON.stringify(result) }, annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "messages-fixture", summary: "Use the fixture checkpoint.", always: true, tools: [Probe.name] })],
        })],
        workspace, limits: { streaming, maxSteps: 3 },
      })
      const runId = RunId.make(`messages-${auth}-${streaming}-${label}`)
      const outcome = yield* agent.turn({ turn: { session: address, runId, userMessage: new UserMessage({ text: "Run the checkpoint, then answer." }) }, services: Context.make(Sessions, sessions) },
        (turn) => Effect.gen(function* () {
          yield* turn.tools.select(turn.userMessage)
          if (callerTtl !== undefined) yield* (yield* TurnMemory).session.record([{ _tag: "Message", run: RunOrdinal.make(0), message: {
            role: "user", content: "Caller-owned stable cache prefix.", providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: callerTtl } } },
          } }], 0)
          const done = yield* turn.run({ stepContext: "tail", step: (step) => Effect.succeed({ context: Option.some(volatileTail(step.stepIndex)), toolChoice: Option.none() }) })
            .pipe(Effect.provideService(CurrentModelCallPolicy, policy))
          return { outcome: done.outcome, reply: Option.some(done.text) }
        }))
      yield* check(outcome.outcome === "completed" && Option.contains(outcome.reply, answer), "the real agent did not complete the two-step tool turn")
      yield* check((yield* Ref.get(calls)) === 1 && (yield* Ref.get(durable)), "the tool did not run exactly once after durable admission")
      if (cacheControl && (promptCache?._tag ?? "Auto") === "Auto") yield* check(server.seen.every((request, step) =>
        cacheBlocks(request.body).filter((block) => typeof block.text === "string" && block.text.includes(volatileTail(step))).every((block) => block.cache_control == null)),
      "framework Auto cached the volatile step-context tail")
      const events = yield* sessions.read(address)
      yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
        onNone: () => Effect.die(`the Messages journey stored an unrecognized kind ${event.kind}`),
        onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
      }), { concurrency: 1, discard: true })
      yield* Effect.forEach(Object.keys(StoredData), (kind) => readStored(kind, events), { concurrency: 1, discard: true })
      const entries = yield* entriesOfEvents(events)
      const states = yield* toolCallStatesOf(events)
      yield* check(states.length === 1 && states[0]._tag === "Completed" && states[0].toolCallId === callId && (cacheControl ? states[0].result.encoded === "probe done" : states[0].result.encoded?.nested?.cache_control === "application result"),
        "the final journal did not preserve the provider call id and durable result")
      const headers = yield* readStored("request.prepared", events)
      yield* check(headers.length === 2, "the two-step turn did not store two replayable request headers")
      const replayed = yield* Effect.forEach(headers, ({ data }) => replayModelRequest(events, runId, data.step, data.run), { concurrency: 1 })
      yield* Effect.forEach(replayed, (request, index) => Effect.sync(() => {
        const boundary = headers[index].data.stableMessages
        const volatile = request.prompt.content.findIndex((message) => isVolatileContext(message.options ?? {}))
        assert.ok(Number.isInteger(boundary) && boundary > 0, "the request did not freeze its stable-prefix boundary")
        assert.equal(volatile, boundary + 1, "replay did not use the saved boundary after the system message")
        assert.ok(JSON.stringify(request.prompt.content[volatile].content).includes(volatileTail(index)), "replay lost the changing step-context tail")
      }), { concurrency: 1, discard: true })
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
          auth, apiVersion, betas: [endpointBeta, bindingBeta, endpointBeta], cacheControl },
        promptCache: promptCache ?? { _tag: "Auto", ttl: "5m" }, cacheControl,
        thinkingPrefixMismatch: "drop_block",
      }, "the replayed request lost resolved Messages controls or public endpoint configuration")), { concurrency: 1, discard: true })
      const history = JSON.stringify(events)
      yield* check(!history.includes(placeholder), "a credential entered the durable journal")
      yield* check(JSON.stringify(entries).includes(JSON.stringify(signature).slice(1, -1))
        && JSON.stringify(entries).includes(JSON.stringify(redactedData).slice(1, -1)), "the durable memory lost opaque thinking bytes")
      yield* check(!JSON.stringify(entries).includes("requestVolatile"), "request volatility mutated durable message entries")
      const head = yield* log.head(address.id)
      yield* check(head.state.sessions?.format === STORED_FORMAT, "the Messages journey did not use the current stored format")
      return { toolCalls: yield* Ref.get(calls), headers: headers.length, format: head.state.sessions.format, replayed: replayed.length }
    })).pipe(Effect.timeout("15 seconds")))

    assert.equal(server.seen.length, 2, "the server did not receive exactly two requests")
    const expectedPath = `${path.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages${streaming ? "" : "?beta=true"}`
    for (const [index, request] of server.seen.entries()) {
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
      assert.ok(!JSON.stringify(request.body).includes('"engine"'), "neutral engine metadata reached the provider wire")
      const blocks = cacheBlocks(request.body)
      const volatile = blocks.findIndex((block) => typeof block.text === "string" && block.text.includes(volatileTail(index)))
      assert.ok(volatile >= 0, "the wire request lost its step-context tail")
      const mode = promptCache?._tag ?? "Auto"
      const controls = nonnullControls(request.body)
      assert.ok(controls.length <= 4, "cache controls exceeded the provider's four-slot cap")
      const ttls = controls.map((block) => block.cache_control.ttl ?? "5m")
      assert.ok(!ttls.some((ttl, at) => ttl === "1h" && ttls.slice(0, at).includes("5m")), "a long-lived control followed a short-lived control")
      if (!cacheControl) {
        assert.equal(controlsOf(request.body).length, 0, "a cache-disabled gateway received a cache_control key, including null")
        const tool = request.body.tools.find((tool) => tool.name === Probe.name)
        assert.equal(tool.input_schema.properties.cache_control.type, "string", "capability removal deleted an application schema property")
      }
      else if (mode === "Off") assert.equal(controls.length, 0, "Off added framework cache controls")
      else if (mode === "TopLevel") {
        assert.deepEqual(request.body.cache_control, { type: "ephemeral", ttl: promptCache.ttl }, "TopLevel did not select API automatic caching")
        assert.equal(blocks.filter((block) => block.cache_control != null).length, 0, "TopLevel also added explicit block markers")
        assert.equal(volatile, blocks.length - 1, "TopLevel's actual final target was not the host-selected volatile tail")
      } else {
        assert.ok(controls.length > 0, "Auto did not preserve or add any stable-prefix cache control")
        assert.ok(blocks.slice(volatile).every((block) => block.cache_control == null), "an automatic marker crossed the volatile boundary")
        if (callerTtl === undefined) assert.ok(ttls.every((ttl) => ttl === (promptCache?.ttl ?? "5m")), "Auto changed the requested lifetime")
        else assert.ok(blocks.some((block) => block.text === "Caller-owned stable cache prefix." && block.cache_control?.ttl === callerTtl), "the caller-owned cache marker was lost or changed")
      }
    }
    const assistant = server.seen[1].body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content)
    assert.deepEqual(assistant.filter((part) => part.type === "thinking"), [{ type: "thinking", thinking: reasoning, signature }], "the second request changed signed thinking")
    assert.deepEqual(assistant.filter((part) => part.type === "redacted_thinking"), [{ type: "redacted_thinking", data: redactedData }], "the second request changed redacted thinking")
    if (!cacheControl) assert.deepEqual(assistant.find((part) => part.type === "tool_use").input, applicationInput, "capability removal deleted an application tool input key")
    const results = server.seen[1].body.messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result")
    assert.equal(results.length, 1)
    assert.equal(results[0].tool_use_id, callId)
    assert.ok(JSON.stringify(results[0].content).includes(cacheControl ? "probe done" : "application result"))
    assert.deepEqual(await readdir(workspace), [], "memory configuration wrote to the workspace")
    return { auth, streaming, requests: server.seen.length, signedRoundTrip: true, cachePolicy: promptCache?._tag ?? "Auto", cacheControl, cacheVerified: true, volatileBoundary: true, ...result }
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
    ...(process.argv.includes("--prompt-cache") ? [
      await runCase({ auth: "x-api-key", streaming: false, path: "/v1", policy: Option.none(), promptCache: { _tag: "Auto", ttl: "1h" }, label: "hour" }),
      await runCase({ auth: "bearer", streaming: true, path: "/", policy: Option.none(), promptCache: { _tag: "TopLevel", ttl: "5m" }, label: "top-level" }),
      await runCase({ auth: "x-api-key", streaming: false, path: "/", policy: Option.none(), promptCache: { _tag: "Off" }, label: "off" }),
      await runCase({ auth: "bearer", streaming: true, path: "/proxy/v1", policy: Option.none(), promptCache: { _tag: "TopLevel", ttl: "1h" }, cacheControl: false, label: "disabled" }),
      await runCase({ auth: "x-api-key", streaming: false, path: "/", policy: Option.none(), callerTtl: "1h", label: "caller-hour" }),
    ] : []),
  ]
  console.log(`anthropic-messages ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", scenarios })}`)
} finally { clearTimeout(watchdog) }
