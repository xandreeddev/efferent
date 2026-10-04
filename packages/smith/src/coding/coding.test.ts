import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { AuthStore, definePlugin, EngineSettings, FileSystem, FsError, SettingsStore, Shell, ShellResult } from "@xandreed/core"
import type { HarnessConfig } from "@xandreed/core"
import { Harness } from "@xandreed/sdk"
import { LocalFileSystemLive } from "@xandreed/plugin-tools-local"
import { smithAgent } from "../preset.js"
import { SmithPlanning } from "./planning.port.js"
import { makeWorkspace } from "./workspace.adapter.js"
import { WorkOrder, WorkOrderId } from "./edit.entity.js"

const parts = (name: string, params: Record<string, unknown>): ReadonlyArray<Response.PartEncoded> => [{ type: "tool-call", id: crypto.randomUUID(), name, params, providerExecuted: false }, { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }]
const final = (text: string): ReadonlyArray<Response.PartEncoded> => [{ type: "text", text }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }]

const fixtureModels = (workspace: string, readOnly = false, pauseEditor: Option.Option<Deferred.Deferred<void>> = Option.none(), failCheap = false, parallelOrders = false, inputTokens = 10) => definePlugin({
  id: "test/smith-models", version: "1", config: Schema.Struct({}), defaults: {}, provides: [LanguageModel.LanguageModel, AuthStore, SettingsStore, Shell, SmithPlanning],
  layer: () => Layer.unwrap(Effect.gen(function* () {
    const controllerCalls = yield* Ref.make(0)
    const editorCalls = yield* Ref.make(0)
    const generate = (prompt: import("effect/ai").Prompt.Prompt) => Effect.gen(function* () {
      const isEditor = prompt.content.some((message) => message.role === "system" && message.content.startsWith("You are Smith's focused editor."))
      const index = yield* Ref.getAndUpdate(isEditor ? editorCalls : controllerCalls, (value) => value + 1)
      if (readOnly) return final("Inspected; no changes")
      if (isEditor && Option.isSome(pauseEditor)) {
        if (index === 0) return parts("write_file", { path: "value.ts", content: "cancelled staged edit" })
        return yield* Deferred.succeed(pauseEditor.value, undefined).pipe(Effect.andThen(Effect.never))
      }
      if (isEditor && failCheap) return index < 2 ? final("No proposal") : [
        { type: "tool-call", id: crypto.randomUUID(), name: "write_file", params: { path: "value.ts", content: "new" }, providerExecuted: false },
        { type: "tool-call", id: crypto.randomUUID(), name: "submit_edits", params: { summary: "Escalated correction" }, providerExecuted: false },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
      ] satisfies ReadonlyArray<Response.PartEncoded>
      if (isEditor && parallelOrders) return [
        { type: "tool-call", id: crypto.randomUUID(), name: "write_file", params: { path: "value.ts", content: "new" }, providerExecuted: false },
        { type: "tool-call", id: crypto.randomUUID(), name: "submit_edits", params: { summary: "Submitted concurrent work order" }, providerExecuted: false },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
      ] satisfies ReadonlyArray<Response.PartEncoded>
      if (isEditor) return [parts("read_file", { path: "value.ts" }), parts("edit_file", { path: "value.ts", oldText: "old", newText: "new" }), parts("submit_edits", { summary: "Updated the value" })][index] ?? final("Submitted")
      if (index === 0 && parallelOrders) return [
        { type: "tool-call", id: crypto.randomUUID(), name: "delegate_edit", params: { objective: "Replace old with new", paths: ["value.ts"] }, providerExecuted: false },
        ...parts("delegate_edit", { objective: "Replace old with new again", paths: ["value.ts"] }),
      ] satisfies ReadonlyArray<Response.PartEncoded>
      if (index === 0) return parts("delegate_edit", { objective: "Replace old with new", paths: ["value.ts"] })
      if (index === 1) {
        const output = prompt.content.flatMap((message) => message.role === "tool" ? message.content.filter((part) => part.type === "tool-result" && part.name === "delegate_edit") : []).at(-1)
        const id = output !== undefined && output.type === "tool-result" && typeof output.result === "string" ? /^Proposal ([^\n]+)/.exec(output.result)?.[1] ?? "missing" : "missing"
        return parts("apply_edit_proposal", { proposalId: id })
      }
      if (index === 2) return parts("verify", { command: "test value" })
      return final("Updated and verified")
    })
    const model = yield* LanguageModel.make({ generateText: (options) => generate(options.prompt).pipe(Effect.map((value) => value.map((part) => part.type === "finish" ? { ...part, usage: { ...part.usage, inputTokens: { total: inputTokens } } } : part))), streamText: () => Stream.die("Fixture uses settled responses") })
    return Layer.mergeAll(
      Layer.succeed(LanguageModel.LanguageModel, model),
      Layer.succeed(AuthStore, { get: () => Effect.succeed(Option.none()), resolveKey: () => Effect.succeed(Option.none()), all: Effect.succeed(new Map()), set: () => Effect.void, remove: () => Effect.void }),
      Layer.succeed(SettingsStore, { load: Effect.succeed(new EngineSettings({})), set: () => Effect.void, setRole: () => Effect.void }),
      Layer.succeed(Shell, { exec: (command) => Effect.succeed(new ShellResult({ exitCode: readFileSync(join(workspace, "value.ts"), "utf8").includes("new") ? 0 : 1, stdout: command, stderr: "" })) }),
      Layer.succeed(SmithPlanning, { decide: () => Effect.succeed({ mode: "direct", reason: "Scripted Jev decision" }) }),
    )
  })),
})

