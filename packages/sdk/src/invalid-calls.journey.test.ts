import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  harnessCodeOf,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  toolCallStatesOf,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { InvalidCallPolicy, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A journey, key-free, with a scripted model: a host whose replies batch
 * independent calls sets `limits.invalidCalls` to `answer`, and a reply that
 * calls one tool that exists and one that does not runs the first, answers the
 * second, and the run goes on. What the journal proves about each call, and
 * what the model reads next, are checked from the stored session.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})

const host = (looked: Ref.Ref<ReadonlyArray<string>>) => defineCapability({
  id: "invalid-calls-host", version: "1",
  tools: [defineTool({
    tool: Lookup,
    handler: ({ query }) => Ref.update(looked, (all) => [...all, query]).pipe(Effect.as({ ids: [`record-${query}`] })),
    view: { version: "1", render: (result) => `FOUND ${result.ids.join(", ")}` },
  })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }

/** The reply of the first step: a call that runs and a call to a tool the agent does not have. */
const batched = [
  { type: "tool-call", id: "c1", name: "lookup", params: { query: "alpha" } },
  { type: "tool-call", id: "c2", name: "publish_page", params: { page: "alpha" } },
  { type: "finish", reason: "tool-calls", usage },
]

const journey = (invalidCalls: InvalidCallPolicy) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { owner: "invalid-calls", id: ConversationId.make("00000000-0000-4000-8000-00000000c411") }
  yield* sessions.create(address)
  const looked = yield* Ref.make<ReadonlyArray<string>>([])
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host(looked)],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, invalidCalls },
  })
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.map((index) => (index === 0 ? batched : [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage }]) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  const outcome = yield* agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text: "look alpha up and publish it" }), runId: RunId.make("invalid-calls-run") },
    services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, model)),
  }, (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
  const stored = yield* sessions.read(address)
  return { outcome, looked: yield* Ref.get(looked), prompts: yield* Ref.get(prompts), stored, states: yield* toolCallStatesOf(stored) }
})))

describe("journey: a host answers a reply's invalid calls one by one (limits.invalidCalls)", () => {
  test("answer: the call to a tool the agent has runs, the other is answered and recorded with the reply, and the run goes on", async () => {
    const observed = await journey("answer")
    expect(observed.outcome).toMatchObject({ outcome: "completed", reply: Option.some("done") })
    expect(observed.looked).toEqual(["alpha"])
    // The journal proves both calls answered: the rejected one never started, and no reopened log shows it pending.
    expect(observed.states).toMatchObject([
      { _tag: "Completed", toolCallId: "c1", result: { isError: false } },
      { _tag: "Completed", toolCallId: "c2", started: Option.none(), result: { isError: true } },
    ])
    const ended = observed.stored.filter((event) => event.kind === "step.ended").map((event) => event.data.status)
    expect(ended).toEqual(["completed", "completed"])
    expect(observed.stored.some((event) => event.kind === "tool.started" && event.data.toolCallId === "c2")).toBe(false)
    // The model's next request reads the answer as the call's result.
    expect(observed.prompts).toHaveLength(2)
    expect(observed.prompts[1]).toContain("This call was not run: it names a tool you do not have; the name follows, as you wrote it.")
    expect(observed.prompts[1]).toContain("FOUND record-alpha")
  })

  test("corrective (the default): neither call runs, the step is malformed and the model is asked again", async () => {
    const observed = await journey("corrective")
    expect(observed.looked).toEqual([])
    const ended = observed.stored.filter((event) => event.kind === "step.ended").map((event) => event.data.status)
    expect(ended).toEqual(["malformed", "completed"])
    expect(observed.prompts[1]).toContain("your previous reply called a tool you do not have")
  })

  test("a policy that does not decode fails Agent.define (config.limits)", async () => {
    expect(await Effect.runPromise(Effect.scoped(Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
      turnServices: [LanguageModel.LanguageModel],
      limits: { invalidCalls: "skip" as InvalidCallPolicy },
    })).pipe(Effect.match({ onSuccess: () => "succeeded", onFailure: (error) => Option.getOrElse(harnessCodeOf(error), () => error._tag) })))).toBe("config.limits")
  })
})
