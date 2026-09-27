import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "@effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId,
  Contributions,
  defineContributions,
  defineSkill,
  defineTool,
  definePlugin,
  Failure,
  IntentMatcher,
  RunContext,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { EventBody, HarnessConfig, SessionEvent, SessionRecord } from "@xandreed/core"
import { composableLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryLogPlugin } from "@xandreed/plugin-memory-log"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { AgentHost } from "./agent-host.js"
import { Delivered } from "./testing.port.js"

/* ── the host's definitions: tools with views, skills, sections, policy ── */

const Lookup = Tool.make("lookup", {
  description: "Look up a record by query.",
  parameters: { query: Schema.String },
  success: Schema.Struct({ id: Schema.String, detail: Schema.String }),
  failure: Failure,
  failureMode: "return",
})
const Deliver = Tool.make("deliver", {
  description: "Deliver the final answer.",
  parameters: { text: Schema.String },
  success: Schema.Boolean,
  failure: Failure,
  failureMode: "return",
})


const hostContribution = defineContributions({
  id: "test-host", version: "1",
  tools: [
    defineTool({
      tool: Lookup,
      handler: ({ query }) => Effect.succeed({ id: `record-${query}`, detail: `${query} `.repeat(40) }),
      view: {
        version: "1",
        render: (result) => `FOUND ${result.id}: ${result.detail}`,
        compact: (result) => `(earlier lookup found ${result.id})`,
        subjects: (result) => [{ kind: "record", id: result.id, label: Option.none(), data: Option.none() }],
      },
      annotations: { readOnly: true, labels: { en: "Looking up" } },
    }),
    defineTool({
      tool: Deliver,
      handler: ({ text }) => Delivered.pipe(Effect.flatMap((ref) => Ref.set(ref, Option.some(text))), Effect.as(true)),
    }),
  ],
  skills: [
    defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true }),
    defineSkill({ id: "delivery", summary: "Deliver a final answer.", instructions: "Deliver once, with the record id.", tools: ["deliver"] }),
  ],
  sections: [
    { id: "persona", version: "1", tier: "static", order: 0, render: () => Effect.succeed(Option.some("You are a test agent.")) },
    { id: "clock", version: "1", tier: "turn", order: 0, render: () => RunContext.pipe(Effect.map((run) => Option.some(`Host context for ${run.runId}.`))) },
  ],
  run: Option.some(Layer.effect(Delivered, Ref.make(Option.none<string>()))),
  hooks: {
    step: Option.some((step) => Effect.succeed({ context: Option.some(`step ${step.stepIndex}`), toolChoice: Option.none() })),
    isComplete: Option.some(() => Delivered.pipe(Effect.flatMap(Ref.get), Effect.map(Option.isSome))),
    reply: Option.some(Delivered.pipe(Effect.flatMap(Ref.get), Effect.orDie)),
  },
})

const hostPlugin = definePlugin({
  id: "test-host", version: "1", config: Schema.Struct({}), defaults: {}, provides: [], contributes: [Contributions],
  layer: () => Layer.succeed(Contributions, [hostContribution]),
})

/** A matcher that picks "delivery" whenever the message asks to deliver. */
const matcherPlugin = definePlugin({
  id: "test-matcher", version: "1", config: Schema.Struct({}), defaults: {}, provides: [IntentMatcher],
  layer: () => Layer.succeed(IntentMatcher, IntentMatcher.of({
    id: "keyword", version: "1",
    match: ({ message }) => Effect.succeed({ skills: message.includes("deliver") ? ["delivery"] : [], probabilities: Option.none(), abstained: false }),
  })),
})

/* ── a scripted provider that records every request it receives ── */

interface Seen { readonly tools: ReadonlyArray<string>; readonly prompt: ReadonlyArray<unknown> }
const finish = { type: "finish", reason: "tool-calls", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }
const call = (id: string, name: string, params: unknown) => [{ type: "tool-call", id, name, params }, finish]

