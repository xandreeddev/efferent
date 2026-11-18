import { describe, expect, test } from "bun:test"
import { Option, Predicate } from "effect"
import type { Schema } from "effect"
import type { StoredDraft } from "@xandreed/core/kernel"
import { EntityId, MemoryId, SourceId } from "./knowledge.entity.js"
import type { Curation, ShownKnowledge, SourcePart, Staged } from "./knowledge.entity.js"
import { endedBy, knowledgeOf } from "./knowledge.entity.functions.js"
import { curationOf, draftsOf, DROPPED_BECAUSE, staged } from "./knowledge-curation.entity.functions.js"
import { aliased, called, ended, entity, journalOf, memory, noon, parts, source } from "./knowledge.testing.js"

const EMPTY = `{"entities":[],"aliases":[],"memories":[],"restates":[],"forget":[]}`

/** A reply read, or a failed test. */
const read = (reply: string) => Option.getOrThrow(curationOf(reply))

/** A curation from a reply written as a value: what a model would send, in a test's few words. */
const curation = (reply: { readonly entities?: unknown; readonly aliases?: unknown; readonly memories?: unknown; readonly restates?: unknown; readonly forget?: unknown }): Curation =>
  read(JSON.stringify(reply)).curation

describe("a curator's reply, read", () => {
  test("a whole reply is read as its five lists", () => {
    const { curation: one, malformed } = read(`{"entities":[{"key":"a","name":"Braga","kind":"place"}],"aliases":[{"id":"n3","alias":"Oporto"}],"memories":[{"kind":"fact","text":"Ana Silva lives in Braga since 2026-10.","about":["n2","a"],"quote":"she moved to Braga last month","by":"user","on":"2026-10","ends":["m1"],"why":"changed"}],"restates":[{"id":"m2","quote":"really into green tea"}],"forget":["m9"]}`)
    expect(malformed).toBe(0)
    expect<unknown>(one).toEqual({
      entities: [{ key: "a", name: "Braga", kind: "place" }],
      aliases: [{ id: "n3", alias: "Oporto" }],
      memories: [{ kind: "fact", text: "Ana Silva lives in Braga since 2026-10.", about: ["n2", "a"], quote: "she moved to Braga last month", by: "user", on: Option.some("2026-10"), ends: ["m1"], why: Option.some("changed") }],
      restates: [{ id: "m2", quote: "really into green tea" }],
      forget: ["m9"],
    })
  })

  test("a code fence and words around the object are passed over", () => {
    expect(read("```json\n" + EMPTY + "\n```").curation).toEqual(read(EMPTY).curation)
    expect(read(`Here is the update:\n${EMPTY}\nLet me know if you need more.`).curation).toEqual(read(EMPTY).curation)
  })

  test("a reply with no object, or one that is no JSON, reads as none", () => {
    expect(["", "I could not find anything to store.", "}{", `{"entities": [`, `{"entities": [}`, `["m1"]`].map((reply) => Option.isNone(curationOf(reply)))).toEqual([true, true, true, true, true, true])
  })

  test("a list that is missing, or is no list, is empty", () => {
    expect(read("{}")).toEqual({ curation: { entities: [], aliases: [], memories: [], restates: [], forget: [] }, malformed: 0 })
    expect(read(`{"entities":"none","aliases":null,"memories":{},"restates":3,"forget":"m1","other":[1]}`)).toEqual(read("{}"))
  })

  test("an item of the wrong shape is left out and counted, and the rest of the reply is kept", () => {
    const { curation: one, malformed } = read(JSON.stringify({
      entities: [{ key: "a", name: "Braga", kind: "place" }, { key: "b" }, "Braga", { key: "", name: "Porto" }, { key: "c", name: "  " }],
      aliases: [{ id: "n3", alias: "Oporto" }, { id: "n3" }, { id: 3, alias: "Oporto" }, null],
      memories: [
        { text: "Ana Silva lives in Braga.", quote: "moved to Braga", about: ["n2"] },
        { text: "No quote.", about: [] }, { quote: "No text.", about: [] }, { text: "No about.", quote: "q" }, { text: "About is no list.", quote: "q", about: "n2" }, 7,
      ],
      restates: [{ id: "m2", quote: "green tea" }, "m2", { quote: "no id" }],
      forget: ["m9", 9, "", { id: "m9" }],
    }))
    expect(malformed).toBe(4 + 3 + 5 + 2 + 3)
    expect(one.entities.map((entity) => entity.name)).toEqual(["Braga"])
    expect(one.aliases.map((alias) => alias.alias)).toEqual(["Oporto"])
    expect(one.memories.map((memory) => memory.text)).toEqual(["Ana Silva lives in Braga."])
    expect<unknown>(one.restates).toEqual([{ id: "m2", quote: "green tea" }])
    expect<unknown>(one.forget).toEqual(["m9"])
  })

  test("what an item lacks gets a default, and names and sentences lose the spaces around them", () => {
    const { curation: one, malformed } = read(JSON.stringify({
      entities: [{ key: " a ", name: "  Braga " }, { key: "b", name: "Kiwi", kind: 7 }],
      aliases: [{ id: " n3 ", alias: " Oporto " }],
      memories: [{ text: " The launch was moved. ", quote: " launch moved ", about: [" n1 ", 3, ""], kind: null, by: 5, ends: "m1", on: 20261120, why: ["changed"] }],
      restates: [{ id: " m2 " }, { id: "m3", quote: 4 }],
      forget: [" m9 "],
    }))
    expect(malformed).toBe(0)
    expect<unknown>(one).toEqual({
      entities: [{ key: "a", name: "Braga", kind: "thing" }, { key: "b", name: "Kiwi", kind: "thing" }],
      aliases: [{ id: "n3", alias: "Oporto" }],
      // The quote is kept as written: it is compared with the source, whatever its spacing.
      memories: [{ kind: "fact", text: "The launch was moved.", about: ["n1"], quote: " launch moved ", by: "user", on: Option.none(), ends: [], why: Option.none() }],
      restates: [{ id: "m2", quote: "" }, { id: "m3", quote: "" }],
      forget: ["m9"],
    })
  })
})

