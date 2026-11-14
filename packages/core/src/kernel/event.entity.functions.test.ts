import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Schema } from "effect"
import { announced, dataOf, isStoredDraft, live, liveEvent, originOf, reasonOf, stored, storedEvent } from "./event.entity.functions.js"
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
    // Each refusal says what is wrong: a learner's page shows the message, and nothing else.
    expect(() => storedEvent("My Plugin", "noted", { tags: ["trace"], data: Noted, skippable: true })).toThrow(`"My Plugin" is not a plugin's name: lowercase letters, digits and hyphens, starting with a letter or a digit`)
    expect(() => storedEvent("notes", "Noted!", { tags: ["trace"], data: Noted, skippable: true })).toThrow(`"Noted!" is not an event's name: words of lowercase letters, digits and hyphens, joined by dots`)
    expect(() => liveEvent("", "noted", { tags: ["trace"], data: Noted })).toThrow(`"" is not a plugin's name: lowercase letters, digits and hyphens, starting with a letter or a digit`)
  })

  test("a stored one becomes a draft, a live one an event; neither passes for the other", () => {
    const draft = stored(noted, { text: "kept", at: Seq.make(4) })
    expect<unknown>({ ...draft }).toEqual({ name: noted.name, data: { text: "kept", at: 4 }, skippable: true, tags: noted.tags })
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
    expect(Object.keys(StoredEvent.fields)).toEqual(["seq", "at", "turn", "name", "data", "skippable", "tags", "message"])
    const summary = stored(noted, { text: "Summary.", at: Seq.make(9) }, { message: { _tag: "User", text: "Summary." } })
    expect(Object.keys(summary)).toEqual(["name", "data", "skippable", "tags", "message"])
    expect(Schema.is(StoredDraft)(summary)).toBe(true)
    expect(Schema.is(StoredEvent)({ seq: Seq.make(10), at: 0, turn: origin.turn, ...summary })).toBe(true)
  })
})

describe("a definition's tags", () => {
  const Noted = Schema.Struct({})

  test("the five reserved words and a plugin's own tag are accepted", () => {
    expect(storedEvent("notes", "noted", { tags: ["conversation", "turn", "memory", "ui", "trace", "notes.kind"], data: Noted, skippable: true }).tags.map(String))
      .toEqual(["conversation", "turn", "memory", "ui", "trace", "notes.kind"])
    expect(liveEvent("notes", "glanced", { tags: ["ui", "notes.kind"], data: Noted }).tags.map(String)).toEqual(["ui", "notes.kind"])
  })

  test("a word that is not reserved does not type, and is refused where the event is defined", () => {
    // A misspelt tag used to be accepted, and its records were then passed over by everything that reads by tag.
    // @ts-expect-error "conversaton" is no reserved tag and no plugin's own
    expect(() => storedEvent("notes", "noted", { tags: ["conversaton"], data: Noted, skippable: true })).toThrow(`"conversaton" is not a tag: the reserved ones are conversation, turn, memory, ui, trace, and a plugin's own is "<plugin>.<tag>"`)
    // @ts-expect-error "live" is no reserved tag and no plugin's own
    expect(() => liveEvent("notes", "glanced", { tags: ["live"], data: Noted })).toThrow(`"live" is not a tag: the reserved ones are conversation, turn, memory, ui, trace, and a plugin's own is "<plugin>.<tag>"`)
  })

  test("another plugin's tag is refused where the event is defined", () => {
    expect(() => storedEvent("notes", "noted", { tags: ["window.kind"], data: Noted, skippable: true })).toThrow(`"window.kind" is not this plugin's tag: the tags of plugin "notes" start with "notes."`)
    expect(() => liveEvent("notes", "glanced", { tags: ["notesx.kind"], data: Noted })).toThrow(`"notesx.kind" is not this plugin's tag: the tags of plugin "notes" start with "notes."`)
    // A tag of no shape at all: an upper-case word, a tag with two dots.
    expect(() => liveEvent("notes", "glanced", { tags: ["notes.a.b"], data: Noted })).toThrow(`"notes.a.b" is not a tag: a tag is one of conversation, turn, memory, ui, trace, or a plugin's own, "<plugin>.<tag>"`)
  })

  test("a stored record with a one-word tag this kernel does not reserve still decodes", () => {
    // The words are checked where a definition is made, never where a journal is read: one record of a later kernel
    // must not fail a whole journal.
    const record = { seq: Seq.make(1), at: 0, turn: origin.turn, name: "plugin.notes.noted", data: {}, skippable: true, tags: ["archive"] }
    expect(Schema.decodeUnknownOption(StoredEvent)(record)._tag).toBe("Some")
  })
})

describe("a draft", () => {
  const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({ text: Schema.String }), skippable: true })

  test("is what `stored` made, and nothing else", () => {
    const draft = stored(noted, { text: "kept" })
    expect(isStoredDraft(draft)).toBe(true)
    expect(isStoredDraft(turnStarted(TurnNumber.make(1)))).toBe(true)
    // An object written by hand with every field of a draft, and a copy of a draft, are not drafts: either could
    // carry other tags or another skip flag than its definition's.
    expect(isStoredDraft({ name: noted.name, data: { text: "kept" }, skippable: true, tags: noted.tags })).toBe(false)
    expect(isStoredDraft({ ...draft })).toBe(false)
    expect(isStoredDraft({ ...draft, skippable: false })).toBe(false)
    expect(isStoredDraft(undefined)).toBe(false)
    // A definition written by hand, or a copy of one with a tag changed, makes no draft: its tags were never checked.
    expect(isStoredDraft(stored({ kind: "stored", name: noted.name, data: Schema.Struct({ text: Schema.String }), skippable: true, tags: noted.tags }, { text: "kept" }))).toBe(false)
    expect(isStoredDraft(stored({ ...noted, tags: [] }, { text: "kept" }))).toBe(false)
  })

  test("carries its mark on no field a store or a listener sees", () => {
    const draft = stored(noted, { text: "kept" })
    expect(JSON.stringify(draft)).toBe(JSON.stringify({ name: noted.name, data: { text: "kept" }, skippable: true, tags: noted.tags }))
    expect(Object.getOwnPropertySymbols({ ...draft })).toEqual([])
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