describe("Smith production coding plugin", () => {
  test("controller delegates staged edits, applies and verifies, with one parent turn and a persisted child", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-coding-"))
    writeFileSync(join(workspace, "value.ts"), "export const value = 'old'\n")
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) } })
      const session = yield* harness.create()
      yield* session.send("Update the value")
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toContain("new")
      const history = yield* session.journalHistory
      expect(history.filter((event) => event.kind === "turn.started")).toHaveLength(1)
      expect(history.filter((event) => event.kind === "turn.ended")).toHaveLength(1)
      expect(history.filter((event) => event.kind === "turn.reply")).toHaveLength(1)
      expect(history.some((event) => event.kind === "smith.proposal")).toBe(true)
      expect(history.some((event) => event.kind === "smith.editor")).toBe(true)
      expect(history.some((event) => event.kind === "smith.check" && event.data.exitCode === 0)).toBe(true)
      expect(history.some((event) => event.kind === "smith.receipt")).toBe(true)
      expect(history.some((event) => event.kind === "request.prepared")).toBe(true)
      const completed = (yield* session.history).filter((event) => event.name === "run.completed").at(-1)
      expect(completed?.data.text).toBe("Updated and verified")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("cancellation during a staged editor interrupts its child and leaves source unchanged", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-cancel-"))
    writeFileSync(join(workspace, "value.ts"), "old")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reached = yield* Deferred.make<void>()
      const preset = smithAgent(workspace)
      const models = fixtureModels(workspace, false, Option.some(reached))
      const config = { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) }
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config })
      const session = yield* harness.create()
      const running = yield* Effect.forkScoped(session.send("Update"))
      yield* Deferred.await(reached)
      yield* session.interrupt
      yield* Fiber.join(running)
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("old")
      expect((yield* session.history).some((event) => event.name === "run.cancelled")).toBe(true)
    })).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("the shared model budget stops delegation without applying source changes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-budget-"))
    writeFileSync(join(workspace, "value.ts"), "old")
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry.id === "loop" ? { ...entry, options: { maxModelRequests: 1 } } : entry) } })
      const session = yield* harness.create()
      yield* session.send("Update")
      expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.outcome).toBe("partial")
      expect((yield* session.journalHistory).filter((event) => event.kind === "request.prepared")).toHaveLength(1)
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("old")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("two incomplete cheap attempts escalate once to the controller within the shared budget", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-escalate-"))
    writeFileSync(join(workspace, "value.ts"), "old")
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, false, Option.none(), true)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry.id === "loop" ? { ...entry, options: { editorMaxSteps: 1 } } : entry) } })
      const session = yield* harness.create()
      yield* session.send("Update")
      const attempts = (yield* session.journalHistory).filter((event) => event.kind === "smith.editor" && event.data.status === "started")
      expect(attempts.map((event) => event.data.role)).toEqual(["editor", "editor", "controller"])
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("new")
      expect((yield* session.journalHistory).find((event) => event.kind === "smith.budget")?.data.requests).toBe(7)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("parallel work orders serialize editor requests and include both child usages in the shared budget", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-parallel-"))
    writeFileSync(join(workspace, "value.ts"), "old")
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, false, Option.none(), false, true)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) } })
      const session = yield* harness.create()
      yield* session.send("Update with two work orders")
      const history = yield* session.journalHistory
      expect(history.filter((event) => event.kind === "smith.editor").map((event) => event.data.status)).toEqual(["started", "completed", "started", "completed"])
      expect(history.find((event) => event.kind === "smith.budget")?.data).toMatchObject({ requests: 6, requestUnit: "model-step", usedTokens: 72 })
      expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("new")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test.each([
    { name: "the larger default", options: {}, completes: true },
    { name: "an explicit 64000-token cap", options: { budgetTokens: 64_000 }, completes: false },
  ])("controller/editor cumulative usage respects $name", async ({ options, completes }) => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-cumulative-tokens-"))
    writeFileSync(join(workspace, "value.ts"), "old")
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, false, Option.none(), false, false, 16_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry.id === "loop" ? { ...entry, options } : entry) } })
      const session = yield* harness.create()
      const result = yield* Effect.result(session.send("Update the value"))
      const history = yield* session.journalHistory
      expect(history.find((event) => event.kind === "smith.context")?.data.contextTokens).toBe(64_000)
      if (completes) {
        expect(result._tag).toBe("Success")
        expect(history.find((event) => event.kind === "smith.budget")?.data).toMatchObject({ requests: 7, usedTokens: 112_014, limitTokens: 256_000 })
        expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.outcome).toBe("completed")
        expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("new")
      } else {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.message).toContain("The shared 64000-token budget cannot admit this request")
        expect(history.filter((event) => event.kind === "request.prepared")).toHaveLength(1)
        expect(history.filter((event) => event.kind === "smith.proposal")).toHaveLength(1)
        expect(history.filter((event) => event.kind === "smith.receipt")).toHaveLength(0)
        expect(readFileSync(join(workspace, "value.ts"), "utf8")).toBe("old")
      }
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("the larger shared budget keeps the per-request context window bounded before dispatch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-context-limit-"))
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, true)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) } })
      const session = yield* harness.create()
      const result = yield* Effect.result(session.send("Inspect ".repeat(40_000)))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message).toContain("The current turn alone exceeds the 64000-token context budget")
      expect((yield* session.journalHistory).filter((event) => event.kind === "request.prepared")).toHaveLength(0)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("a token budget too small for the request fails before provider dispatch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-token-limit-"))
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, true)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config: { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry.id === "loop" ? { ...entry, options: { budgetTokens: 1000, maxOutputTokens: 256 } } : entry) } })
      const session = yield* harness.create()
      expect((yield* Effect.result(session.send("Inspect")))._tag).toBe("Failure")
      expect((yield* session.journalHistory).filter((event) => event.kind === "request.prepared")).toHaveLength(0)
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("selected Effect modules are versioned prompt sections and change on the next turn", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-modules-"))
    const preset = smithAgent(workspace)
    const models = fixtureModels(workspace, true)
    const config = { ...preset.config, bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" }, plugins: preset.config.plugins?.filter((entry) => entry.id !== "planning").map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry) }
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config })
      const session = yield* harness.create()
      yield* session.send("Inspect")
      expect(JSON.stringify((yield* session.journalHistory).filter((event) => event.kind === "memory.system"))).not.toContain("smith.effect.schema")
      yield* harness.reconfigure({ ...config, plugins: config.plugins?.map((entry) => entry.id === "loop" ? { ...entry, options: { readOnly: true, modules: ["schema", "concurrency"] } } : entry) })
      yield* session.send("Inspect again")
      const prompts = JSON.stringify((yield* session.journalHistory).filter((event) => event.kind === "memory.system"))
      expect(prompts).toContain("smith.effect.schema")
      expect(prompts).toContain("smith.effect.concurrency")
      expect(prompts).not.toContain("smith.effect.services")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("a read-only profile returns to coding on the next turn while preserving the user's system", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-plan-"))
    const preset = smithAgent(workspace)
    const presetConfig: HarnessConfig = preset.config
    const userSystem = `${preset.config.system}\nWorkspace convention: use concise status messages.`
    const models = fixtureModels(workspace, true)
    const config: HarnessConfig = { ...preset.config, profile: "plan", system: presetConfig.profiles?.plan?.system ?? userSystem, plugins: preset.config.plugins?.map((entry) => entry.id === "models" ? { id: "models", use: models.id } : entry.id === "loop" ? { ...entry, options: { readOnly: true } } : entry), bindings: { "@xandreed/core/Shell": "models", "smith/Planning": "models" } }
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace, plugins: [...preset.plugins, models], config })
      const session = yield* harness.create()
      yield* session.send("Inspect this workspace")
      const prepared = (yield* session.journalHistory).find((event) => event.kind === "request.prepared")
      const text = JSON.stringify(prepared?.data)
      expect(text).toContain("read_file")
      expect(text).not.toContain("delegate_edit")
      expect(text).not.toContain("apply_edit_proposal")
      expect(text).not.toContain('"name":"verify"')
      yield* harness.reconfigure({ ...config, plugins: config.plugins?.map((entry) => entry.id === "loop" ? { ...entry, options: { readOnly: false } } : entry) })
      yield* session.send("Return to coding")
      const coding = (yield* session.journalHistory).filter((event) => event.kind === "request.prepared").at(-1)
      const codingText = JSON.stringify(coding?.data)
      expect(codingText).toContain("delegate_edit")
      expect(codingText).toContain("apply_edit_proposal")
      expect(codingText).toContain('"name":"verify"')
      expect(codingText).toContain("Workspace convention: use concise status messages.")
      expect(codingText).not.toContain("Source mutation and shell tools are unavailable")
      expect(codingText).not.toContain("Read-only planning: inspect and propose")
    })).pipe(Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })
})

