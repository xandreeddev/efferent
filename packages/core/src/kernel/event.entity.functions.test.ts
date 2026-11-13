import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Schema } from "effect"
import { announced, dataOf, live, liveEvent, originOf, reasonOf, stored, storedEvent } from "./event.entity.functions.js"
import { KernelEvent, ListenerFailed, StoredDraft, StoredEvent } from "./event.entity.js"
import type { StoredDefinition } from "./event.entity.js"
import { Seq, SessionId, TurnNumber } from "./ids.entity.js"
import { listenerFailed, outcomeOf, turnEnded, turnStarted } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent, turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(2) }

describe("core's own events", () => {
  test("are named `core.`, after the contract that defines them: the session's are stored, the listener's failure live", () => {
    expect([turnStartedEvent, turnEndedEvent, listenerFailedEvent].map((definition) => `${definition.kind} ${definition.name}`)).toEqual([
      "stored core.session.turn.started",
      "stored core.session.turn.ended",
      "live core.listener.failed",
    ])
  })

  test("each constructor's data reads back through its definition's schema", () => {
    const table: ReadonlyArray<readonly [StoredDefinition<Schema.Json>, StoredDraft, Schema.Json]> = [
      [turnStartedEvent, turnStarted(TurnNumber.make(3)), { turn: 3 }],
      [turnEndedEvent, turnEnded(TurnNumber.make(3), { _tag: "Failed", reason: "AiError: down" }), { turn: 3, outcome: { _tag: "Failed", reason: "AiError: down" } }],
    ]
    table.forEach(([definition, draft, data]) => {
      expect(draft.name).toBe(definition.name)
      expect(draft.skippable).toBe(false)
      expect(dataOf(definition, draft)).toEqual(Option.some(data))
      expect(Schema.is(StoredDraft)(draft)).toBe(true)
      expect(draft.message).toBeUndefined()
    })
    const failure = new ListenerFailed({ listener: "audit", event: turnEndedEvent.name, message: "the audit log is full" })
    const about = announced(origin, { seq: Seq.make(4), at: 0, turn: origin.turn, ...turnEnded(TurnNumber.make(2), { _tag: "Completed" }) })
    expect(listenerFailed(about, failure)).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: listenerFailedEvent.name, tags: listenerFailedEvent.tags, data: { listener: "audit", event: turnEndedEvent.name, reason: "the audit log is full" } })
  })
})

describe("a plugin's own events", () => {
  const Noted = Schema.Struct({ text: Schema.String, at: Seq })
  const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Noted, skippable: true })
  const glanced = liveEvent("notes", "glanced", { tags: ["trace"], data: Schema.Struct({ text: Schema.String }) })

  test("are named under the plugin's prefix, with what the definition says of them", () => {
    expect(noted).toMatchObject({ kind: "stored", name: "plugin.notes.noted", skippable: true })
    expect(glanced).toMatchObject({ kind: "live", name: "plugin.notes.glanced" })
    expect(String(storedEvent("my-plugin", "a.b-c", { tags: ["trace"], data: Noted, skippable: false }).name)).toBe("plugin.my-plugin.a.b-c")
  })

  test("a name that is no plugin's or no event's is refused where the event is defined", () => {
    expect(() => storedEvent("My Plugin", "noted", { tags: ["trace"], data: Noted, skippable: true })).toThrow()
    expect(() => storedEvent("notes", "Noted!", { tags: ["trace"], data: Noted, skippable: true })).toThrow()
    expect(() => liveEvent("", "noted", { tags: ["trace"], data: Noted })).toThrow()
  })

  test("a stored one becomes a draft, a live one an event; neither passes for the other", () => {
    const draft = stored(noted, { text: "kept", at: Seq.make(4) })
    expect(draft).toEqual({ name: noted.name, data: { text: "kept", at: 4 }, skippable: true, tags: noted.tags })
    expect(live(glanced, origin, { text: "seen" })).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: glanced.name, tags: glanced.tags, data: { text: "seen" } })
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
    expect(aboutSession).toEqual({ _tag: "Live", session: origin.id, name: glanced.name, tags: glanced.tags, data: { text: "queued" } })
    expect("turn" in aboutSession).toBe(false)
    expect(Schema.is(KernelEvent)(aboutSession)).toBe(true)
    // An event made about it keeps to the same origin: a session, and no turn.
    expect(live(glanced, originOf(aboutSession), { text: "seen" })).toEqual({ _tag: "Live", session: origin.id, name: glanced.name, tags: glanced.tags, data: { text: "seen" } })
    expect(originOf(live(glanced, origin, { text: "seen" }))).toEqual(origin)
  })

  test("its data reads back only as its own definition describes it", () => {
    const kept = { seq: Seq.make(7), at: 0, turn: origin.turn, ...stored(noted, { text: "kept", at: Seq.make(4) }) }
    expect(dataOf(noted, kept)).toEqual(Option.some({ text: "kept", at: Seq.make(4) }))
    expect(dataOf(turnStartedEvent, kept)).toEqual(Option.none())
    expect(dataOf(noted, { ...kept, data: { text: 4 } })).toEqual(Option.none())
    expect(announced(origin, kept)).toEqual({ _tag: "Stored", session: origin.id, ...kept })
  })

  test("the envelope holds the name, the data, the skip flag, the tags and the message, and nothing of what a message stands for", () => {
    // What a record's message replaces, or any other meaning a plugin gives it, is that plugin's own data.
    expect(Object.keys(StoredDraft.fields)).toEqual(["name", "data", "skippable", "tags", "message"])
    expect(Object.keys(StoredEvent.fields)).toEqual(["seq", "at", "turn", "name", "data", "skippable", "tags", "message"])
    const summary = stored(noted, { text: "Summary.", at: Seq.make(9) }, { message: { _tag: "User", text: "Summary." } })
    expect(Schema.is(StoredDraft)(summary)).toBe(true)
    expect(Schema.is(StoredEvent)({ seq: Seq.make(10), at: 0, turn: origin.turn, ...summary })).toBe(true)
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
