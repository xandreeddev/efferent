import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { definePlugin, SessionEnvironment } from "@xandreed/core"
import type { HarnessConfig } from "@xandreed/core"
import { resolveGraph } from "@xandreed/runtime"
import { smithAgent, smithCapabilitiesPlugin, SmithPlanningTransport } from "@xandreed/smith"
import { Harness } from "@xandreed/sdk"
import { ModelTransport } from "@xandreed/plugin-models"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { upgradeSmithConfig } from "./smith-config.adapter.js"

test("former Smith tools keep read-only intent and model settings without rewriting source config", () => {
  const source = { version: 1 as const, plugins: [
    { id: "loop", use: "@xandreed/smith/coding" },
    { id: "tools", use: "@xandreed/plugin-tools-local", options: { readOnly: true } },
    { id: "models", use: "@xandreed/plugin-models", options: { model: "opencode:configured" } },
  ] }
  const upgraded = upgradeSmithConfig(source)
  expect(upgraded.plugins?.find((entry) => entry.id === "loop")?.options?.readOnly).toBe(true)
  expect(upgraded.plugins?.find((entry) => entry.id === "tools")?.use).toBe("@xandreed/smith/capabilities")
  expect(upgraded.plugins?.find((entry) => entry.id === "tools")?.options).toEqual({})
  expect(upgraded.plugins?.find((entry) => entry.id === "models")?.options?.model).toBe("opencode:configured")
  expect(source.plugins[1]?.use).toBe("@xandreed/plugin-tools-local")
  const replacement = { version: 1 as const, plugins: [{ id: "loop", use: "custom/coding" }, source.plugins[1]!] }
  expect(upgradeSmithConfig(replacement)).toBe(replacement)
})

test("an explicit coding-loop mode takes precedence over the former tools setting", () => {
  const upgraded = upgradeSmithConfig({ version: 1, plugins: [
    { id: "loop", use: "@xandreed/smith/coding", options: { readOnly: false } },
    { id: "tools", use: "@xandreed/plugin-tools-local", options: { readOnly: true } },
  ] })
  expect(upgraded.plugins?.find((entry) => entry.id === "loop")?.options?.readOnly).toBe(false)
  expect(upgraded.plugins?.find((entry) => entry.id === "tools")?.options).toEqual({})
})

test("obsolete modern capability mode options fail before activation; only the loop owns read-only", async () => {
  const preset = smithAgent("/fixture")
  const config = { ...preset.config, plugins: preset.config.plugins?.map((entry) => entry.id === "tools" ? { ...entry, options: { readOnly: true } } : entry) }
  expect(upgradeSmithConfig(config)).toBe(config)
  const result = await Effect.runPromise(Effect.result(resolveGraph(config, preset.plugins, [SessionEnvironment.key])))
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "config.options", plugin: "tools", message: expect.stringContaining("readOnly") } })
  const direct = await Effect.runPromise(Effect.scoped(Effect.result(smithCapabilitiesPlugin.build({ readOnly: true }, Context.make(SessionEnvironment, { workspace: "/fixture" })))))
  expect(direct).toMatchObject({ _tag: "Failure", failure: { code: "plugin.activation", message: expect.stringContaining("readOnly") } })
})

