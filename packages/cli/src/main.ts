#!/usr/bin/env bun
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { Effect, Layer, Logger, Option, Ref, Runtime, Schema, Stream } from "effect"
import { AgentLoop, AuthStore, ConversationId, DelegateLoop, Harness, HarnessError, ModelCatalog, parseModelSelection, ProviderId, SettingsStore } from "@xandreed/sdk"
import type { HarnessConfig, Plugin } from "@xandreed/sdk"
import { loadConfig, loadPlugins, mergeConfig, pluginSchema, redact, resolveGraph, writeConfig } from "@xandreed/runtime"
import { delegateLoopPlugin, smithAgent, smithWorkflowPlugin } from "@xandreed/smith"
import { spawnBounded } from "@xandreed/plugin-tools-local"
import { LocalAuthStoreLive } from "@xandreed/plugin-models"
import { makeApprovalChannel } from "@xandreed/tui/approval"
import type { TuiCommand, TuiState } from "@xandreed/tui"
import { loginCommand } from "./login.js"
import { managePlugin } from "./plugins.js"

export const USAGE = `efferent — an Effect-native agent harness

  efferent [task] [--cwd directory]       Open the coding workspace
  efferent -p "task" [--json]            Run without the terminal UI
  efferent init [--model provider:id]     Write a minimal workspace config
  efferent config validate|explain       Inspect the resolved composition
  efferent plugin add|remove|list|inspect Manage configurable plugins
  efferent doctor                       Check local runtime prerequisites

Options: --profile name · --model provider:id · --resume session-id
Linux + Bun. Configuration: efferent.config.json or efferent.config.ts.
`

export const parseArgs = (args: ReadonlyArray<string>) => {
  const parsed = args.reduce((state, argument) => {
    if (state.pending !== "") return { ...state, values: { ...state.values, [state.pending]: argument }, pending: "" }
    if (["--cwd", "--profile", "--model", "--resume", "--id"].includes(argument)) return { ...state, pending: argument }
    if (["-p", "--headless", "--json", "--help", "-h"].includes(argument)) return { ...state, flags: [...state.flags, argument] }
    if (argument.startsWith("--")) return { ...state, errors: [...state.errors, `Unknown option ${argument}`] }
    return { ...state, positional: [...state.positional, argument] }
  }, { pending: "", values: {} as Readonly<Record<string, string>>, flags: [] as ReadonlyArray<string>, positional: [] as ReadonlyArray<string>, errors: [] as ReadonlyArray<string> })
  return { ...parsed, errors: parsed.pending === "" ? parsed.errors : [...parsed.errors, `${parsed.pending} requires a value`] }
}