/** What is stored, and all of it shown: the user, two Anas, Lisbon and Porto, a parrot, and five memories, one of them ended. */
const journal = journalOf(
  source("s1"),
  entity("n2", "Ana Silva"), entity("n3", "Porto", "place"), entity("n4", "Lisbon", "place"), entity("n5", "Pip", "pet"), entity("n6", "Carla Mendes"), entity("n7", "Globex", "organization"),
  aliased("n4", "Lisboa"),
  memory("m1", "Ana Silva lives in Porto.", ["n2", "n3"]),
  memory("m2", "Ana Silva has a parrot called Pip.", ["n2", "n5"]),
  memory("m3", "Carla Mendes works at Globex.", ["n6", "n7"]),
  memory("m4", "The user's order QX-77120 shipped with DHL.", ["n1"], { kind: "event", by: "tool" }),
  memory("m5", "Ana Silva lived in Faro.", ["n2"]),
  ended("m5", "changed", { by: "m1" }),
)
const knowledge = knowledgeOf(journal)
const shown: ShownKnowledge = { entities: knowledge.entities, memories: knowledge.memories }

/** A turn: what the user said, a tool's result, and the assistant's answer. */
const turn: { readonly said: ReadonlyArray<SourcePart> } = {
  said: parts(
    ["user", "And she moved to Braga last month. She just got a second parrot, called Kiwi."],
    called(`lookupOrder, called with {"order":"QX-77120"}`, `{"status":"shipped","carrier":"DHL","eta":"2026-11-18"}`),
    ["assistant", "Noted. With a surname like Silva she may have grown up in Portugal."],
  ),
}

const stage = (reply: Parameters<typeof curation>[0], said = turn, seen = shown): Staged => staged(curation(reply), said, seen)
const what = (one: Staged) => one.dropped.map((dropped) => `${dropped.what}: ${dropped.why}`)
const told = (one: Staged) => one.memories.map((made) => made.text)
const braga = { kind: "fact", text: "Ana Silva lives in Braga since 2026-10.", about: ["n2", "a"], quote: "she moved to Braga last month", by: "user" }

