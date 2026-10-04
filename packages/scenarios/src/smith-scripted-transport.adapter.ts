import { Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { definePlugin } from "@xandreed/core"
import { ModelTransport } from "@xandreed/plugin-models"
import type { ModelFetch } from "@xandreed/plugin-models"
import { SmithPlanningTransport } from "@xandreed/smith"
import { smithCodingCases } from "./smith-coding-cases.entity.js"
import type { SmithCodingTask } from "./smith-coding-cases.entity.js"

const Request = Schema.Struct({ model: Schema.String, stream: Schema.optionalKey(Schema.Boolean), messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })) })
export class ScriptedTransportError extends Schema.TaggedError<ScriptedTransportError>()("ScriptedTransportError", { message: Schema.String }) {}
const tool = (name: string, args: unknown, index: number) => ({ id: `fixture-tool-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })
const wireResponse = (stream: boolean, text: string, tools: ReadonlyArray<ReturnType<typeof tool>>) => {
  const finish = tools.length > 0 ? "tool_calls" : "stop"
  const usage = { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 }
  return stream ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text, tool_calls: tools.map((call, index) => ({ index, ...call })) }, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [{ finish_reason: finish, message: { content: text, tool_calls: tools } }], usage })
}
export const scriptedSmithTransport = (testCase: SmithCodingTask) => Effect.gen(function* () {
  const solution = yield* Option.match(Option.fromNullishOr(smithCodingCases.find((entry) => entry.id === testCase.id)), { onNone: () => Effect.fail(new ScriptedTransportError({ message: "Unknown scripted coding fixture" })), onSome: (entry) => Effect.succeed(entry.solution) })
  const counts = yield* Ref.make({ controller: 0, editor: 0, planning: 0 })
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
  const providerFetch: ModelFetch = (_url, init) => Effect.runPromise(Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(Request)(yield* Effect.try({ try: () => JSON.parse(String(init?.body)), catch: () => new ScriptedTransportError({ message: "Invalid production provider request" }) }))
    const role = JSON.stringify(request.messages).includes("Smith's focused editor") ? "editor" : "controller"
    const headers = new Headers(init?.headers)
    const sessionId = headers.get("x-opencode-session")
    const userAgent = headers.get("user-agent")
    if (sessionId === null || sessionId.length === 0 || userAgent !== "efferent/0.8.0-next.0") return Response.json({ error: { type: "MissingSessionID", message: "OpenCode Go requires session routing and client identification" } }, { status: 400 })
    const step = yield* Ref.modify(counts, (state) => [state[role] + 1, { ...state, [role]: state[role] + 1 }] as const)
    const proposal = request.messages.filter((message) => message.role === "tool").flatMap((message) => {
      const match = String(message.content).match(/Proposal ([^\n]+)/)
      return match?.[1] === undefined ? [] : [match[1]]
    }).at(-1) ?? "missing-proposal"
    const calls = role === "editor" ? step === 1 ? [tool("read_file", { path: "AGENTS.md" }, 0)]
      : step === 2 ? Object.entries(solution).map(([path, content], index) => tool("write_file", { path, content }, index))
      : step === 3 ? [tool("submit_edits", { summary: `Implement ${testCase.id} with Effect 4` }, 0)] : []
      : step === 1 ? [tool("read_file", { path: "AGENTS.md" }, 0), tool("read_file", { path: "tests/acceptance.test.ts" }, 1)]
      : step === 2 ? [tool("delegate_edit", { objective: testCase.task, paths: testCase.paths }, 0)]
      : step === 3 ? [tool("apply_edit_proposal", { proposalId: proposal }, 0)]
      : step === 4 ? [tool("verify", { command: "bun test && bun run check" }, 0)] : []
    yield* Ref.update(requests, (all) => [...all, { protocol: "chat-completions", model: request.model, role, step, streaming: request.stream === true, sessionId, userAgent, tools: calls.map((call) => call.function.name) }])
    return wireResponse(request.stream === true, calls.length > 0 ? "" : "Implemented and verified the requested Effect change.", calls)
  }))
  const planningFetch: ModelFetch = (url, init) => Effect.runPromise(Ref.update(counts, (state) => ({ ...state, planning: state.planning + 1 })).pipe(
    Effect.andThen(Ref.update(requests, (all) => [...all, { protocol: "evaluation-model-v4", endpoint: String(url), body: JSON.parse(String(init?.body)), headers: { model: new Headers(init?.headers).get("ai-model-id"), version: new Headers(init?.headers).get("ai-evaluation-model-specification-version") } }])),
    Effect.as(Response.json({ answers: { approach: { type: "choice", choice: "plan" } } })),
  ))
  const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "unexpected native provider" }, { status: 500 }))))
  const plugin = definePlugin({
    id: "scenarios/smith-scripted-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
    provides: [ModelTransport, SmithPlanningTransport],
    layer: () => Layer.merge(Layer.succeed(ModelTransport, { http, fetch: providerFetch, codex: Option.none() }), Layer.succeed(SmithPlanningTransport, { fetch: planningFetch, apiKey: Option.some(Redacted.make("fixture-key")) })),
  })
  return { plugin, requests: Ref.get(requests), counts: Ref.get(counts) }
})