const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: ReadonlyArray<ReadonlyArray<unknown>>) => LanguageModel.make({
  generateText: (options) => Ref.modify(seen, (all) => [all.length, [...all, { tools: options.tools.map((tool) => tool.name), prompt: options.prompt.content }]]).pipe(
    Effect.map((index) => (script[index] ?? [{ type: "text", text: "done" }, { ...finish, reason: "stop" }]) as never),
  ),
  streamText: () => Stream.die("not scripted") as never,
})

/* ── an in-memory host journal ── */

const journal = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<SessionEvent>>([])
  const session: SessionRecord = { id: ConversationId.make("00000000-0000-4000-8000-000000000001"), workspace: "/tmp/test", profile: "test", createdAt: 0 }
  const publish = (body: EventBody) => Ref.modify(events, (all): [SessionEvent, ReadonlyArray<SessionEvent>] => {
    const event: SessionEvent = { ...body, version: 1, id: `e${all.length}`, sessionId: session.id, seq: all.length, at: all.length }
    return [event, [...all, event]]
  })
  const history = (after: number, names: ReadonlyArray<string>) => Ref.get(events).pipe(Effect.map((all) => all.filter((event) => event.seq > after && (names.length === 0 || names.includes(event.name)))))
  return { events, session, io: { publish, history, transient: () => Effect.void, steering: Effect.succeed(Option.none<string>()) } }
})

const plugins = [memoryLogPlugin, memoryWindowPlugin, memorySummaryPlugin, toolDiscoveryPlugin, composableLoopPlugin, hostPlugin, matcherPlugin]
const configFor = (memory: string, matcher = true): HarnessConfig => ({
  version: 1,
  plugins: [
    { id: "log", use: memoryLogPlugin.id },
    { id: "memory", use: memory, options: memory === memorySummaryPlugin.id ? { triggerRatio: 0.1, keepRatio: 0.05, cooldownTurns: 0 } : {} },
    { id: "tools", use: toolDiscoveryPlugin.id },
    { id: "loop", use: composableLoopPlugin.id, options: { streaming: false, requireCompletion: true, maxSteps: 6, budgetTokens: memory === memorySummaryPlugin.id ? 1_500 : 20_000 } },
    { id: "host", use: hostPlugin.id },
    ...(matcher ? [{ id: "matcher", use: matcherPlugin.id }] : []),
  ],
})
const utility = Context.make(UtilityLlm, UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({ text: "SUMMARY of earlier turns", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })) }))

const turnOn = (config: HarnessConfig, j: Effect.Effect.Success<typeof journal>, runId: string, prompt: string, script: ReadonlyArray<ReadonlyArray<unknown>>) => Effect.scoped(Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const model = yield* scripted(seen, script)
  const host = yield* AgentHost.make({ config, plugins, workspace: "/tmp/test", services: utility, turnServices: [LanguageModel.LanguageModel] })
  const result = yield* host.run({ session: j.session, runId, prompt, io: j.io, services: Context.make(LanguageModel.LanguageModel, model) })
  return { result, seen: yield* Ref.get(seen) }
}))

const lookupThenDeliver = [call("c1", "lookup", { query: "alpha" }), call("c2", "deliver", { text: "record-alpha" })]

