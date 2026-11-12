import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Schema } from "effect"
import { announced, dataOf, live, liveEvent, originOf, reasonOf, stored, storedEvent } from "./event.entity.functions.js"
import { KernelEvent, StoredDraft, StoredEvent } from "./event.entity.js"
import type { StoredDefinition } from "./event.entity.js"
import { firstStep } from "./ids.entity.functions.js"
import { Seq, SessionId, Tokens, TurnNumber } from "./ids.entity.js"
import { assistantDelta, assistantMessage, outcomeOf, requestSent, turnEnded, turnStarted, userMessage } from "./vocabulary.entity.functions.js"
import {
  assistantDeltaEvent,
  assistantMessageEvent,
  listenerFailedEvent,
  requestSentEvent,
  turnEndedEvent,
  turnStartedEvent,
  userMessageEvent,
} from "./vocabulary.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(2) }

describe("the kernel's own events", () => {
  test("are named by the plugin that writes them, stored but the delta and core's own", () => {
    expect([turnStartedEvent, turnEndedEvent, userMessageEvent, requestSentEvent, assistantMessageEvent, assistantDeltaEvent, listenerFailedEvent].map((definition) => `${definition.kind} ${definition.name}`)).toEqual([
      "stored plugin.session.turn.started",
      "stored plugin.session.turn.ended",
      "stored plugin.loop.user.message",
      "stored plugin.loop.request.sent",
      "stored plugin.loop.assistant.message",
      "live plugin.loop.assistant.delta",
      "live core.listener.failed",
    ])
  })

  test("each constructor's data reads back through its definition's schema", () => {
    const request = { messages: [Seq.make(2)], estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) }
    const table: ReadonlyArray<readonly [StoredDefinition<Schema.Json>, StoredDraft, Schema.Json]> = [
      [turnStartedEvent, turnStarted(TurnNumber.make(3)), { turn: 3 }],
      [turnEndedEvent, turnEnded(TurnNumber.make(3), { _tag: "Failed", reason: "AiError: down" }), { turn: 3, outcome: { _tag: "Failed", reason: "AiError: down" } }],
      [userMessageEvent, userMessage("Hello"), {}],
      [requestSentEvent, requestSent(firstStep, "Be brief.", request), { step: 1, system: "Be brief.", messages: [2], estimatedTokens: 9, budgetTokens: 3000 }],
      [assistantMessageEvent, assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }), { step: 1 }],
    ]
    table.forEach(([definition, draft, data]) => {
      expect(draft.name).toBe(definition.name)
      expect(draft.skippable).toBe(false)
      expect(dataOf(definition, draft)).toEqual(Option.some(data))
      expect(Schema.is(StoredDraft)(draft)).toBe(true)
    })
    expect(userMessage("Hello").message).toEqual({ _tag: "User", text: "Hello" })
    expect(assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }).message).toEqual({ _tag: "Assistant", text: "Hi", toolCalls: [] })
    expect(assistantDelta(origin, "Hel")).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: assistantDeltaEvent.name, data: { text: "Hel" } })
  })
})

