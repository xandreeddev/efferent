import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import {
  assistantDeltaEvent,
  assistantMessageEvent,
  requestSentEvent,
  resolveRequest,
  Seq,
  StepNumber,
  Tokens,
  turnEndedEvent,
  turnStartedEvent,
  userMessageEvent,
} from "@xandreed/core/kernel"
import { answering, open, recording, stack } from "./testing.js"

const everyDefinition = [turnStartedEvent, userMessageEvent, requestSentEvent, assistantDeltaEvent, assistantMessageEvent, turnEndedEvent]

describe("one turn of the kernel", () => {
  test("stores five events in order, streams the answer live, and sends the model what the stored request says", async () => {
    const run = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hel", "lo!")
      const record = yield* recording(everyDefinition)
      const agent = yield* open(stack(model, { extras: record.layer }))
      const session = yield* agent.createSession({ owner: "learner" })
      const reply = yield* agent.send(session, "Hello")
      return { reply, session, inspection: yield* agent.inspect(session), seen: yield* record.seen, received: yield* received }
    })))
    expect(run.reply).toEqual({ text: "Hello!" })
    const stored = run.inspection.events
    expect(stored.map((event): string => event.name)).toEqual([
      "plugin.session.turn.started",
      "plugin.loop.user.message",
      "plugin.loop.request.sent",
      "plugin.loop.assistant.message",
      "plugin.session.turn.ended",
    ])
    expect(stored.map((event): number => event.seq)).toEqual([1, 2, 3, 4, 5])
    // Published: each stored event after it was stored, and the deltas live only.
    expect(run.seen.map((event) => `${event._tag} ${event.name}`)).toEqual([
      "Stored plugin.session.turn.started",
      "Stored plugin.loop.user.message",
      "Stored plugin.loop.request.sent",
      "Live plugin.loop.assistant.delta",
      "Live plugin.loop.assistant.delta",
      "Stored plugin.loop.assistant.message",
      "Stored plugin.session.turn.ended",
    ])
    expect(run.seen.every((event) => event.session === run.session && event.turn === 1)).toBe(true)
    // The request is stored as pointers; resolved, it is what the model received.
    expect(stored[2]?.data).toEqual({ step: 1, system: "You are a friendly tutor.", messages: [2], estimatedTokens: 9, budgetTokens: 3000 })
    const sent = run.inspection.requests[0]
    const messages = Result.getOrThrow(resolveRequest(stored, { messages: [Seq.make(2)] }, Seq.make(3)))
    expect(sent).toEqual({ seq: Seq.make(3), step: StepNumber.make(1), system: "You are a friendly tutor.", messages, estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) })
    expect(run.received).toEqual([[{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "Hello" }]])
    expect(sent?.messages.map(({ message }) => ({ role: message._tag.toLowerCase(), text: message.text }))).toEqual(run.received[0]?.slice(1))
    expect(stored[4]?.data).toEqual({ turn: 1, outcome: { _tag: "Completed" } })
    expect(run.inspection.state).toEqual({ _tag: "Free", turns: 1 })
  })

  test("a session asked for with no owner, or a parent that is no id, is refused by the session plugin", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const agent = yield* open(stack(model))
      return {
        noOwner: yield* Effect.flip(agent.createSession({ owner: "" })),
        blankOwner: yield* Effect.flip(agent.createSession({ owner: "   " })),
        noParent: yield* Effect.flip(agent.createSession({ owner: "learner", parent: "" })),
        child: yield* Effect.flatMap(agent.createSession({ owner: "learner" }), (parent) =>
          Effect.flatMap(agent.createSession({ owner: "learner", parent }), (child) => Effect.map(agent.inspect(child), (inspection) => inspection.header.parent === parent))),
      }
    })))
    expect(result.noOwner).toMatchObject({ _tag: "InvalidSession" })
    expect(result.blankOwner).toMatchObject({ _tag: "InvalidSession" })
    expect(result.noParent).toMatchObject({ _tag: "InvalidSession" })
    expect(result.child).toBe(true)
  })
})