describe("what of a curation is stored", () => {
  test("a good reply is kept whole: a new entity, an alias, a memory that ends the one it replaces, a restatement and a forgetting", () => {
    const one = stage({
      entities: [{ key: "a", name: "Braga", kind: "place" }],
      aliases: [{ id: "n3", alias: "Oporto" }],
      memories: [{ ...braga, on: "2026-10", ends: ["m1"], why: "changed" }],
      restates: [{ id: "m2", quote: "a second parrot" }],
      forget: ["m4"],
    })
    expect<unknown>(one).toEqual({
      entities: [{ key: "a", name: "Braga", kind: "place" }],
      aliases: [{ id: "n3", alias: "Oporto" }],
      memories: [{
        kind: "fact", text: "Ana Silva lives in Braga since 2026-10.", about: [{ _tag: "Stored", id: "n2" }, { _tag: "New", key: "a" }], quote: "she moved to Braga last month", by: "user",
        on: Option.some("2026-10"), ends: ["m1"], why: "changed",
      }],
      restates: [{ id: "m2", quote: "a second parrot" }],
      forget: ["m4"],
      dropped: [],
    })
  })

  test("a new entity whose name a shown entity bears, by name or alias, whatever the case and accents, is that entity", () => {
    const one = stage({
      entities: [{ key: "a", name: "ANA SILVA", kind: "person" }, { key: "b", name: "lisboa", kind: "place" }, { key: "c", name: "me", kind: "person" }],
      memories: [{ kind: "fact", text: "Ana Silva and the user moved to Lisbon.", about: ["a", "b", "c"], quote: "she moved", by: "user" }],
    })
    expect(one.entities).toEqual([])
    expect<unknown>(one.memories[0]?.about).toEqual([{ _tag: "Stored", id: "n2" }, { _tag: "Stored", id: "n4" }, { _tag: "Stored", id: "n1" }])
    expect(one.dropped).toEqual([])
  })

  test("a stored entity proposed again under another shown entity's id does not take that id over", () => {
    // n3 is Porto. The reply gives Ana Silva, who is n2, the key n3, and writes a memory about n3.
    const one = stage({
      entities: [{ key: "n3", name: "Ana Silva", kind: "person" }, { key: "n2", name: "ana silva", kind: "person" }],
      memories: [{ kind: "fact", text: "Porto is where she moved from.", about: ["n3"], quote: "she moved", by: "user" }, { kind: "fact", text: "Ana Silva moved.", about: ["n2"], quote: "she moved", by: "user" }],
    })
    expect(one.entities).toEqual([])
    expect<unknown>(one.memories.map((made) => made.about)).toEqual([[{ _tag: "Stored", id: "n3" }], [{ _tag: "Stored", id: "n2" }]])
    expect(one.dropped).toEqual([])
  })

  test("an entity said twice in one reply is one entity, and both keys name it", () => {
    const one = stage({
      entities: [{ key: "a", name: "Kiwi", kind: "pet" }, { key: "b", name: "kiwi", kind: "thing" }],
      memories: [{ kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2", "a", "b"], quote: "a second parrot, called Kiwi", by: "user" }],
    })
    expect<unknown>(one.entities).toEqual([{ key: "a", name: "Kiwi", kind: "pet" }])
    expect<unknown>(one.memories[0]?.about).toEqual([{ _tag: "Stored", id: "n2" }, { _tag: "New", key: "a" }])
    expect(one.dropped).toEqual([])
  })

  test.each([
    ["a name of more than 80 characters", { key: "a", name: "B".repeat(81) }, `entity "${"B".repeat(80)}" [… 1 characters clipped]`, DROPPED_BECAUSE.entityName],
    ["a name of two lines", { key: "a", name: "Braga\nPortugal" }, `entity "Braga\\nPortugal"`, DROPPED_BECAUSE.entityName],
    ["a name with no letter or digit", { key: "a", name: "?!" }, `entity "?!"`, DROPPED_BECAUSE.entityName],
    ["a key that is a shown entity's id", { key: "n2", name: "Braga" }, `entity "Braga"`, DROPPED_BECAUSE.entityKey],
  ])("a new entity with %s is dropped", (_case, proposed, dropped, why) => {
    const one = stage({ entities: [proposed, { key: "k", name: "Kiwi", kind: "pet" }] })
    expect<unknown>(one.entities).toEqual([{ key: "k", name: "Kiwi", kind: "pet" }])
    expect(one.dropped).toEqual([{ what: dropped, why }])
  })

  test("a second new entity under a key already taken is dropped, and the first is kept", () => {
    const one = stage({ entities: [{ key: "a", name: "Braga", kind: "place" }, { key: "a", name: "Kiwi", kind: "pet" }] })
    expect<unknown>(one.entities).toEqual([{ key: "a", name: "Braga", kind: "place" }])
    expect(one.dropped).toEqual([{ what: `entity "Kiwi"`, why: DROPPED_BECAUSE.entityKeyTwice }])
  })

  test("a kind that is no kind becomes thing, and a kind in capitals is taken in lower case", () => {
    const one = stage({ entities: [{ key: "a", name: "Braga", kind: "Place" }, { key: "b", name: "Kiwi", kind: "a small parrot" }, { key: "c", name: "Nori", kind: "cat" }] })
    expect(one.entities.map((made) => made.kind)).toEqual(["place", "thing", "cat"])
  })

  test("an alias is kept only for a shown entity, only when its text is a name, and only when the entity does not bear it yet", () => {
    const one = stage({
      entities: [{ key: "a", name: "Braga", kind: "place" }],
      aliases: [
        { id: "n3", alias: "Oporto" }, { id: "n3", alias: "OPORTO" }, { id: "n3", alias: "porto" }, { id: "n4", alias: "Lisboa" }, { id: "n1", alias: "Sam" },
        { id: "n99", alias: "Nowhere" }, { id: "a", alias: "Bracara" }, { id: "n2", alias: "A".repeat(81) }, { id: "n2", alias: "…" },
      ],
    })
    expect<unknown>(one.aliases).toEqual([{ id: "n3", alias: "Oporto" }, { id: "n1", alias: "Sam" }])
    expect(what(one)).toEqual([
      `alias "Nowhere" of "n99": ${DROPPED_BECAUSE.aliasEntity}`,
      `alias "Bracara" of "a": ${DROPPED_BECAUSE.aliasEntity}`,
      `alias "${"A".repeat(80)}" [… 1 characters clipped] of "n2": ${DROPPED_BECAUSE.aliasName}`,
      `alias "…" of "n2": ${DROPPED_BECAUSE.aliasName}`,
    ])
  })

  test.each([
    ["a sentence of more than 300 characters", { ...braga, about: ["n2"], text: `Ana Silva ${"moved ".repeat(60)}.` }, DROPPED_BECAUSE.memoryText],
    ["a sentence of two lines", { ...braga, about: ["n2"], text: "Ana Silva lives in Braga.\nShe likes it." }, DROPPED_BECAUSE.memoryText],
    ["a quote that is in no part of the source", { ...braga, about: ["n2"], quote: "she moved to Faro" }, DROPPED_BECAUSE.quoteNotSaid],
    ["a quote with no letter or digit", { ...braga, about: ["n2"], quote: "…" }, DROPPED_BECAUSE.quoteNotSaid],
    ["a quote in the assistant's words alone", { kind: "fact", text: "Ana Silva may have grown up in Portugal.", about: ["n2"], quote: "she may have grown up in Portugal", by: "user" }, DROPPED_BECAUSE.quoteNotSaid],
    ["an entity that was not shown", { ...braga, about: ["n2", "n42"] }, DROPPED_BECAUSE.aboutUnknown],
    ["a key no new entity of the reply has", { ...braga, about: ["n2", "z"] }, DROPPED_BECAUSE.aboutUnknown],
  ])("a memory with %s is dropped, and the one beside it is kept", (_case, proposed, why) => {
    const kept = { kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2"], quote: "a second parrot, called Kiwi", by: "user" }
    const one = stage({ memories: [proposed, kept] })
    expect(told(one)).toEqual([kept.text])
    expect(one.dropped.map((dropped) => dropped.why)).toEqual([why])
    expect(one.dropped[0]?.what.startsWith(`memory "${proposed.text.slice(0, 20).replace("\n", "\\n")}`)).toBe(true)
  })

  test("a memory with a quote of more than 300 characters is dropped, though the source holds it", () => {
    const long = { said: parts(["user", `I want to say ${"very ".repeat(70)}much that Ana Silva moved.`]) }
    const one = stage({ memories: [{ kind: "fact", text: "Ana Silva moved.", about: ["n2"], quote: `${"very ".repeat(70)}much`, by: "user" }] }, long)
    expect(what(one)).toEqual([`memory "Ana Silva moved.": ${DROPPED_BECAUSE.quoteLength}`])
  })

  test("a memory about more than eight entities is dropped", () => {
    const crowd = knowledgeOf(journalOf(source("s1"), ...Array.from({ length: 9 }, (_, at) => entity(`n${at + 2}`, `Guest ${at + 2}`))))
    const about = crowd.entities.slice(1).map((one) => one.id)
    const all = { entities: crowd.entities, memories: [] }
    expect(what(stage({ memories: [{ kind: "event", text: "Nine guests came to the dinner.", about, quote: "she moved", by: "user" }] }, turn, all)))
      .toEqual([`memory "Nine guests came to the dinner.": ${DROPPED_BECAUSE.aboutMany}`])
    expect(told(stage({ memories: [{ kind: "event", text: "Eight guests came to the dinner.", about: about.slice(1), quote: "she moved", by: "user" }] }, turn, all))).toEqual(["Eight guests came to the dinner."])
  })

  test("a quote is found whatever its case, accents, quote marks and spacing, in any script", () => {
    const said = { said: parts(["user", "Tomás said: “I’m   moving to Braga”.  Ольга Петрова переехала в Брагу."]) }
    const one = stage({ memories: [
      { kind: "fact", text: "Tomás is moving to Braga.", about: [], quote: "tomas said: \"I'm moving to braga\"", by: "user" },
      { kind: "fact", text: "Ольга Петрова живёт в Браге.", about: [], quote: "ольга петрова ПЕРЕЕХАЛА в брагу", by: "user" },
    ] }, said)
    expect(told(one)).toEqual(["Tomás is moving to Braga.", "Ольга Петрова живёт в Браге."])
    expect(one.dropped).toEqual([])
  })

  test("who said a memory is the speaker of the part that holds its quote: the one the reply named when several do, never the assistant", () => {
    const said = { said: parts(["user", "My order QX-77120, where is it?"], called(`lookupOrder, called with {"order":"QX-77120","carrier":"UPS"}`, "QX-77120 shipped with DHL"), ["host", "The user is on the free plan."], ["assistant", "It shipped with DHL."]) }
    const by = (quote: string, named: string) => stage({ memories: [{ kind: "fact", text: "Something to keep.", about: ["n1"], quote, by: named }] }, said).memories.map((made) => made.by)
    expect(by("shipped with DHL", "tool")).toEqual(["tool"])
    // The reply names the user, and only the tool's part holds the quote.
    expect(by("shipped with DHL", "user")).toEqual(["tool"])
    // Both hold it: the one the reply named, else the first.
    expect(by("QX-77120", "tool")).toEqual(["tool"])
    expect(by("QX-77120", "user")).toEqual(["user"])
    expect(by("QX-77120", "assistant")).toEqual(["user"])
    expect(by("on the free plan", "user")).toEqual(["host"])
    expect(by("It shipped with DHL", "assistant")).toEqual([])
  })

  test("a memory about nobody is kept", () => {
    const notes = { said: parts(["user", "Summarise the notes."], ["tool", `readFile, called with {"path":"notes.md"}, returned: Decision: launch moved to 2027-01-15.`]) }
    const one = stage({ memories: [{ kind: "decision", text: "The launch was moved to 2027-01-15.", about: [], quote: "Decision: launch moved to 2027-01-15.", by: "tool", on: "2027-01-15" }] }, notes)
    expect<unknown>(one.memories).toEqual([{ kind: "decision", text: "The launch was moved to 2027-01-15.", about: [], quote: "Decision: launch moved to 2027-01-15.", by: "tool", on: Option.some("2027-01-15"), ends: [], why: "changed" }])
    expect(one.dropped).toEqual([])
  })

  test("a sentence a standing shown memory already has becomes a restatement of it, with the memory's quote", () => {
    const one = stage({ memories: [{ kind: "fact", text: "ana silva lives in PORTO", about: ["n2", "n3"], quote: "she moved", by: "user", ends: ["m2"] }] })
    expect(one.memories).toEqual([])
    expect<unknown>(one.restates).toEqual([{ id: "m1", quote: "she moved" }])
    expect(one.dropped).toEqual([])
    // A memory that ended is not said again by its sentence: the sentence is written anew.
    expect(told(stage({ memories: [{ kind: "fact", text: "Ana Silva lived in Faro.", about: ["n2"], quote: "she moved", by: "user" }] }))).toEqual(["Ana Silva lived in Faro."])
  })

  test("a second memory of one reply that says the same is dropped", () => {
    const kiwi = { kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2"], quote: "a second parrot, called Kiwi", by: "user" }
    const one = stage({ memories: [kiwi, { ...kiwi, text: "Ana Silva has a second parrot, called KIWI" }] })
    expect(told(one)).toEqual([kiwi.text])
    expect(what(one)).toEqual([`memory "Ana Silva has a second parrot, called KIWI": ${DROPPED_BECAUSE.memoryTwice}`])
  })

  test("a second pet ends nothing: a memory with no end leaves every stored memory standing", () => {
    const one = stage({
      entities: [{ key: "a", name: "Kiwi", kind: "pet" }],
      memories: [{ kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2", "a"], quote: "She just got a second parrot, called Kiwi.", by: "user" }],
    })
    expect(one.memories.map((made) => made.ends)).toEqual([[]])
    expect([one.restates, one.forget, one.dropped]).toEqual([[], [], []])
  })

  test("an end of a memory about another entity is dropped alone, and the memory is kept", () => {
    const one = stage({ entities: [{ key: "a", name: "Braga", kind: "place" }], memories: [{ ...braga, ends: ["m1", "m3"] }] })
    expect<unknown>(one.memories.map((made) => [made.text, made.ends])).toEqual([["Ana Silva lives in Braga since 2026-10.", ["m1"]]])
    expect(what(one)).toEqual([`end of "m3" by memory "Ana Silva lives in Braga since 2026-10.": ${DROPPED_BECAUSE.noCommonEntity}`])
  })

  test("a memory about nothing ends nothing: an end needs an entity the two memories share", () => {
    const one = stage({ memories: [{ kind: "fact", text: "Nobody lives in Porto any more.", about: [], quote: "she moved to Braga", by: "user", ends: ["m1"] }] })
    // The memory is kept, and the stored one still stands.
    expect<unknown>(one.memories.map((made) => [made.text, made.ends])).toEqual([["Nobody lives in Porto any more.", []]])
    expect(what(one)).toEqual([`end of "m1" by memory "Nobody lives in Porto any more.": ${DROPPED_BECAUSE.noCommonEntity}`])
  })

  test("a quote found only in a tool call's name or parameters, which the model wrote, is no evidence", () => {
    const said = { said: parts(["user", "Did I pay the electricity bill?"], called(`listPayments, called with {"payee":"EDP","expectedAmount":74.2}`, "No payments found."), ["assistant", "I see no payment."]) }
    const one = stage({ memories: [
      { kind: "fact", text: "The user's electricity bill is 74.2.", about: ["n1"], quote: `"expectedAmount":74.2`, by: "tool" },
      { kind: "fact", text: "The user pays EDP.", about: ["n1"], quote: `Tool listPayments, called with {"payee":"EDP","expectedAmount":74.2}, returned: No payments found.`, by: "tool" },
      { kind: "fact", text: "The user had no payments on record.", about: ["n1"], quote: "No payments found.", by: "tool" },
    ] }, said)
    expect(told(one)).toEqual(["The user had no payments on record."])
    expect(one.dropped.map((dropped) => dropped.why)).toEqual([DROPPED_BECAUSE.quoteNotSaid, DROPPED_BECAUSE.quoteNotSaid])
  })

  test("an end of a memory that is not shown, that ended, or that is no memory is dropped alone; a memory is ended once", () => {
    const one = stage({
      entities: [{ key: "a", name: "Braga", kind: "place" }],
      memories: [
        { ...braga, ends: ["m1", "m1", "m5", "m77", "n2"] },
        { kind: "fact", text: "Ana Silva left Porto in 2026-10.", about: ["n2"], quote: "she moved to Braga last month", by: "user", ends: ["m1", "m2"] },
      ],
    })
    expect<unknown>(one.memories.map((made) => made.ends)).toEqual([["m1"], ["m2"]])
    expect(what(one)).toEqual(["m5", "m77", "n2"].map((id) => `end of "${id}" by memory "Ana Silva lives in Braga since 2026-10.": ${DROPPED_BECAUSE.noStandingMemory}`))
  })

  test("why a memory ended is changed unless the reply says wrong; a kind that is no kind is fact; a day that is no day is left out", () => {
    const made = (more: object) => stage({ memories: [{ kind: "fact", text: "Carla Mendes works at Hooli.", about: ["n6"], quote: "she moved", by: "user", ends: ["m3"], ...more }] }).memories[0]
    expect([made({})?.why, made({ why: "wrong" })?.why, made({ why: "asked" })?.why, made({ why: "because" })?.why]).toEqual(["changed", "wrong", "changed", "changed"])
    expect([made({ kind: "Preference" })?.kind, made({ kind: "rumour" })?.kind, made({ kind: "" })?.kind]).toEqual(["preference", "fact", "fact"])
    expect([made({ on: "2026-11-20" }), made({ on: "2026-11" }), made({ on: "next Friday" }), made({ on: "2026-11-40" }), made({})].map((one) => Option.getOrNull(one?.on ?? Option.none())))
      .toEqual(["2026-11-20", "2026-11", null, null, null])
  })

  test("a restatement is kept only for a standing shown memory, with its quote in what the user, a tool or the host said", () => {
    const one = stage({ restates: [
      { id: "m2", quote: "a second parrot" }, { id: "m2", quote: "called Kiwi" }, { id: "m4", quote: `"status":"shipped"` },
      { id: "m5", quote: "she moved" }, { id: "m77", quote: "she moved" }, { id: "m1", quote: "she may have grown up in Portugal" }, { id: "m3" },
    ] })
    expect<unknown>(one.restates).toEqual([{ id: "m2", quote: "a second parrot" }, { id: "m4", quote: `"status":"shipped"` }])
    expect(what(one)).toEqual([
      `restatement of "m5": ${DROPPED_BECAUSE.noStandingMemory}`,
      `restatement of "m77": ${DROPPED_BECAUSE.noStandingMemory}`,
      `restatement of "m1": ${DROPPED_BECAUSE.quoteNotSaid}`,
      `restatement of "m3": ${DROPPED_BECAUSE.quoteNotSaid}`,
    ])
  })

  test("a restatement with a quote of more than 300 characters is dropped", () => {
    const long = { said: parts(["user", `Ana Silva ${"really ".repeat(50)}lives in Porto.`]) }
    expect(what(stage({ restates: [{ id: "m1", quote: `Ana Silva ${"really ".repeat(50)}lives in Porto.` }] }, long))).toEqual([`restatement of "m1": ${DROPPED_BECAUSE.quoteLength}`])
  })

  test("a forgetting is kept only for a standing shown memory, once", () => {
    const one = stage({ forget: ["m4", "m4", "m5", "m77", "n2"] })
    expect<unknown>(one.forget).toEqual(["m4"])
    expect(what(one)).toEqual(["m5", "m77", "n2"].map((id) => `forgetting of "${id}": ${DROPPED_BECAUSE.noStandingMemory}`))
  })

  test("a reply may name nothing that was not shown: a stored memory or entity left out of what was shown is not there", () => {
    const little: ShownKnowledge = { entities: knowledge.entities.slice(0, 2), memories: [] }
    const one = stage({ aliases: [{ id: "n3", alias: "Oporto" }], memories: [{ ...braga, about: ["n2"], ends: ["m1"] }], restates: [{ id: "m2", quote: "a second parrot" }], forget: ["m4"] }, turn, little)
    expect<unknown>([one.aliases, one.memories.map((made) => made.ends), one.restates, one.forget]).toEqual([[], [[]], [], []])
    expect(one.dropped.map((dropped) => dropped.why)).toEqual([DROPPED_BECAUSE.aliasEntity, DROPPED_BECAUSE.noStandingMemory, DROPPED_BECAUSE.noStandingMemory, DROPPED_BECAUSE.noStandingMemory])
  })

  test("each reason is one plain sentence", () => {
    for (const why of Object.values(DROPPED_BECAUSE)) expect(why).toMatch(/^[A-Z][^.\n]*\.$/)
  })
})

describe("the records of a staged curation", () => {
  const s2 = { id: SourceId.make("s2") }
  /** A draft as a test reads it: the record's name without its prefix, and its data. */
  const records = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<readonly [string, Schema.Json]> => drafts.map((draft) => [draft.name.replace("plugin.knowledge.", ""), draft.data])
  const idOf = (data: Schema.Json): string => (Predicate.hasProperty(data, "id") ? String(data.id) : "")
  const whole = stage({
    entities: [{ key: "a", name: "Braga", kind: "place" }, { key: "k", name: "Kiwi", kind: "pet" }],
    aliases: [{ id: "n3", alias: "Oporto" }],
    memories: [
      { ...braga, on: "2026-10", ends: ["m1"], why: "wrong" },
      { kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2", "k"], quote: "a second parrot, called Kiwi", by: "user" },
    ],
    restates: [{ id: "m2", quote: "a second parrot" }],
    forget: ["m4"],
  })

  test("the drafts are the entities, the aliases, each memory followed by what it ends, the restatements, then what is forgotten, with ids that go on from the knowledge's", () => {
    expect<unknown>(records(draftsOf(whole, knowledge, s2))).toEqual([
      ["entity", { id: "n8", name: "Braga", kind: "place", source: "s2" }],
      ["entity", { id: "n9", name: "Kiwi", kind: "pet", source: "s2" }],
      ["aliased", { id: "n3", alias: "Oporto", source: "s2" }],
      ["memory", { id: "m6", kind: "fact", text: "Ana Silva lives in Braga since 2026-10.", about: ["n2", "n8"], quote: "she moved to Braga last month", by: "user", source: "s2", on: "2026-10" }],
      ["ended", { id: "m1", why: "wrong", by: "m6", source: "s2" }],
      ["memory", { id: "m7", kind: "fact", text: "Ana Silva has a second parrot called Kiwi.", about: ["n2", "n9"], quote: "a second parrot, called Kiwi", by: "user", source: "s2" }],
      ["restated", { id: "m2", source: "s2", quote: "a second parrot" }],
      ["ended", { id: "m4", why: "asked", source: "s2" }],
    ])
  })

  test("stored after their source, the drafts fold to the knowledge they describe", () => {
    const after = knowledgeOf([...journal, ...journalOf(noon("2026-11-13"), source("s2"), ...draftsOf(whole, knowledge, s2))])
    expect(after.entities.map((one) => [one.name, one.aliases])).toEqual([
      ["the user", ["I", "me"]], ["Ana Silva", []], ["Porto", ["Oporto"]], ["Lisbon", ["Lisboa"]], ["Pip", []], ["Carla Mendes", []], ["Globex", []], ["Braga", []], ["Kiwi", []],
    ])
    expect(after.memories.map((one) => `${one.id} ${one.count} ${Option.match(one.ended, { onNone: () => "stands", onSome: (end) => `${end.why} by ${Option.getOrElse(end.by, () => "nothing")}` })}`)).toEqual([
      "m1 1 wrong by m6", "m2 2 stands", "m3 1 stands", "m4 1 asked by nothing", "m5 1 changed by m1", "m6 1 stands", "m7 1 stands",
    ])
    expect<unknown>(endedBy(after, MemoryId.make("m6")).map((one) => one.text)).toEqual(["Ana Silva lives in Porto."])
  })

  test("nothing staged gives no drafts", () => {
    expect(draftsOf(stage({}), knowledge, s2)).toEqual([])
  })

  test("the knowledge is read as it stands now: a new entity whose name an entity made meanwhile bears is that entity", () => {
    const meanwhile = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Ana Silva"), entity("n3", "Porto", "place"), entity("n4", "Lisbon", "place"), entity("n5", "Pip", "pet"), entity("n6", "Carla Mendes"), entity("n7", "Globex", "organization"),
      memory("m1", "Ana Silva lives in Porto.", ["n2", "n3"]), memory("m2", "Ana Silva has a parrot called Pip.", ["n2", "n5"]), memory("m3", "The user's order QX-77120 shipped with DHL.", ["n1"]),
      // Another curation stored these while the model answered: Braga, under an alias too, and a memory.
      entity("n8", "Bracara Augusta", "place"), aliased("n8", "BRAGA"), aliased("n3", "oporto"), memory("m4", "Braga is in the north.", ["n8"]),
    ))
    expect<unknown>(records(draftsOf(whole, meanwhile, s2)).slice(0, 3)).toEqual([
      ["entity", { id: "n9", name: "Kiwi", kind: "pet", source: "s2" }],
      // Braga is n8 now: no record is made for it, and the memory names n8. The alias Oporto is borne already, and left out.
      ["memory", { id: "m5", kind: "fact", text: "Ana Silva lives in Braga since 2026-10.", about: ["n2", "n8"], quote: "she moved to Braga last month", by: "user", source: "s2", on: "2026-10" }],
      ["ended", { id: "m1", why: "wrong", by: "m5", source: "s2" }],
    ])
  })

  test("an end, a restatement and a forgetting of a memory that no longer stands are left out, and the memory is still written", () => {
    const meanwhile = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Ana Silva"), entity("n3", "Porto", "place"), entity("n4", "Pip", "pet"),
      memory("m1", "Ana Silva lives in Porto.", ["n2", "n3"]), memory("m2", "Ana Silva has a parrot called Pip.", ["n2", "n4"]), memory("m3", "Unused.", []), memory("m4", "The user's order QX-77120 shipped with DHL.", ["n1"]),
      // Another curation ended these three while the model answered.
      ended("m1", "wrong"), ended("m2", "asked"), ended("m4", "asked"),
    ))
    expect<unknown>(records(draftsOf(whole, meanwhile, s2)).map(([name, data]) => [name, idOf(data)])).toEqual([
      ["entity", "n5"], ["entity", "n6"], ["aliased", "n3"], ["memory", "m5"], ["memory", "m6"],
    ])
  })

  test("a memory is ended once in one curation: a later end, restatement or forgetting of it is left out", () => {
    const [m1, m2, m3, m4] = ["m1", "m2", "m3", "m4"].map((id) => MemoryId.make(id))
    const twice: Staged = {
      entities: [], aliases: [],
      memories: [
        { kind: "fact", text: "Ana Silva lives in Braga.", about: [{ _tag: "Stored", id: EntityId.make("n2") }], quote: "she moved", by: "user", on: Option.none(), ends: Option.toArray(Option.fromNullishOr(m1)), why: "changed" },
        { kind: "fact", text: "Ana Silva left Porto.", about: [], quote: "she moved", by: "user", on: Option.none(), ends: [m1, m2].flatMap((id) => Option.toArray(Option.fromNullishOr(id))), why: "changed" },
      ],
      restates: [m1, m3].flatMap((id) => Option.toArray(Option.fromNullishOr(id))).map((id) => ({ id, quote: "she moved" })),
      forget: [m2, m4, m4].flatMap((id) => Option.toArray(Option.fromNullishOr(id))),
      dropped: [],
    }
    expect<unknown>(records(draftsOf(twice, knowledge, s2)).map(([name, data]) => `${name} ${idOf(data)}`)).toEqual([
      "memory m6", "ended m1", "memory m7", "ended m2", "restated m3", "ended m4",
    ])
  })
})
