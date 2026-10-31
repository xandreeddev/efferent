import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, InboxItemId, InboxRunner, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, zeroUsage } from "@xandreed/core"
import type { TurnRunner } from "@xandreed/core"
import { inboxRunnerConformance, textReply } from "@xandreed/core/conformance"
import type { InboxRunnerSubject } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import { agentInboxRunner } from "./inbox-runner.adapter.js"

const sessionsLayer = () => SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
const subject: InboxRunnerSubject = {
  open: ({ use }) => Effect.gen(function* () {
    const sessionsContext = yield* Layer.build(sessionsLayer())
    const sessions = Context.get(sessionsContext, Sessions)
    const runner: TurnRunner = {
      turn: (input) => "admitted" in input.turn ? use(input.turn).pipe(
        Effect.tap(() => Context.getUnsafe(input.services, Sessions) === sessions ? Effect.void : Effect.die("wrong Sessions")),
        Effect.map((outcome) => ({ ...outcome, usage: zeroUsage })),
      ) : Effect.die("attempted a new turn"),
    }
    const context = yield* Layer.build(agentInboxRunner(runner, { services: Context.empty() }).pipe(Layer.provide(Layer.succeed(Sessions, sessions))))
    return Context.get(context, InboxRunner)
  }),
}

describe("agentInboxRunner conforms", () => {
  inboxRunnerConformance(subject).map((check) => test(check.name, () => Effect.runPromise(check.run)))
})

test("the default runner executes the queued message once and leaves its end to the caller", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessionsContext = yield* Layer.build(sessionsLayer())
  const sessions = Context.get(sessionsContext, Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-000000005530"), owner: "runner-journey" }
  yield* sessions.create(address)
  const input = { id: InboxItemId.make("runner-input"), delivery: "next" as const, source: {}, userMessage: new UserMessage({ text: "Run the queued request." }) }
  yield* sessions.enqueue(address, input)
  const seen = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.update(seen, (all) => [...all, JSON.stringify(options.prompt.content)]).pipe(Effect.as([...textReply("Queued request complete.")])),
    streamText: () => Stream.die("not scripted"),
  })
  const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 2 } })
  const wrongSessions = Sessions.of({ ...sessions, read: () => Effect.die("used the per-turn Sessions instead of the drainer's") })
  const services = Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(Sessions, wrongSessions))
  const built = yield* Layer.build(agentInboxRunner(agent, { services }).pipe(Layer.provide(Layer.succeed(Sessions, sessions))))
  const writer = yield* sessions.begin(address, { _tag: "Queued", input: input.id, runId: RunId.make("runner-queued") })
  const result = yield* Context.get(built, InboxRunner).run(writer)
  expect(result).toEqual({ outcome: "completed", reply: Option.some("Queued request complete.") })
  yield* writer.flush
  expect((yield* sessions.read(address, { kinds: ["turn.ended"] })).length).toBe(0)
  const prompts = yield* Ref.get(seen)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain("Run the queued request.")
  yield* writer.end({ reason: result.outcome, failure: Option.none() })
  expect((yield* sessions.get(address)).pending).toBe(0)
  expect((yield* sessions.read(address, { kinds: ["turn.started"] })).length).toBe(1)
}))))
