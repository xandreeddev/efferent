import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { definePlugin } from "@xandreed/core"
import { ModelTransport } from "@xandreed/plugin-models"
import type { ModelFetch } from "@xandreed/plugin-models"
import { Harness } from "@xandreed/sdk"
import { smithAgent } from "../preset.js"
import { SmithPlanningTransport } from "../planning/transport.port.js"

const sse = (events: ReadonlyArray<unknown>) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
const anthropicHello = () => sse([
  { type: "message_start", message: { id: "msg-hello", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello!" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12, input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  { type: "message_stop" },
])
const ChatRequest = Schema.Struct({ model: Schema.String, stream: Schema.optionalKey(Schema.Boolean), messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })) })
const tool = (name: string, params: Record<string, unknown>, index: number) => ({ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(params) } })
const chatResponse = (stream: boolean, text: string, calls: ReadonlyArray<ReturnType<typeof tool>>) => {
  const usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }
  const finish = calls.length > 0 ? "tool_calls" : "stop"
  return stream ? sse([{ choices: [{ delta: { content: text, tool_calls: calls.map((call, index) => ({ index, ...call })) }, finish_reason: finish }], usage }])
    : Response.json({ choices: [{ message: { role: "assistant", content: text, tool_calls: calls }, finish_reason: finish }], usage })
}
const workspaceFor = (provider: string) => {
  const workspace = mkdtempSync(join(tmpdir(), "smith-provider-behavior-"))
  mkdirSync(join(workspace, ".efferent/runtime"), { recursive: true })
  writeFileSync(join(workspace, ".efferent/runtime/auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "fixture-key" } }))
  return workspace
}

describe("Smith behavior through production provider transports", () => {
  test.each(["direct", "unavailable"] as const)("Anthropic hello remains the user request with %s Jev planning and performs no tool work", async (planning) => {
    const workspace = workspaceFor("anthropic")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<unknown>>([])
      const decisions = yield* Ref.make(0)
      const http = HttpClient.make((request) => Effect.gen(function* () {
        const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
        yield* Ref.update(requests, (all) => [...all, JSON.parse(body)])
        return HttpClientResponse.fromWeb(request, anthropicHello())
      }))
      const planningFetch: ModelFetch = () => Effect.runPromise(Ref.update(decisions, (count) => count + 1).pipe(Effect.as(planning === "direct" ? Response.json({ answers: { approach: { type: "choice", choice: "direct" } } }) : Response.json({ error: "Planning service unavailable" }, { status: 503 }))))
      const transport = definePlugin({ id: "test/hello-provider-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ModelTransport, SmithPlanningTransport], layer: () => Layer.merge(
        Layer.succeed(ModelTransport, { http, fetch: () => Promise.reject(new Error("Unexpected compatibility provider request")), codex: Option.none() }),
        Layer.succeed(SmithPlanningTransport, { fetch: planningFetch, apiKey: Option.some(Redacted.make("fixture-planning-key")) }),
      ) })
      const preset = smithAgent(workspace)
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, transport], config: { ...preset.config, plugins: [
        ...(preset.config.plugins ?? []).map((entry) => entry.id === "models" ? { ...entry, options: { model: "anthropic:claude-haiku-4-5", fastModel: "anthropic:claude-haiku-4-5", inheritPrevious: false } } : entry.id === "loop" ? { ...entry, options: { readOnly: planning === "unavailable" } } : entry.id === "telemetry" ? { ...entry, enabled: false } : entry),
        { id: "transport", use: transport.id },
      ] } })
      const session = yield* harness.create()
      yield* session.send("hello")
      const events = yield* session.journalHistory
      expect(yield* Ref.get(decisions)).toBe(1)
      expect(yield* Ref.get(requests)).toHaveLength(1)
      const request = (yield* Ref.get(requests))[0]
      const wire = yield* Schema.decodeUnknownEffect(Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })), system: Schema.Unknown }))(request)
      const users = wire.messages.filter((message) => message.role === "user")
      expect(users).toHaveLength(1)
      expect(JSON.stringify(users[0]?.content)).toContain("hello")
      expect(JSON.stringify(users)).not.toContain("Internal planning")
      expect(JSON.stringify(wire.system)).toContain("Respond directly to greetings")
      expect(JSON.stringify(wire.system)).toContain("For a simple greeting, reply with one short sentence")
      expect(JSON.stringify(wire.system)).toContain("Describe capabilities only when asked")
      if (planning === "unavailable") expect(JSON.stringify(wire.system)).toContain("Internal planning policy")
      expect(events.filter((event) => event.kind === "tool.started")).toHaveLength(0)
      expect(events.filter((event) => event.kind === "smith.editor")).toHaveLength(0)
      expect(events.filter((event) => event.kind === "smith.check")).toHaveLength(0)
      expect((yield* session.history).findLast((event) => event.name === "run.completed")?.data.text).toBe("Hello!")
    })).pipe(Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("a controller and editor recover real missing-file and exact-edit failures through provider tool-result replay", async () => {
    const workspace = workspaceFor("opencode")
    writeFileSync(join(workspace, "value.ts"), "export const value = 'old'\n")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const counts = yield* Ref.make({ driver: 0, editor: 0 })
      const requests = yield* Ref.make<ReadonlyArray<typeof ChatRequest.Type>>([])
      const providerFetch: ModelFetch = (_url, init) => Effect.runPromise(Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChatRequest))(String(init?.body))
        yield* Ref.update(requests, (all) => [...all, request])
        const editor = request.messages.some((message) => message.role === "system" && String(message.content).startsWith("You are Smith's focused editor."))
        const role = editor ? "editor" : "driver"
        const step = yield* Ref.modify(counts, (all) => [all[role], { ...all, [role]: all[role] + 1 }] as const)
        const proposal = request.messages.filter((message) => message.role === "tool").flatMap((message) => /^Proposal ([^\n]+)/.exec(String(message.content))?.[1] ?? []).at(-1) ?? "missing"
        const calls = editor ? step === 0 ? [tool("edit_file", { path: "value.ts", oldText: "wrong source", newText: "new" }, step)]
          : step === 1 ? [tool("read_file", { path: "value.ts" }, step)]
          : step === 2 ? [tool("edit_file", { path: "value.ts", oldText: "old", newText: "new" }, step)]
          : step === 3 ? [tool("submit_edits", { summary: "Corrected the value after reading the actual source" }, step)] : []
          : step === 0 ? [tool("read_file", { path: "missing.ts" }, step)]
          : step === 1 ? [tool("read_file", { path: "value.ts" }, step)]
          : step === 2 ? [tool("delegate_edit", { objective: "Replace old with new in value.ts", paths: ["value.ts"] }, step)]
          : step === 3 ? [tool("apply_edit_proposal", { proposalId: proposal }, step)]
          : step === 4 ? [tool("read_file", { path: "value.ts" }, step)] : []
        return chatResponse(request.stream === true, calls.length === 0 ? "Updated the value and inspected the applied source. No commands were run." : "", calls)
      }))
      const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "Unexpected native provider request" }, { status: 500 }))))
      const planningFetch: ModelFetch = () => Promise.resolve(Response.json({ answers: { approach: { type: "choice", choice: "direct" } } }))
      const transport = definePlugin({ id: "test/recovery-provider-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ModelTransport, SmithPlanningTransport], layer: () => Layer.merge(
        Layer.succeed(ModelTransport, { http, fetch: providerFetch, codex: Option.none() }), Layer.succeed(SmithPlanningTransport, { fetch: planningFetch, apiKey: Option.some(Redacted.make("fixture-planning-key")) }),
      ) })
      const preset = smithAgent(workspace)
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, transport], config: { ...preset.config, plugins: [
        ...(preset.config.plugins ?? []).map((entry) => entry.id === "models" ? { ...entry, options: { model: "opencode:fixture-controller", fastModel: "opencode:fixture-editor", inheritPrevious: false } } : entry.id === "telemetry" ? { ...entry, enabled: false } : entry),
        { id: "transport", use: transport.id },
      ] } })
      const session = yield* harness.create()
      yield* session.send("Change old to new in value.ts; inspect the applied file and do not run commands")
      const parent = yield* session.journalHistory
      expect(parent.filter((event) => event.kind === "tool.completed" && event.data.ok === false)).toHaveLength(1)
      expect(parent.filter((event) => event.kind === "smith.editor" && event.data.status === "started")).toHaveLength(1)
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("export const value = 'new'\n")
      const replay = JSON.stringify(yield* Ref.get(requests))
      expect(replay).toContain("SmithToolFailure")
      expect(replay).toContain("missing.ts")
      expect(replay).toContain("oldText must match exactly once")
      expect((yield* session.history).findLast((event) => event.name === "run.completed")?.data.text).toContain("No commands were run")
    })).pipe(Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })
})