describe("staged workspace protection", () => {
  test("search prunes ignored infrastructure before descent and skips unreadable directories", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-search-pruning-"))
    writeFileSync(join(workspace, ".gitignore"), "pg-data/\n")
    writeFileSync(join(workspace, "visible.txt"), "needle in source")
    mkdirSync(join(workspace, "nested"))
    writeFileSync(join(workspace, "nested", ".ignore"), "generated/\n")
    writeFileSync(join(workspace, "nested", "source.txt"), "needle in nested source")
    ;["pg-data", "node_modules", ".git", ".efferent", ".foundry", "unreadable", "nested/generated"].forEach((path) => mkdirSync(join(workspace, path), { recursive: true }))
    await Effect.runPromise(Effect.gen(function* () {
      const local = yield* FileSystem
      const listed = yield* Ref.make<ReadonlyArray<string>>([])
      const io = yield* makeWorkspace(workspace).pipe(Effect.provideService(FileSystem, { ...local, list: (path) => Ref.update(listed, (all) => [...all, path]).pipe(Effect.andThen(path.endsWith("unreadable") || path.endsWith("pg-data") ? Effect.fail(new FsError({ path, message: "EACCES: permission denied" })) : local.list(path))) }))
      expect(yield* io.files.grep("needle")).toContain("visible.txt:1:needle in source")
      expect(yield* io.files.glob("nested/**/*.txt")).toEqual(["nested/source.txt"])
      const directories = (yield* Ref.get(listed)).map((path) => path.slice(workspace.length + 1))
      expect(directories).toContain("unreadable")
      expect(directories).not.toContain("pg-data")
      expect(directories).not.toContain("node_modules")
      expect(directories).not.toContain(".git")
      expect(directories).not.toContain(".efferent")
      expect(directories).not.toContain(".foundry")
      expect(directories).not.toContain("nested/generated")
    }).pipe(Effect.provide(LocalFileSystemLive), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("concurrent staged writes are retained and separate workspace handles cannot apply stale proposals together", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-workspace-lock-"))
    writeFileSync(join(workspace, "a.txt"), "original")
    writeFileSync(join(workspace, "b.txt"), "original")
    await Effect.runPromise(Effect.gen(function* () {
      const localFs = yield* FileSystem
      const io = yield* makeWorkspace(workspace).pipe(Effect.provideService(FileSystem, { ...localFs, read: (path) => Effect.yieldNow.pipe(Effect.andThen(localFs.read(path))) }))
      const other = yield* makeWorkspace(workspace)
      const overlay = yield* io.overlay(new WorkOrder({ id: WorkOrderId.make("parallel"), objective: "Update", paths: ["."] }))
      yield* Effect.forEach(["a.txt", "b.txt"], (path) => overlay.editor.write(path, "first"), { concurrency: 4 })
      const proposal = yield* overlay.editor.submit("Both files")
      expect(proposal.changes.map((change) => change.path)).toEqual(["a.txt", "b.txt"])
      const rival = yield* other.overlay(new WorkOrder({ id: WorkOrderId.make("rival"), objective: "Update", paths: ["."] }))
      yield* rival.editor.write("a.txt", "second")
      const rivalProposal = yield* rival.editor.submit("Concurrent edit")
      const outcomes = yield* Effect.forEach([io.apply(proposal), other.apply(rivalProposal)], Effect.result, { concurrency: 2 })
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1)
      expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("first")
      expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("first")
    }).pipe(Effect.provide(LocalFileSystemLive), Effect.ensuring(Effect.sync(() => rmSync(workspace, { recursive: true, force: true })))))
  })

  test("staging is isolated, stale originals and symlink escapes fail before any write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "smith-overlay-"))
    const outside = mkdtempSync(join(tmpdir(), "smith-outside-"))
    writeFileSync(join(workspace, "a.txt"), "original")
    symlinkSync(outside, join(workspace, "escape"))
    await Effect.runPromise(Effect.gen(function* () {
      const io = yield* makeWorkspace(workspace)
      const overlay = yield* io.overlay(new WorkOrder({ id: WorkOrderId.make("fixture"), objective: "Update", paths: ["."] }))
      yield* overlay.editor.write("a.txt", "staged")
      expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("original")
      expect((yield* Effect.result(overlay.editor.write("escape/secret.txt", "bad")))._tag).toBe("Failure")
      expect((yield* Effect.result(overlay.editor.write(".git/config", "bad")))._tag).toBe("Failure")
      expect((yield* Effect.result(overlay.editor.write("foundry.config.ts", "bad")))._tag).toBe("Failure")
      const proposal = yield* overlay.editor.submit("Updated")
      writeFileSync(join(workspace, "a.txt"), "user change")
      expect((yield* Effect.result(io.apply(proposal)))._tag).toBe("Failure")
      expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("user change")
    }).pipe(Effect.provide(LocalFileSystemLive), Effect.ensuring(Effect.sync(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }))))
  })
})
