import { Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { definePlugin, entriesOfEvents, SessionLogEvent, Sessions } from "@xandreed/core"
import { graphFingerprint } from "@xandreed/runtime"
import { Harness } from "@xandreed/sdk"
import { ModelTransport } from "@xandreed/plugin-models"
import type { ModelFetch } from "@xandreed/plugin-models"
import { smithAgent, SmithPlanningTransport, SMITH_CONTROLLER_PROMPT_VERSION } from "@xandreed/smith"
import { smithCodingCases } from "./smith-coding-cases.entity.js"
import { readSourceFiles, repositoryRoot, seedFixture } from "./smith-coding-fixture.adapter.js"
import { ScriptedTransportError } from "./smith-scripted-transport.adapter.js"
import type { SmithInteractionCase, SmithInteractionEvidence } from "./smith-interaction.entity.js"
import { smithInteractionCandidate } from "./smith-calibration.entity.js"
import type { SmithCalibrationCandidate } from "./smith-calibration.entity.js"

const Message = Schema.Struct({ role: Schema.String, content: Schema.Unknown, reasoning_content: Schema.optionalKey(Schema.String), tool_call_id: Schema.optionalKey(Schema.String) })
const Request = Schema.Struct({ model: Schema.String, stream: Schema.Boolean, messages: Schema.Array(Message), tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String, parameters: Schema.Unknown }) })) })
const reasoning = ["Inspect the requested file", "Recover with README.md", "Report the recovered result"]
const response = (step: number, recovery: boolean) => {
  const call = !recovery || step >= 3 ? [] : [{ index: 0, id: step === 1 ? "interaction-missing" : "interaction-readme", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: step === 1 ? "missing.md" : "README.md" }) } }]
  const finish = call.length > 0 ? "tool_calls" : "stop"
  const delta = { reasoning_content: recovery ? reasoning[step - 1] : "Respond to the greeting", content: call.length > 0 ? "" : recovery ? "Recovered by reading README.md successfully." : "Hi! What would you like to work on?", tool_calls: call }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

