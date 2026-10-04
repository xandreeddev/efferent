import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { AgentLoop, AgentTools, AuthStore, DelegateLoop, definePlugin, EngineSettings, SettingsStore, Shell, ShellResult, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { HarnessConfig } from "@xandreed/core"
import { approvalPlugin, Harness } from "@xandreed/sdk"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { smithAgent } from "./preset.js"
import { smithWorkflowPlugin, smithWorkerPlugin } from "./workflow.plugin.js"

describe("composable Smith workflows", () => {
  test("modern coding switches to a real legacy spec/lock/forge worker and restores its graph and journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smith-native-workflow-"))
    writeFileSync(join(directory, "source.txt"), "Inspect this workspace")
    const preset = smithAgent(directory, () => Effect.succeed(true))
    const settled = (text: string): ReadonlyArray<Response.PartEncoded> => [{ type: "text", text }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }]
    const call = (name: string, params: Record<string, unknown>): ReadonlyArray<Response.PartEncoded> => [{ type: "tool-call", id: crypto.randomUUID(), name, params, providerExecuted: false }, { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }]
    const models = definePlugin({
      id: "test/native-workflow-models", version: "1", config: Schema.Struct({}), defaults: {}, provides: [LanguageModel.LanguageModel, AuthStore, SettingsStore, Shell, UtilityLlm],
      layer: () => Layer.unwrap(Effect.gen(function* () {
        const model = yield* LanguageModel.make({ generateText: (options) => Effect.sync(() => {
          const system = options.prompt.content.filter((message) => message.role === "system").map((message) => message.content).join("\n")
          const results = options.prompt.content.flatMap((message) => message.role === "tool" ? message.content.filter((part) => part.type === "tool-result").map((part) => part.name) : [])
          if (system.includes("Draft a concrete implementation specification")) return [...(results.includes("read_file") ? settled("Write result.txt containing accepted. Verify with the acceptance check.") : call("read_file", { path: "source.txt" }))]
          if (system.includes("optional specification workflow's implementation worker")) return [...(results.includes("write_file") ? settled("Implemented with the workflow tools") : call("write_file", { path: "result.txt", content: "accepted" }))]
          return [...settled("Direct coding restored")]
        }), streamText: () => Stream.die("Fixture uses settled responses") })
        return Layer.mergeAll(
          Layer.succeed(LanguageModel.LanguageModel, model),
          Layer.succeed(AuthStore, { get: () => Effect.succeed(Option.none()), resolveKey: () => Effect.succeed(Option.none()), all: Effect.succeed(new Map()), set: () => Effect.void, remove: () => Effect.void }),
          Layer.succeed(SettingsStore, { load: Effect.succeed(new EngineSettings({})), set: () => Effect.void, setRole: () => Effect.void }),
          Layer.succeed(Shell, { exec: () => Effect.succeed(new ShellResult({ exitCode: 0, stdout: "", stderr: "" })) }),
          Layer.succeed(UtilityLlm, { complete: () => Effect.succeed(new UtilityCompletion({ text: "Workspace summary", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })) }),
        )
      })),
    })
    const original: HarnessConfig = { ...preset.config, bindings: { [Shell.key]: "models" }, plugins: preset.config.plugins?.map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) }
    const workflow = (mode: "spec" | "lock" | "forge"): HarnessConfig => ({ ...original, bindings: { ...original.bindings, [AgentLoop.key]: "workflow", [DelegateLoop.key]: "worker" }, plugins: [
      ...(original.plugins ?? []).map((entry) => entry.id === "loop" ? { ...entry, enabled: false } : entry.id === "worker" ? { ...entry, use: smithWorkerPlugin.id, enabled: true } : entry.id === "workflow" ? { ...entry, enabled: true, options: { mode, testCommand: "grep -qx accepted result.txt" } } : entry),
      { id: "legacy-memory", use: "@xandreed/plugin-memory", enabled: true },
      { id: "legacy-context", use: "@xandreed/plugin-context", enabled: true },
      { id: "legacy-tools", use: "@xandreed/plugin-tools-local", enabled: true, options: { readOnly: mode !== "forge" } },
    ] })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, plugins: [...preset.plugins, models], config: original })
      const session = yield* harness.create()
      yield* session.send("Inspect")
      const nativeBefore = yield* session.journalHistory
      expect(nativeBefore.some((event) => event.kind === "request.prepared")).toBe(true)
      expect(yield* harness.reconfigure(workflow("spec"))).toBe("applied")
      const specTools = yield* session.use(AgentTools, (tools) => Effect.succeed(Object.keys(tools.toolkit.tools)))
      expect(specTools).toContain("read_file")
      expect(specTools).not.toContain("write_file")
      expect(specTools).not.toContain("Bash")
      yield* session.send("Draft the result")
      expect(existsSync(join(directory, "result.txt"))).toBe(false)
      expect((yield* session.history).filter((event) => event.name === "spec.draft")).toHaveLength(1)
      expect(yield* harness.reconfigure(workflow("lock"))).toBe("applied")
      yield* session.send("Lock")
      expect((yield* session.history).filter((event) => event.name === "spec.locked")).toHaveLength(1)
      expect(yield* harness.reconfigure(workflow("forge"))).toBe("applied")
      expect(yield* session.use(AgentTools, (tools) => Effect.succeed(Object.keys(tools.toolkit.tools)))).toContain("write_file")
      yield* session.send("Forge")
      expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.text).toContain("Accepted by Foundry")
      expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe("accepted")
      expect(yield* harness.reconfigure(original)).toBe("applied")
      expect((yield* harness.graph).config).toEqual(original)
      yield* session.send("Inspect again")
      const nativeAfter = yield* session.journalHistory
      expect(nativeAfter.slice(0, nativeBefore.length)).toEqual([...nativeBefore])
      expect(nativeAfter.filter((event) => event.kind === "turn.started")).toHaveLength(5)
      expect(nativeAfter.filter((event) => event.kind === "request.prepared")).toHaveLength(2)
      expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.text).toBe("Direct coding restored")
    })).pipe(Effect.timeout("15 seconds"), Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })

  test("a configured worker repairs a gate failure and journals Foundry acceptance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-workflow-forge-"))
    const attempts: string[] = []
    const worker = definePlugin({ id: "test/repair-worker", version: "1", config: Schema.Struct({}), defaults: {}, provides: [DelegateLoop], layer: () => Layer.succeed(DelegateLoop, {
      run: (input) => Effect.sync(() => {
        if (input.system.includes("Draft a concrete implementation specification")) return { text: "Write result.txt containing accepted", outcome: "completed" as const }
        attempts.push(input.userMessage.text)
        writeFileSync(join(directory, "result.txt"), attempts.length === 1 ? "rejected" : "accepted")
        return { text: "Implemented", outcome: "completed" as const }
      }),
    }) })
    const config = (mode: "spec" | "lock" | "forge"): HarnessConfig => ({ version: 1, plugins: [
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(directory, ".efferent/runtime/sessions.db") } },
      { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
      { id: "approval", use: "efferent/approval-host" }, { id: "worker", use: worker.id },
      { id: "workflow", use: smithWorkflowPlugin.id, options: { mode, testCommand: "grep -qx accepted result.txt" } },
    ] })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config("spec"), plugins: [sessionSqlitePlugin, sessionsPlugin, approvalPlugin(() => Effect.succeed(true)), worker, smithWorkflowPlugin] })
      const session = yield* harness.create()
      yield* session.send("make the result")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock")
      yield* harness.reconfigure(config("forge"))
      yield* session.send("forge")
      const history = yield* session.history
      const completion = history.filter((event) => event.name === "run.completed").at(-1)
      const report = history.find((event) => event.name === "workflow.event" && event.data.type === "forge_end")
      expect(completion?.data.text).toContain("Accepted by Foundry")
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toContain("test/test-cmd")
      expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe("accepted")
      expect(typeof report?.data.artifact === "string" && existsSync(report.data.artifact)).toBe(true)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })

  test("drafts and locks persist; stale or unapproved specs cannot start implementation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "efferent-workflow-"))
    const calls: string[] = []
    const worker = definePlugin({ id: "test/worker", version: "1", config: Schema.Struct({}), defaults: {}, provides: [DelegateLoop], layer: () => Layer.succeed(DelegateLoop, {
      run: (input) => Effect.sync(() => { calls.push(input.userMessage.text); return { text: `Specification for ${input.userMessage.text}`, outcome: "completed" as const } }),
    }) })
    const config = (mode: "spec" | "lock" | "forge"): HarnessConfig => ({ version: 1, plugins: [
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } },
      { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
      { id: "approval", use: "efferent/approval-host" }, { id: "worker", use: worker.id },
      { id: "workflow", use: smithWorkflowPlugin.id, options: { mode } },
    ] })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config("spec"), plugins: [sessionSqlitePlugin, sessionsPlugin, approvalPlugin(), worker, smithWorkflowPlugin] })
      const session = yield* harness.create()
      yield* session.send("a tested feature")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock")
      expect((yield* session.history).filter((event) => event.name === "spec.locked")).toHaveLength(1)
      yield* harness.reconfigure(config("spec"))
      yield* session.send("a revised feature")
      yield* harness.reconfigure(config("forge"))
      expect((yield* Effect.result(session.send("forge")))._tag).toBe("Failure")
      yield* harness.reconfigure(config("lock"))
      yield* session.send("lock revision")
      yield* harness.reconfigure(config("forge"))
      expect((yield* Effect.result(session.send("forge")))._tag).toBe("Failure")
      expect(calls).toEqual(["a tested feature", "a revised feature"])
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))))
  })
})