describe("composable agent host", () => {
  test("tools grow in activation order, contributions shape every request, and the reply is recorded", async () => {
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const j = yield* journal
      const first = yield* turnOn(configFor(memoryWindowPlugin.id, false), j, "run-1", "find alpha", [
        call("c1", "lookup", { query: "alpha" }),
        call("c2", "load_skill", { skills: ["delivery"] }),
        call("c3", "deliver", { text: "record-alpha" }),
      ])
      return { first, events: yield* Ref.get(j.events) }
    }))
    const { first, events } = outcome
    expect(first.result).toEqual({ text: "record-alpha", outcome: "completed" })
    expect(first.seen.map((request) => request.tools)).toEqual([
      ["load_skill", "read_skill_reference", "lookup", "recall_context"],
      ["load_skill", "read_skill_reference", "lookup", "recall_context"],
      ["load_skill", "read_skill_reference", "lookup", "recall_context", "deliver"],
    ])
    const system = JSON.stringify(first.seen[0]!.prompt[0])
    expect(system).toContain("You are a test agent.")
    expect(system).toContain("delivery: Deliver a final answer.")
    const lastPrompt = JSON.stringify(first.seen[2]!.prompt)
    expect(lastPrompt).toContain("FOUND record-alpha")
    expect(lastPrompt).toContain("Deliver once, with the record id.")
    expect(lastPrompt).toContain("step 2")
    expect(lastPrompt).not.toContain("step 1")
    expect(events.filter((event) => event.name === "tool.invocation").map((event) => event.data.tool)).toEqual(["lookup", "load_skill", "deliver"])
    expect(events.filter((event) => event.name === "context.built")).toHaveLength(3)
  })

  test("within a turn every request extends the previous one; only the step context closes it", async () => {
    const seen = await Effect.runPromise(Effect.gen(function* () {
      const j = yield* journal
      return (yield* turnOn(configFor(memoryWindowPlugin.id), j, "run-1", "find alpha and deliver", lookupThenDeliver)).seen
    }))
    const withoutTail = (prompt: ReadonlyArray<unknown>) => prompt.slice(0, -1).map((message) => JSON.stringify(message))
    const first = withoutTail(seen[0]!.prompt)
    const second = withoutTail(seen[1]!.prompt)
    expect(second.slice(0, first.length)).toEqual(first)
    expect(seen[0]!.tools).toContain("deliver")
  })

  test("the matcher seeds skills before the first step and records its decision", async () => {
    const events = await Effect.runPromise(Effect.gen(function* () {
      const j = yield* journal
      yield* turnOn(configFor(memoryWindowPlugin.id), j, "run-1", "please deliver alpha", lookupThenDeliver)
      return yield* Ref.get(j.events)
    }))
    const decision = events.find((event) => event.name === "decision.record")
    expect(decision?.data).toMatchObject({ family: "skill-selection", selection: ["delivery"], validation: "accepted" })
  })

  test("a follow-up turn rebuilt by a fresh process sees exactly what a continuing one would", async () => {
    const [fresh, continued] = await Effect.runPromise(Effect.gen(function* () {
      const runTwice = Effect.gen(function* () {
        const j = yield* journal
        yield* turnOn(configFor(memoryWindowPlugin.id), j, "run-1", "find alpha and deliver", lookupThenDeliver)
        return (yield* turnOn(configFor(memoryWindowPlugin.id), j, "run-2", "and beta, deliver", [call("d1", "deliver", { text: "none" })])).seen
      })
      return [yield* runTwice, yield* runTwice]
    }))
    expect(JSON.stringify(fresh[0]!.prompt)).toBe(JSON.stringify(continued[0]!.prompt))
    const followUp = JSON.stringify(fresh[0]!.prompt)
    expect(followUp).toContain("(earlier lookup found record-alpha)")
    expect(followUp).not.toContain("FOUND record-alpha")
    expect(followUp).toContain("record-alpha")
  })

  test("swapping the memory strategy is one config entry", async () => {
    const events = await Effect.runPromise(Effect.gen(function* () {
      const j = yield* journal
      const config = configFor(memorySummaryPlugin.id)
      yield* turnOn(config, j, "run-1", "find alpha and deliver", lookupThenDeliver)
      yield* turnOn(config, j, "run-2", "find beta and deliver", [call("d1", "lookup", { query: "beta" }), call("d2", "deliver", { text: "record-beta" })])
      const third = yield* turnOn(config, j, "run-3", "deliver gamma", [call("e1", "deliver", { text: "gamma" })])
      return { events: yield* Ref.get(j.events), third: third.seen }
    }))
    const built = events.events.filter((event) => event.name === "context.built")
    expect(new Set(built.map((event) => event.data.strategy))).toEqual(new Set(["summary"]))
    expect(JSON.stringify(events.third[0]!.prompt)).toContain("SUMMARY of earlier turns")
  })
})