/** Fake only HTTP bytes; production model decoding, planning, discovery and tools run unchanged. */
export const runSmithInteractionTrial = (testCase: SmithInteractionCase, candidate: SmithCalibrationCandidate = smithInteractionCandidate) => Effect.gen(function* () {
  const fixture = yield* seedFixture({ ...smithCodingCases[0]!, seed: { "README.md": "# Recovery fixture\nRead recovery succeeded.\n" } }, true)
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
  const calls = yield* Ref.make(0)
  const expectedSession = yield* Ref.make("")
  const fetchModel: ModelFetch = (_url, init) => Effect.runPromise(Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(Request)(yield* Effect.try({ try: () => JSON.parse(String(init?.body)), catch: () => new ScriptedTransportError({ message: "Invalid interaction provider request" }) }))
    const step = yield* Ref.updateAndGet(calls, (count) => count + 1)
    const headers = new Headers(init?.headers)
    const routing = { sessionId: headers.get("x-opencode-session"), userAgent: headers.get("user-agent") }
    yield* Ref.update(requests, (all) => [...all, { protocol: "chat-completions", step, routing, ...request }])
    if (routing.sessionId !== (yield* Ref.get(expectedSession)) || routing.userAgent !== "efferent/0.8.0-next.0") return Response.json({ error: { type: "MissingSessionID", message: "OpenCode requires native conversation routing and client identification" } }, { status: 400 })
    const recovery = testCase.id === "read-recovery"
    const prior = request.messages.filter((message) => message.role === "assistant")
    const previous = request.messages.findLast((message) => message.role === "tool")
    const validReasoning = prior.every((message, index) => message.reasoning_content === reasoning[index])
    const validRecovery = step === 1 || step === 2 && previous?.tool_call_id === "interaction-missing" && String(previous.content).includes('"error":"SmithToolFailure"') || step === 3 && previous?.tool_call_id === "interaction-readme" && String(previous.content).includes("Read recovery succeeded")
    return recovery && (!validReasoning || !validRecovery) ? Response.json({ error: { message: "The production tool continuation lost its reasoning, failed result, or repaired result" } }, { status: 400 }) : response(step, recovery)
  }))
  const fetchPlanning: ModelFetch = (_url, init) => Effect.runPromise(Ref.update(requests, (all) => [...all, { protocol: "evaluation-model-v4", body: JSON.parse(String(init?.body)) }]).pipe(Effect.as(Response.json({ answers: { approach: { type: "choice", choice: "direct" } } }))))
  const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "Unexpected native provider call" }, { status: 400 }))))
  const transport = definePlugin({
    id: "scenarios/smith-interaction-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ModelTransport, SmithPlanningTransport],
    layer: () => Layer.merge(Layer.succeed(ModelTransport, { http, fetch: fetchModel, codex: Option.none() }), Layer.succeed(SmithPlanningTransport, { fetch: fetchPlanning, apiKey: Option.some(Redacted.make("fixture-key")) })),
  })
  const preset = smithAgent(fixture.dir, () => Effect.succeed(false))
  const config = { ...preset.config, plugins: [
    ...(preset.config.plugins ?? []).map((entry) => entry.id === "models" ? { ...entry, options: { model: candidate.driverModel, fastModel: candidate.editorModel, inheritPrevious: false } }
      : entry.id === "loop" ? { ...entry, options: { readOnly: testCase.readOnly, modules: candidate.modules, maxModelRequests: 5, budgetMillis: 20_000 } }
      : entry.id === "telemetry" ? { ...entry, enabled: false } : entry),
    { id: "interaction-transport", use: transport.id },
  ] }
  const harness = yield* Harness.make({ workspace: fixture.dir, config, plugins: [...preset.plugins, transport] })
  const graph = yield* harness.graph
  const session = yield* harness.create()
  yield* Ref.set(expectedSession, session.record.id)
  const outcome = yield* Effect.result(session.send(testCase.task))
  const events = yield* session.journalHistory
  const entries = yield* entriesOfEvents(events)
  const reply = Option.getOrElse(entries.flatMap((entry) => entry.body._tag === "TurnEnded" ? [entry.body.reply] : []).at(-1) ?? Option.none(), () => "")
  const children = yield* session.use(Sessions, (sessions) => sessions.list({ owner: fixture.dir, parent: session.record.id }))
  const modelRequests = (yield* Ref.get(requests)).filter((request) => typeof request === "object" && request !== null && "protocol" in request && request.protocol === "chat-completions")
  const decodedRequests = yield* Effect.forEach(modelRequests, (request) => Schema.decodeUnknownEffect(Request)(request))
  const tools = events.filter((event) => event.kind === "tool.completed")
  const safe = (text: string) => text.replaceAll(fixture.dir, "<workspace>").replaceAll(repositoryRoot, "<efferent>").replaceAll(homedir(), "<home>")
  const parentEvents = yield* Schema.encodeEffect(Schema.Array(SessionLogEvent))(events).pipe(Effect.map((encoded) => JSON.parse(safe(JSON.stringify(encoded))) as ReadonlyArray<unknown>))
  return {
    caseId: testCase.id, outcome: outcome._tag === "Success" ? String(events.findLast((event) => event.kind === "turn.ended")?.data.reason) : "failed", reply, error: outcome._tag === "Failure" ? safe(outcome.failure.message) : null,
    outerGraphFingerprint: graphFingerprint(graph), controllerPromptVersion: SMITH_CONTROLLER_PROMPT_VERSION,
    immutableWorkspace: Object.entries(fixture.seed).every(([path, text]) => readFileSync(join(fixture.dir, path), "utf8") === text) && Object.keys(readSourceFiles(fixture.dir)).length === 0,
    parentEvents, requests: JSON.parse(safe(JSON.stringify(yield* Ref.get(requests)))) as ReadonlyArray<unknown>, checks: [
      { name: "bounded model dispatches and no editor child", pass: modelRequests.length === (testCase.id === "read-recovery" ? 3 : 1) && children.sessions.length === 0 },
      { name: "greeting avoids tools or recovery records one genuine failure and one success", pass: testCase.id === "read-recovery" ? tools.length === 2 && tools[0]?.data.ok === false && tools[1]?.data.ok === true : tools.length === 0 },
      { name: "one native parent turn and final reply", pass: ["turn.started", "turn.ended", "turn.reply"].every((kind) => events.filter((event) => event.kind === kind).length === 1) },
      { name: "actual user remains the final user message and receives the result", pass: decodedRequests.every((request) => request.messages.findLast((message) => message.role === "user")?.content === testCase.task) && reply === (testCase.id === "read-recovery" ? "Recovered by reading README.md successfully." : "Hi! What would you like to work on?") },
      { name: "restricted roles hide forbidden skill instructions", pass: !testCase.readOnly || modelRequests.every((request) => !JSON.stringify(request).includes("- smith.controller:") && !JSON.stringify(request).includes("- smith.verify:") && !JSON.stringify(request).includes("- smith.editor:")) },
    ],
  } satisfies SmithInteractionEvidence
})