const bad = (message: string) => new HarnessError({ code: "cli.input", message })
const overridesAt = (workspace: string) => join(workspace, ".efferent/overrides.json")
const readOverrides = (workspace: string) => Effect.tryPromise({ try: () => readFile(overridesAt(workspace), "utf8"), catch: (error) => error }).pipe(
  Effect.catchAll((error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? Effect.succeed('{"version":1}') : Effect.fail(bad(String(error)))),
  Effect.flatMap((text) => Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(text)),
  Effect.flatMap((value) => importConfig(value)),
  Effect.mapError((error) => bad(String(error))),
)
const importConfig = (value: unknown) => Schema.decodeUnknown(HarnessConfigSchema)(value).pipe(Effect.mapError((error) => bad(String(error))))
import { HarnessConfig as HarnessConfigSchema } from "@xandreed/core"

export const runCli = (args: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function* () {
  const parsed = parseArgs(args)
  if (parsed.flags.includes("--help") || parsed.flags.includes("-h")) { console.log(USAGE); return }
  if (parsed.errors.length > 0) return yield* Effect.fail(bad(parsed.errors.join("\n")))
  const workspace = resolve(parsed.values["--cwd"] ?? process.cwd())
  const home = homedir()
  const approvals = yield* makeApprovalChannel
  const headless = parsed.flags.includes("-p") || parsed.flags.includes("--headless") || !process.stdout.isTTY
  const agent = smithAgent(workspace, headless ? () => Effect.succeed(false) : approvals.request)
  const invocation: HarnessConfig = parsed.values["--model"] === undefined ? { version: 1 } : { version: 1, plugins: [{ id: "models", use: "@xandreed/plugin-models", options: { model: parsed.values["--model"] } }] }
  const loaded = yield* loadConfig({ workspace, home, preset: agent.config, invocation,
    ...(parsed.values["--profile"] === undefined ? {} : { profile: parsed.values["--profile"] }) })
  const installedPlugins = yield* loadPlugins(loaded.config, [...agent.plugins.filter((plugin) => !loaded.plugins.some((custom) => custom.id === plugin.id)), ...loaded.plugins], workspace, home)
  const plugins = [...installedPlugins, ...installedPlugins.filter((plugin) => plugin.provides.includes(AgentLoop.key) && plugin.id !== smithWorkflowPlugin.id).map(delegateLoopPlugin).filter((plugin) => !installedPlugins.some((installed) => installed.id === plugin.id))]
  const [command, ...rest] = parsed.positional
  if (command === "init") {
    const path = join(workspace, "efferent.config.json")
    const exists = loaded.sources.some((source) => source.path === path || source.path === join(workspace, "efferent.config.ts"))
    if (exists) return yield* Effect.fail(bad("A workspace configuration already exists"))
    yield* writeConfig(path, { version: 1, profile: "smith", plugins: [{ id: "models", use: "@xandreed/plugin-models", options: { model: parsed.values["--model"] ?? "" } }] })
    console.log("Created efferent.config.json. Open efferent and use /login, follow /setup to connect a provider, choose a model, and configure plugins."); return
  }
  if (command === "plugin") { yield* managePlugin(rest, { workspace, home, config: loaded.config, plugins, ...(parsed.values["--id"] === undefined ? {} : { id: parsed.values["--id"] }) }); return }
  const graph = yield* resolveGraph(loaded.config, plugins, ["efferent/SessionEnvironment"])
  if (command === "config") {
    if (!["validate", "explain"].includes(rest[0] ?? "")) return yield* Effect.fail(bad("Use config validate or config explain"))
    console.log(rest[0] === "validate" ? `Valid: ${graph.nodes.length} plugins, profile ${loaded.config.profile}` : JSON.stringify(redact({ config: loaded.config, sources: loaded.sources, bindings: graph.providers, plugins: graph.nodes.map((node) => ({ id: node.entry.id, use: node.plugin.id, version: node.plugin.version, scope: node.plugin.scope })) }), null, 2)); return
  }
  if (command === "doctor") {
    const sandbox = yield* Effect.tryPromise({ try: async () => { const process = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "true"], { stdout: "ignore", stderr: "pipe" }); return await process.exited === 0 }, catch: () => false }).pipe(Effect.orElseSucceed(() => false))
    console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, config: "valid", sandbox: sandbox ? "ready" : "unavailable", model: graph.nodes.find((node) => node.entry.id === "models")?.options.model ?? "unset" }, null, 2))
    if (!sandbox) console.log("Install bubblewrap and enable user namespaces for sandboxed Bash. External commands require explicit approval.")
    return
  }
  const harness = yield* Harness.make({ workspace, config: loaded.config, plugins })
  const session = parsed.values["--resume"] === undefined ? yield* harness.create() : yield* harness.resume(ConversationId.make(parsed.values["--resume"]))
  const prompt = parsed.positional.join(" ")
  if (headless) {
    if (prompt.trim().length === 0) return yield* Effect.fail(bad("Provide a task with -p, or open efferent in a terminal"))
    const cursor = (yield* session.history).at(-1)?.seq ?? -1
    yield* session.send(prompt)
    if (parsed.flags.includes("--json")) {
      (yield* session.history).filter((event) => event.seq > cursor).forEach((event) => console.log(JSON.stringify(event)))
    } else {
      const result = (yield* session.history).filter((event) => event.name === "run.completed").at(-1)
      console.log(String(result?.data.text ?? ""))
    }
    return
  }
  const rt = yield* Effect.runtime<never>()
  const cliScope = yield* Effect.scope
  const configRef = yield* Ref.make<HarnessConfig>(loaded.config)
  const pluginsRef = yield* Ref.make<ReadonlyArray<Plugin>>(plugins)
  const launch = <A, E>(state: TuiState, effect: Effect.Effect<A, E>) => { Runtime.runFork(rt)(Effect.forkIn(effect.pipe(Effect.catchAllCause((cause) => Effect.sync(() => state.setNotice(String(cause))))), cliScope)) }
  const applyConfig = (state: TuiState, patch: HarnessConfig) => Effect.gen(function* () {
    const current = yield* Ref.get(configRef)
    const registry = yield* Ref.get(pluginsRef)
    const next = mergeConfig(current, patch)
    const installed = yield* loadPlugins(next, registry, workspace, home)
    const available = [...installed, ...installed.filter((plugin) => plugin.provides.includes(AgentLoop.key) && plugin.id !== smithWorkflowPlugin.id).map(delegateLoopPlugin).filter((plugin) => !installed.some((entry) => entry.id === plugin.id))]
    yield* resolveGraph(next, available, ["efferent/SessionEnvironment"])
    const status = yield* harness.reconfigure(next, available)
    yield* readOverrides(workspace).pipe(Effect.flatMap((old) => writeConfig(overridesAt(workspace), mergeConfig(old, patch))),
      Effect.onError(() => harness.reconfigure(current, registry).pipe(Effect.ignore)))
    yield* Ref.set(configRef, next)
    yield* Ref.set(pluginsRef, available)
    state.setOverlay({ kind: "none" }); state.setNotice(status === "restart-required" ? "Saved. Restart to apply runtime plugin changes." : "Saved. Active work keeps its current settings until the next turn.")
    return status
  })
  const save = (state: TuiState, id: string, key: string, value: unknown) => Effect.gen(function* () {
    if (id === "models" && ["model", "fastModel", "fallbackModel"].includes(key) && typeof value === "string" && value !== "" && Option.isNone(parseModelSelection(value))) return yield* Effect.fail(bad("Use provider:model, for example openai:gpt-4.1"))
    const current = yield* Ref.get(configRef)
    const entry = current.plugins?.find((entry) => entry.id === id)
    if (entry === undefined) return yield* Effect.fail(bad(`Unknown plugin instance ${id}`))
    const status = yield* applyConfig(state, { version: 1, plugins: [{ id, use: entry.use, options: { [key]: value } }] })
    if (status === "applied" && id === "models" && key === "model") state.setModel(String(value))
  })
  const replacePlugin = (state: TuiState, id: string, use: string) => Effect.gen(function* () {
    if (use.trim().length === 0) return yield* Effect.fail(bad("Enter an installed package name or a local plugin path."))
    const status = yield* applyConfig(state, { version: 1, plugins: [{ id, use: use.trim(), enabled: true }] })
    if (status === "applied" && id === "models") {
      const current = yield* harness.resume(state.session().id)
      const settingsAvailable = (yield* harness.graph).providers[SettingsStore.key] !== undefined
      state.setModel(settingsAvailable ? yield* current.use(SettingsStore, (settings) => settings.load.pipe(Effect.map((value) => Option.getOrElse(value.model, () => "")))) : "")
    }
  })
  const inspectPlugins = (state: TuiState): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const config = yield* Ref.get(configRef)
    const registry = yield* Ref.get(pluginsRef)
    const resolved = yield* resolveGraph(config, registry, ["efferent/SessionEnvironment"])
    state.setOverlay({ kind: "menu", title: "Plugins · configure or replace an instance", rows: resolved.nodes.map((node) => ({
      label: node.entry.id, detail: node.plugin.id,
      select: () => {
        const schema = pluginSchema(node.plugin)
        const fields = "properties" in schema ? Object.keys(schema.properties ?? {}) : []
        state.setOverlay({ kind: "menu", title: `${node.entry.id} · configuration`, rows: [
          ...fields.map((key) => ({
            label: key, detail: JSON.stringify(redact({ [key]: node.options[key] })),
            select: () => state.setOverlay({ kind: "edit", secret: /secret|password|token|api.?key|credential/i.test(key), title: `${node.entry.id}.${key} · ${typeof node.options[key] === "string" ? "text" : "JSON"}`, value: typeof node.options[key] === "string" ? String(node.options[key]) : JSON.stringify(node.options[key], null, 2),
              save: (text) => launch(state, (typeof node.options[key] === "string" ? Effect.succeed(text) : Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(text)).pipe(Effect.flatMap((value) => save(state, node.entry.id, key, value)))) }),
          })),
          { label: "Replace plugin…", detail: `Current: ${node.plugin.id}`, select: () => state.setOverlay({ kind: "menu", title: `Replace ${node.entry.id}`, rows: [
            ...registry.filter((plugin) => plugin.id !== node.plugin.id && node.plugin.provides.every((port) => plugin.provides.includes(port))).map((plugin) => ({ label: plugin.id, detail: `${plugin.scope} · ${plugin.version}`, select: () => launch(state, replacePlugin(state, node.entry.id, plugin.id)) })),
            { label: "Use another plugin…", detail: "Installed package or local path; validated before saving", select: () => state.setOverlay({ kind: "edit", title: `Replace ${node.entry.id} · package or path`, value: "", save: (use) => launch(state, replacePlugin(state, node.entry.id, use)) }) },
            { label: "Back", detail: "Keep the current plugin", select: () => launch(state, inspectPlugins(state)) },
          ] }) },
          { label: "About this plugin", detail: `${node.plugin.scope} · ${node.plugin.version}`, select: () => state.setOverlay({ kind: "text", title: node.plugin.id, text: `Provides\n${node.plugin.provides.join("\n")}\n\nRequires\n${node.plugin.requires.join("\n")}\n\nSettings save to .efferent/overrides.json. Session plugins apply on the next turn; runtime plugins require a restart.` }) },
          { label: "Back to plugins", detail: "", select: () => launch(state, inspectPlugins(state)) },
        ] })
      },
    })) })
  })
  const chooseModel = (state: TuiState) => Effect.gen(function* () {
    const current = yield* harness.resume(state.session().id)
    const entries = yield* current.use(ModelCatalog, (catalog) => catalog.list)
    state.setOverlay({ kind: "menu", title: "Choose a model", rows: [
      ...entries.map((entry) => ({ label: entry.selection, detail: entry.selection === state.model() ? "Selected" : entry.label ?? entry.credential,
        select: () => launch(state, save(state, "models", "model", entry.selection)) })),
      { label: "Enter a model ID…", detail: "Use any provider:model supported by your adapter", select: () => state.setOverlay({ kind: "edit", title: "Model · provider:model", value: state.model(), save: (value) => launch(state, save(state, "models", "model", value.trim())) }) },
      { label: "Connect a provider…", detail: entries.length === 0 ? "No connected providers. Sign in to see their models." : "API key or subscription", select: () => launch(state, loginCommand(workspace, home, launch).run("", state)) },
    ] })
  })
  const setup = (state: TuiState): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const current = yield* harness.resume(state.session().id)
    const catalog = (yield* harness.graph).providers[ModelCatalog.key] === undefined ? [] : yield* current.use(ModelCatalog, (catalog) => catalog.list)
    state.setOverlay({ kind: "menu", title: "Welcome to Efferent · setup", rows: [
      { label: "1. Connect a provider", detail: catalog.length > 0 ? "Models available · manage connections" : "API key or subscription login", select: () => launch(state, loginCommand(workspace, home, launch, () => chooseModel(state)).run("", state)) },
      { label: "2. Choose a model", detail: state.model() || "Required before your first query", select: () => launch(state, chooseModel(state)) },
      { label: "3. Configure or swap plugins", detail: "Agent loop, memory, tools, context, and more", select: () => launch(state, inspectPlugins(state)) },
      { label: "Start chatting", detail: state.model() ? "Ready · type /setup to return here" : "You can explore now and choose a model before sending", select: () => state.setOverlay({ kind: "none" }) },
    ] })
  })
  const workflow = (mode: "spec" | "lock" | "forge", argument: string, state: TuiState) => Effect.gen(function* () {
    const target = yield* harness.resume(state.session().id)
    if (yield* target.busy) return yield* Effect.fail(bad("Finish or interrupt the current turn before starting a workflow."))
    if (mode === "spec" && argument.trim().length === 0) return yield* Effect.fail(bad("Use /spec followed by the idea to refine."))
    const current = yield* Ref.get(configRef)
    const graph = yield* harness.graph
    const loop = current.plugins?.find((entry) => entry.id === graph.providers[AgentLoop.key])
    const tools = current.plugins?.find((entry) => entry.id === "tools")
    if (loop === undefined || tools === undefined) return yield* Effect.fail(bad("Smith workflows require loop and tools plugin instances."))
    const next = mergeConfig(current, { version: 1, bindings: { [AgentLoop.key]: "workflow", [DelegateLoop.key]: "worker" }, plugins: [
      { ...loop, enabled: false },
      { id: "worker", use: `${loop.use}/delegate`, enabled: true, ...(loop.options === undefined ? {} : { options: loop.options }) },
      { id: "workflow", use: smithWorkflowPlugin.id, enabled: true, options: { mode } },
      { ...tools, options: { ...tools.options, readOnly: mode !== "forge" } },
    ] })
    if ((yield* harness.reconfigure(next)) === "restart-required") return yield* Effect.fail(bad("This worker has runtime scope. Configure the workflow and restart before using it."))
    yield* target.send(argument || (mode === "lock" ? "Lock the current specification" : "Implement the locked specification")).pipe(
      Effect.ensuring(Ref.get(configRef).pipe(Effect.flatMap((config) => harness.reconfigure(config)), Effect.ignore)),
    )
  })
  const commands: ReadonlyArray<TuiCommand> = [
    { name: "setup", description: "Set up providers, models, and plugins", run: (_argument, state) => setup(state) },
    { name: "model", description: "Choose a model, or /model provider:model", run: (argument, state) => argument.length === 0 ? chooseModel(state) : save(state, "models", "model", argument) },
    loginCommand(workspace, home, launch),
    { name: "plugins", description: "Configure settings or replace a plugin", run: (_argument, state) => inspectPlugins(state) },
    { name: "plan", description: "Switch to read-only planning", run: (_argument, state) => save(state, "tools", "readOnly", true) },
    { name: "code", description: "Enable direct coding tools", run: (_argument, state) => save(state, "tools", "readOnly", false) },
    { name: "spec", description: "Draft a specification: /spec your idea", run: (argument, state) => workflow("spec", argument, state) },
    { name: "lock", description: "Approve and lock the current specification", run: (argument, state) => workflow("lock", argument, state) },
    { name: "forge", description: "Implement the locked spec under Foundry gates", run: (argument, state) => workflow("forge", argument, state) },
    { name: "context", description: "Inspect model context and compaction", run: (_argument, state) => harness.resume(state.session().id).pipe(Effect.flatMap((current) => current.history)).pipe(Effect.map((events) => state.setOverlay({ kind: "text", title: "Context", text: JSON.stringify(events.filter((event) => event.name.startsWith("context.")).slice(-5).map((event) => event.data), null, 2) }))) },
    { name: "tasks", description: "Inspect the task list", run: (_argument, state) => harness.resume(state.session().id).pipe(Effect.flatMap((current) => current.history)).pipe(Effect.map((events) => state.setOverlay({ kind: "text", title: "Tasks", text: JSON.stringify(events.filter((event) => event.name === "loop.event" && event.data.type === "tool_start" && event.data.toolName === "todo_write").at(-1)?.data.args ?? "No task list yet", null, 2) }))) },
    { name: "changes", description: "Review the workspace diff", run: (_argument, state) => spawnBounded(["git", "diff", "--no-ext-diff", "--stat", "--patch"], workspace, 10_000).pipe(Effect.mapError((error) => bad(error.message)), Effect.map((result) => state.setOverlay({ kind: "text", title: "Changes", text: result.stdout || result.stderr || "No tracked changes" }))) },
  ]
  const { runTui } = yield* Effect.promise(() => import("@xandreed/tui"))
  const hasModelSettings = graph.providers[SettingsStore.key] !== undefined
  const model = hasModelSettings ? yield* session.use(SettingsStore, (settings) => settings.load.pipe(Effect.map((value) => Option.getOrElse(value.model, () => "")))) : ""
  yield* runTui({ harness, session, approvals, commands, model, initialPrompt: prompt, onReady: (state) => hasModelSettings && model.length === 0 && prompt.length === 0 ? setup(state) : Effect.void, beforeSend: (text, state) => Effect.gen(function* () {
    if ((yield* harness.graph).providers[SettingsStore.key] === undefined || state.model().length > 0) return true
    state.restoreDraft(text)
    state.setNotice("Choose a model first. Your message is kept; press Enter after setup.")
    yield* chooseModel(state)
    return false
  }), eventRenderers: {
    "workflow.event": (event) => [{ id: event.id, kind: "notice", text: `Forge · ${String(event.data.type).replaceAll("_", " ")}`, detail: JSON.stringify(event.data, null, 2), status: event.data.type === "forge_error" ? "failed" : "complete" }],
    "spec.locked": (event) => [{ id: event.id, kind: "notice", text: "Specification locked", detail: String(event.data.text), status: "complete" }],
  } })
})).pipe(Effect.provide(process.stdout.isTTY ? Logger.remove(Logger.defaultLogger) : Layer.empty))

if (import.meta.main) {
  await Effect.runPromise(runCli(process.argv.slice(2)).pipe(Effect.catchAllCause((cause) => Effect.sync(() => { console.error(String(cause)); process.exitCode = 1 }))))
}
