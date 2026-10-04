#!/usr/bin/env bun
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { Effect, Layer, Logger, Option, Ref, Schema, Stream } from "effect"
import { AgentLoop, AuthStore, ConversationId, DelegateLoop, EngineSettings, Harness, HarnessError, ModelCatalog, parseModelSelection, ProviderId, SessionLogEvent, SettingsStore } from "@xandreed/sdk"
import type { HarnessConfig, ModelCatalogEntry, Plugin } from "@xandreed/sdk"
import { loadConfig, loadPlugins, mergeConfig, pluginSchema, redact, resolveGraph, writeConfig } from "@xandreed/runtime"
import { delegateLoopPlugin, SMITH_EFFECT_MODULE_IDS, smithAgent, smithWorkflowPlugin, smithWorkerPlugin } from "@xandreed/smith"
import { LocalAuthStoreLive } from "@xandreed/plugin-models"
import { makeApprovalChannel } from "@xandreed/tui/approval"
import type { TuiCommand, TuiState } from "@xandreed/tui"
import { loginCommand } from "./login.js"
import { managePlugin } from "./plugins.js"
import { journalRows, smithJournalRenderers } from "./smith-presentation.adapter.js"
import { upgradeSmithConfig } from "./smith-config.adapter.js"
import { workspaceChanges } from "./git-changes.adapter.js"

const modelRoles = (settings: EngineSettings, options: Readonly<Record<string, unknown>>) => {
  const main = Option.getOrElse(settings.model, () => "")
  const driver = String(options.driverModel || main)
  return { main, driver, editor: String(options.editorModel || Option.getOrElse(settings.fastModel, () => driver)) }
}

export const USAGE = `efferent — an Effect-native agent harness

  efferent [task] [--cwd directory]       Open the coding workspace
  efferent -p "task" [--json]            Run without the terminal UI
  efferent init [--model provider:id]     Write a minimal workspace config
  efferent config validate|explain       Inspect the resolved composition
  efferent plugin add|remove|list|inspect Manage configurable plugins
  efferent doctor                       Check local runtime prerequisites

Options: --profile smith|effect|plan · --model provider:id · --resume session-id
         --driver-model provider:id · --editor-model provider:id
         --journal-json emits the native session log in headless mode
Linux + Bun. Configuration: efferent.config.json or efferent.config.ts.
`

export const parseArgs = (args: ReadonlyArray<string>) => {
  const parsed = args.reduce((state, argument) => {
    if (state.pending !== "") return { ...state, values: { ...state.values, [state.pending]: argument }, pending: "" }
    if (["--cwd", "--profile", "--model", "--driver-model", "--editor-model", "--resume", "--id"].includes(argument)) return { ...state, pending: argument }
    if (["-p", "--headless", "--json", "--journal-json", "--help", "-h"].includes(argument)) return { ...state, flags: [...state.flags, argument] }
    if (argument.startsWith("--")) return { ...state, errors: [...state.errors, `Unknown option ${argument}`] }
    return { ...state, positional: [...state.positional, argument] }
  }, { pending: "", values: {} as Readonly<Record<string, string>>, flags: [] as ReadonlyArray<string>, positional: [] as ReadonlyArray<string>, errors: [] as ReadonlyArray<string> })
  return { ...parsed, errors: parsed.pending === "" ? parsed.errors : [...parsed.errors, `${parsed.pending} requires a value`] }
}

