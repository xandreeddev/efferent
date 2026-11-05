import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, Failure, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { SessionAddress, SessionLogEvent, Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A journey, key-free, with a scripted model: while a turn waits in a tool
 * call for the user's approval, the host records the approval outside the
 * turn under the request's idempotency key, and the client, timing out,
 * sends the same request again. The approval is recorded once, the retry
 * answered with it, and the turn goes on writing beside it to its end.
 */

const Propose = Tool.make("propose", {
  description: "Propose a change and wait for the user's approval.",
  parameters: Schema.Struct({ change: Schema.String }),
  success: Schema.Struct({ proposal: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

/** `propose` says it started, then waits until the host has answered the approval requests. */
const toolsOf = (proposing: Deferred.Deferred<void>, answered: Deferred.Deferred<void>) => defineCapability({
  id: "journey-host", version: "1",
  tools: [defineTool({
    tool: Propose,
    handler: ({ change }) => Deferred.succeed(proposing, undefined).pipe(Effect.andThen(Deferred.await(answered)), Effect.as({ proposal: `proposal for ${change}` })),
  })],
  skills: [defineSkill({ id: "changes", summary: "Propose changes for approval.", tools: ["propose"], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const script: ReadonlyArray<Part> = [
  [{ type: "tool-call", id: "c1", name: "propose", params: { change: "rename the record" } }, { type: "finish", reason: "tool-calls", usage }],
  [{ type: "text", text: "The change is proposed." }, { type: "finish", reason: "stop", usage }],
]

/** A scripted provider: its answers in order, and the prompt of every request it was sent. */
const scripted = Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.map((index) => script[index] as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { prompts, model }
})

const answer = (turn: Turn) => Effect.gen(function* () {
  yield* turn.tools.select(turn.userMessage)
  const result = yield* turn.run({})
  return { outcome: result.outcome, reply: Option.some(result.text) } satisfies TurnOutcome
})

const session: SessionAddress = { id: ConversationId.make("00000000-0000-4000-8000-0000000000ab"), owner: "journey" }
const where = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}#${event.seq}`).join()

describe("journey: a host action retried beside an open turn", () => {
  test("is recorded once under its key, the retry answered with the first one's events, and the turn writes on to its end", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const proposing = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
        capabilities: [toolsOf(proposing, answered)],
        turnServices: [LanguageModel.LanguageModel],
        limits: { streaming: false, maxSteps: 4 },
      })
      const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
      yield* sessions.create(session)
      const { prompts, model } = yield* scripted

      // 1. ask: the model proposes a change, and the tool waits for the user.
      const asking = yield* Effect.forkChild(agent.turn({
        turn: { session, userMessage: new UserMessage({ text: "rename the record" }), runId: RunId.make("run-1") },
        services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
      }, answer))
      yield* Deferred.await(proposing)

      // 2. the user approves (request 7), and the client sends request 7 again: the host records each under the request's id.
      const decided = yield* Ref.make(0)
      const approve = sessions.transact(session, (view) => Ref.update(decided, (count) => count + 1).pipe(Effect.as({
        drafts: [{ kind: "journey.approved", data: { proposal: "c1" } }],
        result: Option.map(view.open, (open) => open.turn),
      })), { key: "request-7", command: { approve: "c1" } })
      const approved = yield* approve
      const retried = yield* Effect.flip(approve)
      yield* Deferred.succeed(answered, undefined)

      // 3. the turn goes on: the tool returns, the model answers, the turn ends.
      const done = yield* Fiber.join(asking)
      return { approved, retried, done, decided: yield* Ref.get(decided), prompts: yield* Ref.get(prompts), all: yield* sessions.read(session) }
    })))

    // 2. The approval saw turn 1 open and recorded once; the retry decided nothing and was answered with its events.
    expect(observed.approved.result).toEqual(Option.some(1))
    expect(observed.decided).toBe(1)
    expect(observed.retried._tag).toBe("TransactDuplicate")
    expect(observed.retried._tag === "TransactDuplicate" ? where(observed.retried.events) : "").toBe(where(observed.approved.events))
    const approvals = observed.all.filter((event) => event.kind === "journey.approved")
    expect(where(approvals)).toBe(where(observed.approved.events))
    // The key's record opens the approval's commit, outside any turn.
    const keyed = observed.all.filter((event) => event.kind === "transact.keyed")
    expect(keyed.map((event) => [event.seq, Option.getOrNull(event.turn), event.data])).toEqual([[approvals[0]!.seq - 1, null, { key: "request-7", command: { approve: "c1" }, events: 1 }]])

    // 3. The turn wrote beside the approval to its end, and the model never saw the host's record.
    expect(observed.done.outcome).toBe("completed")
    expect(observed.done.reply).toEqual(Option.some("The change is proposed."))
    const after = observed.all.filter((event) => event.seq > approvals[0]!.seq).map((event) => event.kind)
    expect(after).toContain("tool.completed")
    expect(after.at(-1)).toBe("turn.ended")
    expect(observed.prompts).toHaveLength(2)
    expect(observed.prompts.some((prompt) => prompt.includes("journey.approved") || prompt.includes("request-7"))).toBe(false)
  })
})