describe("a plugin's own events", () => {
  const Noted = Schema.Struct({ text: Schema.String, at: Seq })
  const noted = storedEvent("notes", "noted", { data: Noted, skippable: true })
  const glanced = liveEvent("notes", "glanced", { data: Schema.Struct({ text: Schema.String }) })

  test("are named under the plugin's prefix, with what the definition says of them", () => {
    expect(noted).toMatchObject({ kind: "stored", name: "plugin.notes.noted", skippable: true })
    expect(glanced).toMatchObject({ kind: "live", name: "plugin.notes.glanced" })
    expect(String(storedEvent("my-plugin", "a.b-c", { data: Noted, skippable: false }).name)).toBe("plugin.my-plugin.a.b-c")
  })

  test("a name that is no plugin's or no event's is refused where the event is defined", () => {
    expect(() => storedEvent("My Plugin", "noted", { data: Noted, skippable: true })).toThrow()
    expect(() => storedEvent("notes", "Noted!", { data: Noted, skippable: true })).toThrow()
    expect(() => liveEvent("", "noted", { data: Noted })).toThrow()
  })

  test("a stored one becomes a draft, a live one an event; neither passes for the other", () => {
    const draft = stored(noted, { text: "kept", at: Seq.make(4) })
    expect(draft).toEqual({ name: noted.name, data: { text: "kept", at: 4 }, skippable: true })
    expect(live(glanced, origin, { text: "seen" })).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: glanced.name, data: { text: "seen" } })
    // The kind is in the type: a live definition makes no draft, and a stored one no live event.
    // @ts-expect-error a live-only definition cannot be stored
    expect(() => stored(glanced, { text: "seen" })).not.toThrow()
    // @ts-expect-error a stored definition is not published live-only
    expect(() => live(noted, origin, { text: "kept", at: Seq.make(4) })).not.toThrow()
    // @ts-expect-error the data is what the definition's schema describes
    expect(() => stored(noted, { text: 4 })).not.toThrow()
  })

  test("a live one about a session and no turn of it names no turn, and is a kernel event all the same", () => {
    const aboutSession = live(glanced, { id: origin.id }, { text: "queued" })
    expect(aboutSession).toEqual({ _tag: "Live", session: origin.id, name: glanced.name, data: { text: "queued" } })
    expect("turn" in aboutSession).toBe(false)
    expect(Schema.is(KernelEvent)(aboutSession)).toBe(true)
    // An event made about it keeps to the same origin: a session, and no turn.
    expect(live(glanced, originOf(aboutSession), { text: "seen" })).toEqual({ _tag: "Live", session: origin.id, name: glanced.name, data: { text: "seen" } })
    expect(originOf(live(glanced, origin, { text: "seen" }))).toEqual(origin)
  })

  test("its data reads back only as its own definition describes it", () => {
    const kept = { seq: Seq.make(7), at: 0, ...stored(noted, { text: "kept", at: Seq.make(4) }) }
    expect(dataOf(noted, kept)).toEqual(Option.some({ text: "kept", at: Seq.make(4) }))
    expect(dataOf(turnStartedEvent, kept)).toEqual(Option.none())
    expect(dataOf(noted, { ...kept, data: { text: 4 } })).toEqual(Option.none())
    expect(announced(origin, kept)).toEqual({ _tag: "Stored", session: origin.id, turn: origin.turn, ...kept })
  })

  test("a record that replaces a run of the journal bears the message that stands for it", () => {
    const replaces = { from: Seq.make(2), through: Seq.make(9) }
    const summary = stored(noted, { text: "", at: Seq.make(0) }, { message: { _tag: "User", text: "Summary." }, replaces })
    expect(Schema.is(StoredDraft)(summary)).toBe(true)
    expect(Schema.is(StoredEvent)({ seq: Seq.make(10), at: 0, ...summary })).toBe(true)
    expect(Schema.is(StoredDraft)(stored(noted, { text: "", at: Seq.make(0) }, { replaces }))).toBe(false)
  })
})

describe("how a turn ended", () => {
  class Down extends Schema.TaggedError<Down>()("Down", { message: Schema.String }) {}

  test("is told from its exit: completed, failed with the failure's tag and message, or interrupted", () => {
    expect(outcomeOf(Exit.succeed("any value"))).toEqual({ _tag: "Completed" })
    expect(outcomeOf(Exit.fail(new Down({ message: "the model is down" })))).toEqual({ _tag: "Failed", reason: "Down: the model is down" })
    expect(outcomeOf(Exit.failCause(Cause.interrupt()))).toEqual({ _tag: "Interrupted" })
    expect(outcomeOf(Exit.die("a bug"))).toEqual({ _tag: "Failed", reason: "defect" })
  })

  test("a failure's words hold no stack", () => {
    expect(reasonOf(Cause.fail(new Down({ message: "the model is down" })))).toBe("Down: the model is down")
    expect(reasonOf(Cause.fail("a bare string"))).toBe("")
    expect(reasonOf(Cause.interrupt())).toBe("interrupted")
  })
})
