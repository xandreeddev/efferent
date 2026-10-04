import { expect, test } from "bun:test"
import { Tool, Toolkit } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Capabilities, ConversationId, CurrentAgentStep, defineCapability, defineSkill, defineTool, Failure, IntentMatcher, makeTurnEvents, makeTurnTasks, openLogSession, PermissionGrants, RunContext, UserMessage } from "@xandreed/core"
import type { HarnessError, LogEntry, MemorySession, TurnEvent } from "@xandreed/core"
import { toolDiscoveryDefaults, toolDiscoveryPlugin } from "./plugin.adapter.js"
import { makeRegistry } from "./registry.adapter.js"

const Read = Tool.make("read_file", { parameters: Schema.Struct({ path: Schema.String }), success: Schema.String, failure: Failure, failureMode: "return" })
const Write = Tool.make("write_file", { parameters: Schema.Struct({ path: Schema.String }), success: Schema.Boolean, failure: Failure, failureMode: "return" })
const capability = defineCapability({
  id: "fixture", version: "1", tools: [
    defineTool({ tool: Read, handler: ({ path }) => path === "missing.md" ? Effect.fail({ error: "NotFound", message: "Read README.md instead" }) : Effect.succeed("README recovered"), annotations: { readOnly: true } }),
    defineTool({ tool: Write, handler: () => Effect.succeed(true), annotations: { permissions: ["edit"] } }),
  ], skills: [
    defineSkill({ id: "public.read", summary: "Read workspace files", tools: [Read.name] }),
    defineSkill({ id: "private.editor", summary: "Edit workspace files", tools: [Write.name], permissions: ["edit"] }),
    defineSkill({ id: "private.always", summary: "Private always-on edit", tools: [Write.name], always: true }),
    defineSkill({ id: "private.instructions", summary: "Private instructions without a tool", tools: [], permissions: ["edit"] }),
    defineSkill({ id: "private.read", summary: "Private instructions for a public tool", tools: [Read.name], permissions: ["edit"] }),
  ],
})

const memory = Effect.gen(function* () {
  const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
  return yield* openLogSession({ read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }, {
    strategy: { id: "test", version: "1" }, render: { turnContext: "current", replies: true, digests: false, media: { mode: "none", maxImages: 0 } },
    digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
  }, { runId: "discovery-test" })
})

const runServices = (session: MemorySession, grants: ReadonlyArray<string>) => Effect.gen(function* () {
  const events = yield* makeTurnEvents({ maxDepth: 8 })
  const tasks = yield* makeTurnTasks(yield* Effect.scope)
  const conversation = ConversationId.make("00000000-0000-4000-8000-000000000071")
  return Context.make(RunContext, {
    conversation, session: { id: conversation, owner: "fixture" }, runId: "discovery-test", userMessage: new UserMessage({ text: "Read README.md" }), memory: session, events, tasks,
    activate: () => Effect.succeed([]), flush: Effect.void, write: (effect) => effect,
  }).pipe(Context.add(PermissionGrants, { grants: Effect.succeed(new Set(grants)) }))
})

test("discovery advertises only permitted skills and forgets forbidden replayed activations", async () => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* memory
    const registry = yield* makeRegistry(toolDiscoveryDefaults, [capability])
    const permitted = yield* runServices(session, ["edit"])
    const first = yield* registry.open(session).pipe(Effect.provide(permitted))
    yield* first.activate(["public.read", "private.editor", "private.instructions", "private.read"], "host")
    const observed = yield* Ref.make<ReadonlyArray<string>>([])
    const limited = (yield* runServices(session, [])).pipe(Context.add(IntentMatcher, {
      id: "fixture", version: "1", match: ({ skills }) => Ref.set(observed, skills.map((skill) => skill.id)).pipe(Effect.as({ skills: [], abstained: true, probabilities: Option.none() })),
    }))
    const next = yield* registry.open(session).pipe(Effect.provide(limited))
    yield* next.select(new UserMessage({ text: "hello" }))
    const denied = yield* Effect.result(next.activate(["private.instructions"], "host"))
    const plugin = yield* Layer.build(toolDiscoveryPlugin.live(toolDiscoveryDefaults).pipe(Layer.provide(Layer.succeed(Capabilities, [capability]))))
    const sections = Context.get(plugin, Capabilities).flatMap((value) => value.promptSections)
    // This plugin's section is context-free; capabilities erase render requirements.
    const catalog = yield* sections[0]!.render({ variant: Option.none(), active: yield* next.active, skills: next.skills }) as Effect.Effect<Option.Option<string>, HarnessError>
    return { skills: next.skills.map((skill) => skill.id), active: yield* next.active, matched: yield* Ref.get(observed), denied, catalog }
  }).pipe(Effect.scoped))
  expect(outcome.skills).toEqual(["public.read"])
  expect(outcome.active).toEqual(["load_skill", "read_file"])
  expect(outcome.matched).toEqual(["public.read"])
  expect(outcome.denied._tag === "Failure" ? outcome.denied.failure.code : "success").toBe("capability.forbidden")
  expect(Option.getOrElse(outcome.catalog, () => "")).toContain("public.read")
  expect(Option.getOrElse(outcome.catalog, () => "")).not.toContain("private.")
})

test("native registry tool failure is data and the repaired call keeps its provider id and current step", async () => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* memory
    const services = yield* runServices(session, [])
    const events = Context.get(services, RunContext).events
    const published = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
    yield* events.subscribe(Option.some, (event) => Ref.update(published, (all) => [...all, event]))
    const registry = yield* makeRegistry(toolDiscoveryDefaults, [capability])
    const tools = yield* registry.open(session).pipe(Effect.provide(services))
    yield* tools.activate(["public.read"], "host")
    // Resolve the known fixture tools against the registry's real captured handlers.
    const toolkit = yield* Toolkit.make(Read, Write).pipe(Effect.provide(tools.handlers as Context.Context<Tool.Handler<"read_file"> | Tool.Handler<"write_file">>))
    const missing = yield* toolkit.handle("read_file", { path: "missing.md" }, "missing-call").pipe(Effect.flatMap(Stream.runCollect), Effect.provideService(CurrentAgentStep, Option.some(0)))
    const repaired = yield* toolkit.handle("read_file", { path: "README.md" }, "repair-call").pipe(Effect.flatMap(Stream.runCollect), Effect.provideService(CurrentAgentStep, Option.some(1)))
    return { missing, repaired, lifecycle: (yield* Ref.get(published)).filter((event) => event._tag === "tool.started" || event._tag === "tool.completed") }
  }).pipe(Effect.scoped))
  expect(outcome.missing[0]).toMatchObject({ isFailure: true, result: { error: "NotFound", message: "Read README.md instead" } })
  expect(outcome.repaired[0]).toMatchObject({ isFailure: false, result: "README recovered" })
  expect(outcome.lifecycle.map((event) => ({ kind: event._tag, step: event.step, callId: String(event.toolCallId) }))).toEqual([
    { kind: "tool.started", step: 0, callId: "missing-call" }, { kind: "tool.completed", step: 0, callId: "missing-call" },
    { kind: "tool.started", step: 1, callId: "repair-call" }, { kind: "tool.completed", step: 1, callId: "repair-call" },
  ])
})
