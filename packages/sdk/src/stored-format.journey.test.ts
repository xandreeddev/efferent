import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, harnessCodeOf, RunId, SessionLog, SessionLogMemoryLive, Sessions, STORED_FORMAT, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { JsonObject, Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A journey, key-free: a session a newer release wrote is not run by this
 * one. A turn runs; then the session's head is stamped with the next stored
 * format, as that release would leave it, and the next turn fails to begin
 * with `session.version` before the model is asked anything.
 */

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
/** One run of the step loop; the turn's reply is the run's outcome, nothing more. */
const oneRun = (turn: Turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.none<string>() }) satisfies TurnOutcome))
const session = { id: ConversationId.make("00000000-0000-4000-8000-0000000000f1"), owner: "journey" }

describe("journey: a session a newer release wrote", () => {
  test("refuses the next turn with session.version, the model unasked and nothing stored", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const asked = yield* Ref.make(0)
      const model = yield* LanguageModel.make({
        generateText: () => Ref.update(asked, (count) => count + 1).pipe(Effect.as([{ type: "text", text: "hello" }, { type: "finish", reason: "stop", usage }] as never)),
        streamText: () => Stream.die("not scripted") as never,
      })
      const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
      const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))), Sessions)
      const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false } })
      const services = Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))
      yield* sessions.create({ owner: session.owner, id: session.id })

      const first = yield* agent.turn({ turn: { session, userMessage: new UserMessage({ text: "hi" }), runId: RunId.make("run-1") }, services }, oneRun)
      const stamped = yield* log.head(session.id)
      yield* log.commit(session.id, {
        expect: stamped.revision,
        notAfter: Option.none(),
        events: [],
        state: Option.some({ ...stamped.state, sessions: { ...(stamped.state["sessions"] as JsonObject), format: STORED_FORMAT + 1 } }),
      })
      const before = yield* log.head(session.id)
      const refused = yield* Effect.flip(agent.turn({ turn: { session, userMessage: new UserMessage({ text: "again" }), runId: RunId.make("run-2") }, services }, oneRun))
      const after = yield* log.head(session.id)
      return { first: first.outcome, refused, asked: yield* Ref.get(asked), before, after, view: yield* sessions.get(session) }
    })))

    expect(observed.first).toBe("completed")
    // A store failure: the framework's code is session.log, the error's own says why.
    expect([observed.refused._tag, Option.getOrNull(harnessCodeOf(observed.refused)), observed.refused._tag === "SessionLogError" ? observed.refused.code : null])
      .toEqual(["SessionLogError", "session.log", "session.version"])
    expect(observed.asked).toBe(1)
    expect([observed.after.revision, observed.after.seq]).toEqual([observed.before.revision, observed.before.seq])
    // The session is still read: one turn, ended.
    expect([observed.view.turns, Option.isNone(observed.view.open)]).toEqual([1, true])
  })
})
