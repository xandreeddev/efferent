import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure,
  harnessCodeOf, ModelRequestHook, replayModelRequest, resolveRequestHeader, RunId, SessionLogError,
  SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { ModelRequestPatch } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { Agent } from "./agent.adapter.js"
import { Stamp } from "./testing.port.js"

const session = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-000000000028") }
const sessionsLive = SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
const plugins = [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin]
const answer = [{ type: "text", text: "finished" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }] as const

test("journey: an optional hook from a host layer sees actual run context and replay never reapplies it", async () => {
  const requests: { readonly prompt: string; readonly toolChoice: unknown }[] = []
  const calls: unknown[] = []
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLive), Sessions)
    yield* sessions.create(session)
    const agent = yield* Agent.define({ plugins, turnServices: [Sessions, LanguageModel.LanguageModel], system: "original system", limits: { streaming: false, maxSteps: 1 } })
    const model = yield* LanguageModel.make({ generateText: (options) => Effect.sync(() => {
      requests.push({ prompt: JSON.stringify(options.prompt.content), toolChoice: options.toolChoice })
      return [...answer]
    }), streamText: () => Stream.die("not scripted") })
    const layer = Layer.effect(ModelRequestHook, Effect.gen(function* () {
      const stamp = yield* Stamp
      return { prepare: (draft) => Effect.gen(function* () {
        calls.push([draft.run, draft.step, yield* CurrentAgentRun, yield* CurrentAgentStep, stamp.label])
        return { system: `patched ${stamp.label}`, context: `context ${draft.run.ordinal}`, toolChoice: null }
      }) }
    })).pipe(Layer.provide(Layer.succeed(Stamp, { label: "host layer" })))
    const result = yield* agent.turn({
      turn: { session, runId: RunId.make("hook-agent"), userMessage: new UserMessage({ text: "hello" }) },
      services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)), layer,
    }, (turn) => Effect.gen(function* () {
      yield* turn.run({ step: () => Effect.succeed({ context: Option.some("policy"), toolChoice: Option.some("required") }) })
      yield* turn.run({ step: () => Effect.succeed({ context: Option.some("policy"), toolChoice: Option.some("required") }) })
      return yield* turn.reply("finished")
    }))
    const events = yield* sessions.read(session)
    const stored = yield* Effect.forEach(events.filter((event) => event.kind === "request.prepared"), (event) => resolveRequestHeader(events, event), { concurrency: 1 })
    const replayed = yield* replayModelRequest(events, RunId.make("hook-agent"), 0).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.die("replay must not invoke current hook") }))
    return { result, events, stored, replayed, entries: yield* entriesOfEvents(events) }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(calls).toEqual([0, 1].map((ordinal) => [{ id: "hook-agent", turn: 1, ordinal }, 0, Option.some({ id: "hook-agent", turn: 1, ordinal }), Option.some(0), "host layer"]))
  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.toolChoice)).toEqual(["auto", "auto"])
  expect(observed.stored.map((header) => [header.system, header.toolChoice, header.hook])).toEqual([0, 1].map((ordinal) => ["patched host layer", "auto", { system: "patched host layer", context: `context ${ordinal}`, toolChoice: null }]))
  expect(observed.entries.flatMap((entry) => entry.body._tag === "StepContext" ? [entry.body.text] : [])).toEqual(["policy\n\n[Host note: context 0]", "policy\n\n[Host note: context 1]"])
  expect(JSON.stringify(observed.replayed.prompt.content)).toBe(requests[0]?.prompt ?? "")
})

test.each(["invalid", "typed", "defect"] as const)("journey: %s hook failure cannot send a model request", async (kind) => {
  const sends: number[] = []
  const original = new SessionLogError({ code: "store.io", message: "fixture hook storage failed" })
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLive), Sessions)
    yield* sessions.create(session)
    const model = yield* LanguageModel.make({ generateText: () => Effect.sync(() => { sends.push(1); return [...answer] }), streamText: () => Stream.die("not scripted") })
    const agent = yield* Agent.define({ plugins, turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 1 } })
    const prepare = (): Effect.Effect<ModelRequestPatch, SessionLogError> => kind === "typed" ? Effect.fail(original) : kind === "defect" ? Effect.die(original) : Effect.succeed({ toolChoice: { tool: "not active" } })
    const result = yield* agent.turn({ turn: { session, runId: RunId.make("hook-failed"), userMessage: new UserMessage({ text: "hello" }) },
      services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(ModelRequestHook, { prepare })) },
    (turn) => turn.run({}).pipe(Effect.flatMap(() => turn.reply("never")))).pipe(Effect.result)
    return { result, events: yield* sessions.read(session) }
  })))
  expect(sends).toEqual([])
  expect(observed.result._tag).toBe("Failure")
  if (observed.result._tag === "Failure") {
    if (kind === "invalid") expect(harnessCodeOf(observed.result.failure)).toEqual(Option.some("request.hook"))
    else expect(observed.result.failure).toBe(original)
  }
  expect(observed.events.filter((event) => event.kind === "request.prepared" || event.kind === "memory.step")).toEqual([])
  expect(observed.events.find((event) => event.kind === "turn.ended")?.data.reason).toBe("failed")
})

test("journey: helper calls and the initial planned tool batch skip the hook", async () => {
  const hookCalls: number[] = []
  const handlers: number[] = []
  const Touch = Tool.make("touch", { description: "Touch the fixture.", parameters: Tool.EmptyParams, success: Schema.Boolean, failure: Failure, failureMode: "return" })
  const capability = defineCapability({ id: "fixture/hook-batch", version: "1", tools: [defineTool({ tool: Touch, handler: () => Effect.sync(() => { handlers.push(1); return true }) })], skills: [defineSkill({ id: "touch-skill", summary: "Touch the fixture.", tools: ["touch"], always: true })] })
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLive), Sessions)
    yield* sessions.create(session)
    const model = yield* LanguageModel.make({ generateText: () => Effect.succeed([...answer]), streamText: () => Stream.die("not scripted") })
    const agent = yield* Agent.define({ plugins, capabilities: [capability], turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 1 } })
    const result = yield* agent.turn({ turn: { session, runId: RunId.make("hook-batch"), userMessage: new UserMessage({ text: "hello" }) },
      services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(ModelRequestHook, { prepare: () => Effect.sync(() => { hookCalls.push(1); return {} }) })) },
    (turn) => Effect.gen(function* () {
      yield* LanguageModel.generateText({ prompt: "standalone helper" }).pipe(Effect.orDie, Effect.provideService(LanguageModel.LanguageModel, model))
      yield* turn.tools.select(turn.userMessage)
      yield* turn.run({ initial: { calls: [{ name: "touch", params: {} }], skills: [] } })
      return yield* turn.reply("finished")
    }))
    return { result, events: yield* sessions.read(session) }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(handlers).toEqual([1])
  expect(hookCalls).toEqual([])
  expect(observed.events.filter((event) => event.kind === "request.prepared")).toEqual([])
})

