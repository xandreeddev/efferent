import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { assistantMessageEvent, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import { answering, open, recording, stack, pieceEvent } from "./testing.js"

const everyDefinition = [turnStartedEvent, userMessageEvent, pieceEvent, assistantMessageEvent, turnEndedEvent]

describe("one turn of the kernel", () => {
  test("stores four events in order, streams the answer live, and sends the model the system text and the conversation", async () => {
    const run = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hel", "lo!")
      const record = yield* recording(everyDefinition)
      const agent = yield* open(stack(model, { extras: record.layer }))
      const session = yield* agent.createSession({ owner: "learner" })
      const reply = yield* agent.send(session, "Hello")
      return { reply, session, inspection: yield* agent.inspect(session), seen: yield* record.seen, received: yield* received }
    })))
    expect(run.reply).toEqual("Hello!")
    const stored = run.inspection.events
    expect(stored.map((event): string => event.name)).toEqual([
      "core.session.turn.started",
      "conversation.user.message",
      "conversation.assistant.message",
      "core.session.turn.ended",
    ])
    expect(stored.map((event): number => event.seq)).toEqual([1, 2, 3, 4])
    // Every record names its turn, and says what it is for.
    expect(stored.map((event) => `${event.turn} ${event.tags.join(",")}`)).toEqual(["1 turn", "1 conversation", "1 conversation", "1 turn"])
    // Published: each stored event after it was stored, and the deltas live only.
    expect(run.seen.map((event) => `${event._tag} ${event.name}`)).toEqual([
      "Stored core.session.turn.started",
      "Stored conversation.user.message",
      "Live plugin.test.piece",
      "Live plugin.test.piece",
      "Stored conversation.assistant.message",
      "Stored core.session.turn.ended",
    ])
    expect(run.seen.every((event) => event.session === run.session && event.turn === 1)).toBe(true)
    // Nothing about the request is stored: the system text is the loop's, and the model was sent it first, then the conversation.
    expect(run.received).toEqual([[{ role: "system", text: "You are a friendly tutor." }, { role: "user", text: "Hello" }]])
    expect(JSON.stringify(stored)).not.toContain("You are a friendly tutor.")
    // The answer's metadata: what the provider reported it cost.
    expect(stored[2]?.data).toEqual({ usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 } })
    expect(stored[3]?.data).toEqual({ turn: 1, outcome: { _tag: "Completed" } })
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