test("legacy read-only migration denies native edit skills and loop mode alone restores staged editing", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "smith-config-readonly-"))
  mkdirSync(join(workspace, ".efferent/runtime"), { recursive: true })
  writeFileSync(join(workspace, ".efferent/runtime/auth.json"), JSON.stringify({ opencode: "fixture-key" }))
  writeFileSync(join(workspace, "value.ts"), "old")
  const Wire = Schema.Struct({ model: Schema.String, messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })), tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })) })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<typeof Wire.Type>>([])
    const calls = yield* Ref.make(new Map<string, number>())
    const fetchModel = (_url: RequestInfo | URL, init?: RequestInit) => Effect.runPromise(Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Wire))(String(init?.body))
      yield* Ref.update(requests, (all) => [...all, request])
      const role = request.model === "fixture-editor" ? "editor" : request.messages.findLast((message) => message.role === "user")?.content === "Update the value" ? "controller" : "readonly"
      const step = yield* Ref.modify(calls, (all) => [all.get(role) ?? 0, new Map([...all, [role, (all.get(role) ?? 0) + 1]])] as const)
      const proposal = request.messages.filter((message) => message.role === "tool").flatMap((message) => /^Proposal ([^\n]+)/.exec(String(message.content))?.[1] ?? []).at(-1) ?? "missing"
      const operation = role === "readonly"
        ? step === 0 ? { name: "load_skill", args: { skills: ["smith.controller", "smith.editor", "smith.verify"] } } : step === 1 ? { name: "read_file", args: { path: "value.ts" } } : undefined
        : role === "editor" ? step === 0 ? { name: "write_file", args: { path: "value.ts", content: "new" } } : { name: "submit_edits", args: { summary: "Changed the value" } }
          : step === 0 ? { name: "delegate_edit", args: { objective: "Replace old with new", paths: ["value.ts"] } } : step === 1 ? { name: "apply_edit_proposal", args: { proposalId: proposal } } : undefined
      const toolCalls = operation === undefined ? [] : [{ index: 0, id: `${role}-${step}`, type: "function", function: { name: operation.name, arguments: JSON.stringify(operation.args) } }]
      const chunk = { choices: [{ delta: { content: operation === undefined ? role === "readonly" ? "Inspected; no changes" : "Changed to new" : "", tool_calls: toolCalls }, finish_reason: operation === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    }))
    const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "Unexpected native provider" }, { status: 500 }))))
    const transport = definePlugin({ id: "test/smith-readonly-transport", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ModelTransport, SmithPlanningTransport], layer: () => Layer.merge(
      Layer.succeed(ModelTransport, { http, fetch: fetchModel, codex: Option.none() }),
      Layer.succeed(SmithPlanningTransport, { apiKey: Option.some(Redacted.make("fixture-planning-key")), fetch: async () => Response.json({ answers: { approach: { type: "choice", choice: "direct" } } }) }),
    ) })
    const preset = smithAgent(workspace)
    const source: HarnessConfig = { ...preset.config, plugins: [
      ...(preset.config.plugins ?? []).map((entry) => entry.id === "tools" ? { ...entry, use: "@xandreed/plugin-tools-local", options: { readOnly: true } }
        : entry.id === "models" ? { ...entry, options: { model: "opencode:fixture-controller", fastModel: "opencode:fixture-editor", inheritPrevious: false } }
          : entry.id === "telemetry" ? { ...entry, enabled: false } : entry),
      { id: "transport", use: transport.id },
    ] }
    const config = upgradeSmithConfig(source)
    const harness = yield* Harness.make({ workspace, config, plugins: [...preset.plugins, transport] })
    const session = yield* harness.create()
    yield* session.send("Inspect without edits")
    const readonly = yield* session.journalHistory
    expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("old")
    expect(readonly.filter((event) => event.kind === "smith.editor" || event.kind === "smith.receipt" || event.kind === "smith.check")).toHaveLength(0)
    expect(readonly.some((event) => event.kind === "tool.completed" && event.data.tool === "load_skill" && event.data.ok === false)).toBe(true)
    expect(JSON.stringify(yield* Ref.get(requests))).toContain("capability.forbidden")
    expect((yield* Ref.get(requests))[0]?.tools.map((tool) => tool.function.name)).not.toContain("delegate_edit")
    expect((yield* Ref.get(requests))[0]?.tools.map((tool) => tool.function.name)).not.toContain("verify")
    expect((yield* Ref.get(requests))[0]?.tools.map((tool) => tool.function.name)).not.toContain("write_file")
    const coding = { ...config, plugins: config.plugins?.map((entry) => entry.id === "loop" ? { ...entry, options: { ...entry.options, readOnly: false } } : entry) }
    expect(yield* harness.reconfigure(coding)).toBe("applied")
    yield* session.send("Update the value")
    expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("new")
    expect((yield* session.journalHistory).some((event) => event.kind === "smith.receipt" && event.data.status === "applied")).toBe(true)
    expect(source.plugins?.find((entry) => entry.id === "tools")?.options?.readOnly).toBe(true)
  })).pipe(Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
})