const bad = (message: string) => new HarnessError({ code: "cli.input", message })
const overridesAt = (workspace: string) => join(workspace, ".efferent/overrides.json")
const readOverrides = (workspace: string) => Effect.tryPromise({ try: () => readFile(overridesAt(workspace), "utf8"), catch: (error) => error }).pipe(
  Effect.catch((error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? Effect.succeed('{"version":1}') : Effect.fail(bad(String(error)))),
  Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)),
  Effect.flatMap((value) => importConfig(value)),
  Effect.mapError((error) => bad(String(error))),
)
const importConfig = (value: unknown) => Schema.decodeUnknownEffect(HarnessConfigSchema)(value, { reportInput: true }).pipe(Effect.mapError((error) => bad(String(error))))
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
  const invocation: HarnessConfig = { version: 1, plugins: [
    ...(parsed.values["--model"] === undefined ? [] : [{ id: "models", use: "@xandreed/plugin-models", options: { model: parsed.values["--model"] } }]),
    ...(["--driver-model", "--editor-model"].some((key) => parsed.values[key] !== undefined) ? [{ id: "loop", use: "@xandreed/smith/coding", options: {
      ...(parsed.values["--driver-model"] === undefined ? {} : { driverModel: parsed.values["--driver-model"] }),
      ...(parsed.values["--editor-model"] === undefined ? {} : { editorModel: parsed.values["--editor-model"] }),
    } }] : []),
  ] }
  const sources = yield* loadConfig({ workspace, home, preset: agent.config, invocation,
    ...(parsed.values["--profile"] === undefined ? {} : { profile: parsed.values["--profile"] }) })
  const loaded = { ...sources, config: upgradeSmithConfig(sources.config) }
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
    const journalCursor = (yield* session.journalHistory).filter((event) => event.session === session.record.id).at(-1)?.seq ?? 0
    yield* session.send(prompt)
    if (parsed.flags.includes("--journal-json")) {
      const events = (yield* session.journalHistory).filter((event) => event.session === session.record.id && event.seq > journalCursor)
      const encoded = yield* Schema.encodeEffect(Schema.Array(SessionLogEvent))(events)
      encoded.forEach((event) => console.log(JSON.stringify(event)))
    } else if (parsed.flags.includes("--json")) {
      (yield* session.history).filter((event) => event.seq > cursor).forEach((event) => console.log(JSON.stringify(event)))
    } else {
      const result = (yield* session.history).filter((event) => event.name === "run.completed").at(-1)
      console.log(String(result?.data.text ?? ""))
    }
    return
  }
  const rt = yield* Effect.context<never>()
  const cliScope = yield* Effect.scope
  const configRef = yield* Ref.make<HarnessConfig>(loaded.config)
  const pluginsRef = yield* Ref.make<ReadonlyArray<Plugin>>(plugins)
  const [initialSettings, initialEntries] = yield* Effect.all([
    graph.providers[SettingsStore.key] === undefined ? Effect.succeed(new EngineSettings({})) : session.use(SettingsStore, (store) => store.load).pipe(Effect.mapError((error) => bad(error.message))),
    graph.providers[ModelCatalog.key] === undefined ? Effect.succeed<ReadonlyArray<ModelCatalogEntry>>([]) : session.use(ModelCatalog, (catalog) => catalog.list),
  ], { concurrency: 2 })
  const cachedChoices = yield* Ref.make({ settings: initialSettings, entries: initialEntries })
  /** Read-only service snapshots are bounded; an active turn never holds a menu hostage. */
  const modelChoices = (state: TuiState) => Effect.gen(function* () {
    const handle = yield* harness.resume(state.session().id)
    const active = yield* handle.busy
    const graph = yield* harness.graph
    const cached = yield* Ref.get(cachedChoices)
    const refreshed = active ? Option.none<typeof cached>() : yield* Effect.all([
      graph.providers[SettingsStore.key] === undefined ? Effect.succeed(new EngineSettings({})) : handle.use(SettingsStore, (store) => store.load),
      graph.providers[ModelCatalog.key] === undefined ? Effect.succeed<ReadonlyArray<ModelCatalogEntry>>([]) : handle.use(ModelCatalog, (catalog) => catalog.list),
    ], { concurrency: 2 }).pipe(Effect.map(([settings, entries]) => ({ settings, entries })), Effect.timeoutOption("150 millis"), Effect.orElseSucceed(() => Option.none<typeof cached>()))
    if (Option.isSome(refreshed)) yield* Ref.set(cachedChoices, refreshed.value)
    const snapshot = Option.getOrElse(refreshed, () => cached)
    const options = graph.nodes.find((node) => node.entry.id === "models")?.options ?? {}
    const settings = new EngineSettings({ ...snapshot.settings,
      model: typeof options.model === "string" && options.model.length > 0 ? Option.some(options.model) : snapshot.settings.model,
      fastModel: typeof options.fastModel === "string" && options.fastModel.length > 0 ? Option.some(options.fastModel) : snapshot.settings.fastModel,
    })
    return { settings, entries: snapshot.entries, active, graph }
  })
  const launch = <A, E>(state: TuiState, effect: Effect.Effect<A, E>) => { Effect.runForkWith(rt)(Effect.forkIn(effect.pipe(Effect.catchCause((cause) => Effect.sync(() => state.setNotice(String(cause))))), cliScope)) }
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
    if (["model", "fastModel", "fallbackModel", "driverModel", "editorModel"].includes(key) && typeof value === "string" && value !== "" && Option.isNone(parseModelSelection(value))) return yield* Effect.fail(bad("Use provider:model, for example openai:gpt-4.1"))
    const current = yield* Ref.get(configRef)
    const entry = current.plugins?.find((entry) => entry.id === id)
    if (entry === undefined) return yield* Effect.fail(bad(`Unknown plugin instance ${id}`))
    const status = yield* applyConfig(state, { version: 1, plugins: [{ id, use: entry.use, options: { [key]: value } }] })
    if (status === "applied" && ((id === "models" && key === "model") || key === "driverModel")) {
      const choices = yield* modelChoices(state)
      state.setModel(modelRoles(choices.settings, choices.graph.nodes.find((node) => node.entry.id === "loop")?.options ?? {}).driver)
    }
  })
  const replacePlugin = (state: TuiState, id: string, use: string) => Effect.gen(function* () {
    if (use.trim().length === 0) return yield* Effect.fail(bad("Enter an installed package name or a local plugin path."))
    const status = yield* applyConfig(state, { version: 1, plugins: [{ id, use: use.trim(), enabled: true }] })
    if (status === "applied" && id === "models") {
      const choices = yield* modelChoices(state)
      state.setModel(modelRoles(choices.settings, choices.graph.nodes.find((node) => node.entry.id === "loop")?.options ?? {}).driver)
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
              save: (text) => launch(state, (typeof node.options[key] === "string" ? Effect.succeed(text) : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)).pipe(Effect.flatMap((value) => save(state, node.entry.id, key, value)))) }),
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
  const chooseModel = (state: TuiState, role: "main" | "driver" | "editor" = "main") => Effect.gen(function* () {
    const choices = yield* modelChoices(state)
    const selected = modelRoles(choices.settings, choices.graph.nodes.find((node) => node.entry.id === "loop")?.options ?? {})[role]
    const target = role === "main" ? { id: "models", key: "model" } : { id: "loop", key: `${role}Model` }
    const select = (value: string) => save(state, target.id, target.key, value)
    state.setOverlay({ kind: "menu", title: `${role === "main" ? "Choose a model" : `Choose ${role === "driver" ? "controller" : "editor"} model`}${choices.active ? " · next turn" : ""}`, rows: [
      ...choices.entries.map((entry) => ({ label: entry.selection, detail: entry.selection === selected ? "Selected" : entry.label ?? entry.credential,
        select: () => launch(state, select(entry.selection)) })),
      ...(role === "main" ? [] : [{ label: "Use configured default", detail: role === "driver" ? "Main model" : "Fast model, falling back to controller", select: () => launch(state, select("")) }]),
      { label: "Enter a model ID…", detail: "Use any provider:model supported by your adapter", select: () => state.setOverlay({ kind: "edit", title: "Model · provider:model", value: "", save: (value) => launch(state, select(value.trim())) }) },
      { label: "Connect a provider…", detail: choices.entries.length === 0 ? "Connect to load model choices, or enter an ID" : "API key or subscription", select: () => launch(state, loginCommand(workspace, home, launch).run("", state)) },
    ] })
  })
  const chooseRoles = (state: TuiState) => Effect.gen(function* () {
    const choices = yield* modelChoices(state)
    const roles = modelRoles(choices.settings, choices.graph.nodes.find((node) => node.entry.id === "loop")?.options ?? {})
    state.setOverlay({ kind: "menu", title: `Model roles${choices.active ? " · next turn" : ""}`, rows: [
      { label: "Controller", detail: roles.driver || "unset", select: () => launch(state, chooseModel(state, "driver")) },
      { label: "Editor", detail: roles.editor || "unset", select: () => launch(state, chooseModel(state, "editor")) },
      { label: "Main default", detail: roles.main || "unset", select: () => launch(state, chooseModel(state)) },
    ] })
  })
  const chooseModules = (state: TuiState): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const graph = yield* harness.graph
    const selected = Schema.decodeUnknownOption(Schema.Array(Schema.String))(graph.nodes.find((node) => node.entry.id === "loop")?.options.modules)
    const enabled: ReadonlyArray<string> = Option.getOrElse(selected, () => [])
    state.setOverlay({ kind: "menu", title: "Effect modules · optional prompt expertise", rows: [
      ...SMITH_EFFECT_MODULE_IDS.map((id) => ({ label: `${enabled.includes(id) ? "●" : "○"} ${id}`, detail: enabled.includes(id) ? "Enabled" : "Disabled",
        select: () => launch(state, save(state, "loop", "modules", enabled.includes(id) ? enabled.filter((value) => value !== id) : [...enabled, id]).pipe(Effect.andThen(chooseModules(state)))) })),
      { label: "Enable all", detail: "Effect 4 profile", select: () => launch(state, save(state, "loop", "modules", [...SMITH_EFFECT_MODULE_IDS]).pipe(Effect.andThen(chooseModules(state)))) },
      { label: "Disable all", detail: "General coding", select: () => launch(state, save(state, "loop", "modules", []).pipe(Effect.andThen(chooseModules(state)))) },
    ] })
  })
  const inspectJournal = (state: TuiState, title: string, kinds: ReadonlyArray<string>) => harness.resume(state.session().id).pipe(
    Effect.flatMap((current) => current.journalHistory), Effect.map((events) => state.setInspector({ title, rows: journalRows(events, kinds) })),
  )
  const setup = (state: TuiState): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const catalog = (yield* modelChoices(state)).entries
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
    const worker = current.plugins?.find((entry) => entry.id === "worker")
    if (loop === undefined || tools === undefined) return yield* Effect.fail(bad("Smith workflows require loop and tools plugin instances."))
    const next = mergeConfig(current, { version: 1, bindings: { [AgentLoop.key]: "workflow", [DelegateLoop.key]: "worker" }, plugins: [
      { ...loop, enabled: false },
      { id: "worker", use: worker?.use ?? smithWorkerPlugin.id, enabled: true, options: worker?.options ?? {} },
      { id: "workflow", use: smithWorkflowPlugin.id, enabled: true, options: { mode } },
      { id: "legacy-memory", use: "@xandreed/plugin-memory", enabled: true },
      { id: "legacy-context", use: "@xandreed/plugin-context", enabled: true },
      { id: "legacy-tools", use: "@xandreed/plugin-tools-local", enabled: true, options: { readOnly: mode !== "forge" } },
    ] })
    if ((yield* harness.reconfigure(next)) === "restart-required") return yield* Effect.fail(bad("This worker has runtime scope. Configure the workflow and restart before using it."))
    yield* target.send(argument || (mode === "lock" ? "Lock the current specification" : "Implement the locked specification")).pipe(
      Effect.ensuring(Ref.get(configRef).pipe(Effect.flatMap((config) => harness.reconfigure(config)), Effect.ignore)),
    )
  })
  const commands: ReadonlyArray<TuiCommand> = [
    { name: "setup", description: "Set up providers, models, and plugins", run: (_argument, state) => setup(state) },
    { name: "model", description: "Choose a model, or /model provider:model", run: (argument, state) => argument.length === 0 ? chooseModel(state) : save(state, "models", "model", argument) },
    { name: "models", description: "Choose controller and editor models", run: (_argument, state) => chooseRoles(state) },
    { name: "mods", description: "Enable optional Effect 4 prompt modules", run: (_argument, state) => chooseModules(state) },
    loginCommand(workspace, home, launch),
    { name: "plugins", description: "Configure settings or replace a plugin", run: (_argument, state) => inspectPlugins(state) },
    { name: "plan", description: "Switch to read-only planning", run: (_argument, state) => save(state, "loop", "readOnly", true).pipe(Effect.tap(() => Effect.sync(() => state.setMode("plan")))) },
    { name: "code", description: "Enable direct coding tools", run: (_argument, state) => save(state, "loop", "readOnly", false).pipe(Effect.tap(() => Effect.sync(() => state.setMode("code")))) },
    { name: "spec", description: "Draft a specification: /spec your idea", run: (argument, state) => workflow("spec", argument, state) },
    { name: "lock", description: "Approve and lock the current specification", run: (argument, state) => workflow("lock", argument, state) },
    { name: "forge", description: "Implement the locked spec under Foundry gates", run: (argument, state) => workflow("forge", argument, state) },
    { name: "context", description: "Inspect model context, modules and compaction", run: (_argument, state) => inspectJournal(state, "Context", ["smith.context", "smith.models", "smith.planning", "smith.budget", "context.built", "request.prepared", "memory.compaction", "memory.context"]) },
    { name: "tasks", description: "Inspect editor work and proposals", run: (_argument, state) => inspectJournal(state, "Tasks", ["smith.editor", "smith.proposal", "smith.receipt"]) },
    { name: "checks", description: "Inspect verification commands and results", run: (_argument, state) => inspectJournal(state, "Checks", ["smith.check"]) },
    { name: "changes", description: "Review staged and working changes by file", run: (_argument, state) => workspaceChanges(workspace).pipe(Effect.map((rows) => state.setInspector({ title: "Workspace changes", rows }))) },
  ]
  const { runTui } = yield* Effect.promise(() => import("@xandreed/tui"))
  const hasModelSettings = graph.providers[SettingsStore.key] !== undefined
  const mainModel = Option.getOrElse(initialSettings.model, () => "")
  const model = String(graph.nodes.find((node) => node.entry.id === "loop")?.options.driverModel || mainModel)
  yield* runTui({ harness, session, approvals, commands, model, assistantName: "Smith", journalRenderers: smithJournalRenderers, initialPrompt: prompt, onReady: (state) => {
    state.setMode(graph.nodes.find((node) => node.entry.id === "loop")?.options.readOnly === true ? "plan" : "code")
    return hasModelSettings && model.length === 0 && prompt.length === 0 ? setup(state) : Effect.void
  }, beforeSend: (text, state) => Effect.gen(function* () {
    if ((yield* harness.graph).providers[SettingsStore.key] === undefined || state.model().length > 0) return true
    state.restoreDraft(text)
    state.setNotice("Choose a model first. Your message is kept; press Enter after setup.")
    yield* chooseModel(state)
    return false
  }), eventRenderers: {
    "workflow.event": (event) => [{ id: event.id, kind: "notice", text: `Forge · ${String(event.data.type).replaceAll("_", " ")}`, detail: JSON.stringify(event.data, null, 2), status: event.data.type === "forge_error" ? "failed" : "complete" }],
    "spec.locked": (event) => [{ id: event.id, kind: "notice", text: "Specification locked", detail: String(event.data.text), status: "complete" }],
  } })
})).pipe(Effect.provide(process.stdout.isTTY || args.includes("--json") || args.includes("--journal-json") ? Logger.layer([Logger.tracerLogger]) : Layer.empty))

if (import.meta.main) {
  await Effect.runPromise(runCli(process.argv.slice(2)).pipe(Effect.catchCause((cause) => Effect.sync(() => { console.error(String(cause)); process.exitCode = 1 }))))
}
