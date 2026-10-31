import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill, defineTool,
  emptyQuery, entriesOfEvents, Failure, InvocationId, queryLog, replayModelRequest, RunId, SessionLogMemoryLive, Sessions,
  ToolCallId, ToolInterceptor, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { CurrentToolResultReceipt, makeToolResultReceipt } from "@xandreed/core/internal"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { Agent } from "./agent.adapter.js"

const Calculate = Tool.make("intercept_calculate", {
  description: "Calculate the fixture value.", parameters: Schema.Struct({ n: Schema.NumberFromString }),
  success: Schema.NumberFromString, failure: Failure, failureMode: "return",
})
const answer = [{ type: "text", text: "finished" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } }] as const

test.each([false, true])("journey: effective input and final answer persist once for normal/planned calls (%p)", async (planned) => {
  const requests: string[] = []
  const handlers: number[] = []
  const callbacks: unknown[] = []
  const completed: unknown[] = []
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const session = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-000000002901") }
    const runId = RunId.make("intercept-agent")
    const parent = yield* makeToolResultReceipt({ tool: Calculate.name, toolCallId: ToolCallId.make("reused-provider-id"), run: Option.none(), step: 0 })
    yield* sessions.create(session)
    const capability = defineCapability({ id: "fixture/interception", version: "1", tools: [defineTool({
      tool: Calculate, handler: ({ n }) => Effect.sync(() => { handlers.push(n); return n * 10 }),
      view: { version: "1", render: (result, params) => `input ${params.n}; result ${result}` },
    })], skills: [defineSkill({ id: "fixture/interception", summary: "Calculate the fixture value.", tools: [Calculate.name], always: true })] })
    const model = yield* LanguageModel.make({ generateText: (options) => Effect.sync(() => {
      requests.push(JSON.stringify(options.prompt.content))
      return !planned && requests.length === 1 ? [
        { type: "tool-call", id: "reused-provider-id", name: Calculate.name, params: { n: "001" } },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
      ] : [...answer]
    }), streamText: () => Stream.die("not scripted") })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [capability], turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 3 } })
    const result = yield* agent.turn({ turn: { session, runId, userMessage: new UserMessage({ text: "calculate" }) },
      services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(CurrentToolResultReceipt, Option.some({ _tag: "Guard", guard: parent.guard })), Context.add(ToolInterceptor, {
        before: (input) => Effect.gen(function* () {
          callbacks.push(["before", input.input, yield* CurrentAgentRun, yield* CurrentAgentStep, Object.isFrozen(input), Object.isFrozen(input.input)])
          return { _tag: "Rewrite", input: { n: "002" } }
        }),
        after: (input) => Effect.gen(function* () {
          callbacks.push(["after", input.input, input.outcome, yield* CurrentAgentRun, yield* CurrentAgentStep])
          return { _tag: "Replace", outcome: { _tag: "Success", encoded: "003" } }
        }),
      })) }, (turn) => Effect.gen(function* () {
      yield* turn.events.subscribe((event) => event._tag === "tool.completed" && event.tool === Calculate.name ? Option.some(event) : Option.none(), (event) => Effect.sync(() => { completed.push({ input: event.input, result: event.result, encoded: event.encoded }) }))
      yield* turn.tools.select(turn.userMessage)
      const run = yield* turn.run(planned ? { initial: { calls: [{ name: Calculate.name, params: { n: "001" } }], skills: [] } } : {})
      return { outcome: run.outcome, reply: Option.some(run.text) }
    }))
    const events = yield* sessions.read(session)
    return { result, events, entries: yield* entriesOfEvents(events), replayed: yield* replayModelRequest(events, runId, 1), parentStatus: yield* parent.guard.status }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(observed.parentStatus).toBe("Fresh")
  expect(handlers).toEqual([2])
  expect(completed).toEqual([{ input: { n: 2 }, result: 20, encoded: "20" }])
  const run = Option.some({ id: "intercept-agent", turn: 1, ordinal: 0 })
  expect(callbacks).toEqual([
    ["before", { n: "001" }, run, Option.some(0), true, true],
    ["after", { n: "002" }, { _tag: "Success", encoded: "20" }, run, Option.some(0)],
  ])
  const results = observed.entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [entry.body] : [])
  expect(results).toHaveLength(1)
  expect(results[0]?.encoded).toBe("3")
  expect(results[0]?.interception).toEqual({ invocationId: InvocationId.make("intercept-agent:call:0"), effectiveInput: { n: "002" } })
  expect(queryLog(observed.entries, { ...emptyQuery, tool: Option.some(Calculate.name) }).flatMap((entry) => entry.body._tag === "ToolResult" ? [entry.body.view] : [])).toEqual(["input 2; result 3"])
  const original = observed.entries.flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant" ? entry.body.message.content.flatMap((part) => part.type === "tool-call" ? [part.input] : []) : [])
  expect(original).toEqual([{ n: "001" }])
  expect(observed.events.filter((event) => event.kind === "tool.intercepted").map((event) => event.data.phase)).toEqual([
    { _tag: "Before", decision: { _tag: "Rewrite", input: { n: "002" } } },
    { _tag: "After", decision: { _tag: "Replace", kind: "Success" } },
  ])
  expect(observed.events.filter((event) => event.kind === "tool.intercepted").map((event) => event.data.source)).toEqual(["loop", "loop"])
  expect(JSON.stringify(observed.replayed.prompt.content)).toBe(requests.at(-1) ?? "")
  expect(requests.at(-1)).toContain("input 2; result 3")
  expect(observed.events.filter((event) => event.kind === "model.called")).toEqual([])
})
