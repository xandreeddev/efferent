import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { readJournal, stored, storedEvent, userMessage } from "@xandreed/core/kernel"
import { EntityKind, EntityName, KNOWLEDGE_VOCABULARY, MemoryData, MemoryDay, MemoryId, MemoryText, Quote, SourceData, sourceEvent, USER_ENTITY } from "./knowledge.entity.js"
import { dayOf, endedBy, evidenceOf, folded, holdsRun, keptFrom, knowledgeOf, nextIds, quoted, sourceText, standing } from "./knowledge.entity.functions.js"
import { aliased, called, curated, ended, entity, failed, journalOf, memory, noon, parts, restated, source } from "./knowledge.testing.js"

const texts = (knowledge: ReturnType<typeof knowledgeOf>) => knowledge.memories.map((one) => `${one.id}: ${one.text}`)

describe("text as names and quotes are compared", () => {
  test.each([
    ["João Reis", "joao reis"],
    ["  St Mary's   Hospital ", "st mary s hospital"],
    ["QX-77120", "qx 77120"],
    ["“Tomás”, she said…", "tomas she said"],
    // Every script's letters and digits are kept: Cyrillic, Greek, Chinese, Arabic digits.
    ["Ольга Петрова", "ольга петрова"],
    ["Ελένη Παππά", "ελενη παππα"],
    ["田中 太郎", "田中 太郎"],
    ["٣ قطط", "٣ قطط"],
    // A mark another script writes inside a word stays in it, so the word is not split.
    ["किताब", "किताब"],
    ["?!", ""],
  ])("%s folds to %s", (text, expected) => {
    expect(folded(text)).toBe(expected)
  })

  test("a name is held as a run of whole words, never as part of a word", () => {
    expect(holdsRun(folded("My friend Ana Silva works at Acme."), folded("Ana Silva"))).toBe(true)
    expect(holdsRun(folded("A banana."), folded("Ana"))).toBe(false)
    expect(holdsRun(folded("Ana Costa."), folded("Ana Silva"))).toBe(false)
    expect(holdsRun(folded("anything"), "")).toBe(false)
    expect(holdsRun(folded("Вчера Ольга Петрова переехала."), folded("ольга петрова"))).toBe(true)
  })

  test("a quote is held when its words are, in order, whatever the case, the accents, the quote marks and the spacing", () => {
    expect(quoted("I’m flying to  Rome next Friday.", "i'm flying to rome")).toBe(true)
    expect(quoted("Tomás was born on 2 November.", "Tomas was born")).toBe(true)
    expect(quoted("Она переехала в Брагу в прошлом месяце.", "переехала в брагу")).toBe(true)
    expect(quoted("I am flying to Rome.", "flying to Paris")).toBe(false)
    expect(quoted("I am flying to Rome.", " …")).toBe(false)
  })

  test("a time is written as its UTC day, and a time that is no date as the first day there is", () => {
    expect(dayOf(noon("2026-11-12"))).toBe("2026-11-12")
    expect(dayOf(Date.parse("2026-11-12T23:59:59Z"))).toBe("2026-11-12")
    expect([dayOf(Number.NaN), dayOf(-1), dayOf(Number.POSITIVE_INFINITY)]).toEqual(["1970-01-01", "1970-01-01", "1970-01-01"])
  })
})

describe("a source's text", () => {
  const said = parts(["user", "Look up my order QX-77120."], called(`lookupOrder, called with {"order":"QX-77120"}`, `{"status":"shipped"}`), ["assistant", "It has shipped."], ["host", "The user is on the free plan."])

  test("each part is a line, labelled by who said it", () => {
    expect(sourceText({ said })).toBe([
      "User: Look up my order QX-77120.",
      `Tool lookupOrder, called with {"order":"QX-77120"}, returned: {"status":"shipped"}`,
      "Assistant's final answer: It has shipped.",
      "Host: The user is on the free plan.",
    ].join("\n"))
  })

  test("a tool's part reads as its call and what it returned, or as what failed; one that names no call as its text", () => {
    expect(sourceText({ said: parts(called(`search, called with {"query":"DHL"}`, "The service is down.", true), called("ping, called with {}", ""), ["tool", "A note a host took from a tool."]) })).toBe([
      `Tool search, called with {"query":"DHL"}, failed: The service is down.`,
      "Tool ping, called with {}, returned: ",
      "Tool A note a host took from a tool.",
    ].join("\n"))
  })

  test("what a memory may rest on is every part's own text but the assistant's: a tool's call, which the model wrote, is no part of it", () => {
    expect(evidenceOf({ said })).toEqual([
      { by: "user", text: "Look up my order QX-77120." },
      { by: "tool", text: `{"status":"shipped"}` },
      { by: "host", text: "The user is on the free plan." },
    ])
  })
})

describe("the schemas of what is stored", () => {
  const accepts = <A, I>(schema: Schema.Codec<A, I>) => (value: unknown) => Option.isSome(Schema.decodeUnknownOption(schema)(value))

  test("a name is one line of 1 to 80 characters; a kind one word with no capital; a memory one line of 1 to 300; a quote 1 to 300 characters; a day a day or a month", () => {
    expect(["Ana Silva", "a".repeat(80), "", " Ana", "Ana\nSilva", "a".repeat(81)].map(accepts(EntityName))).toEqual([true, true, false, false, false, false])
    expect(["person", "organização", "人", "Person", "two words", "", "a".repeat(21), "pet2"].map(accepts(EntityKind))).toEqual([true, true, true, false, false, false, false, false])
    expect(["Ana Silva lives in Braga.", "a".repeat(300), "a".repeat(301), "two\nlines", ""].map(accepts(MemoryText))).toEqual([true, true, false, false, false])
    expect(["moved to Braga", "two\nlines", "", "a".repeat(301)].map(accepts(Quote))).toEqual([true, true, false, false])
    expect(["2026-11-20", "2026-10", "2026", "2026-13", "2026-11-32", "20 November"].map(accepts(MemoryDay))).toEqual([true, true, false, false, false, false])
  })

  test("a source has one part or more, and a memory is about at most eight entities", () => {
    const one = { id: "s1", said: [{ by: "user", text: "Hello." }], at: 1 }
    expect([one, { ...one, said: [] }, { ...one, said: [{ by: "system", text: "Hello." }] }, { ...one, context: "a".repeat(4_001) }, { ...one, meta: { channel: "mail" }, from: { session: "c1", turn: 2 } }].map(accepts(SourceData)))
      .toEqual([true, false, false, false, true])
    const held = { id: "m1", kind: "fact", text: "The launch moved.", about: [], quote: "launch moved", by: "tool", source: "s1" }
    expect([held, { ...held, about: Array.from({ length: 8 }, (_, at) => `n${at + 2}`) }, { ...held, about: Array.from({ length: 9 }, (_, at) => `n${at + 2}`) }, { ...held, by: "assistant" }, { ...held, on: "2027-01-15" }, { ...held, on: "soon" }].map(accepts(MemoryData)))
      .toEqual([true, true, false, false, true, false])
  })

  test("the vocabulary knows the eight records, passes over a skippable one it does not know and refuses any other", () => {
    expect<unknown>(KNOWLEDGE_VOCABULARY.knows.filter((name) => name.startsWith("plugin.knowledge."))).toEqual([
      "plugin.knowledge.source", "plugin.knowledge.entity", "plugin.knowledge.aliased", "plugin.knowledge.memory", "plugin.knowledge.restated", "plugin.knowledge.ended",
      "plugin.knowledge.curated", "plugin.knowledge.failed",
    ])
    const later = (skippable: boolean) => stored(storedEvent("knowledge", "weighed", { data: Schema.Json, skippable, tags: ["memory"] }), {})
    const read = readJournal(KNOWLEDGE_VOCABULARY)
    expect<unknown>(Result.map(read(journalOf(source("s1"), later(true), entity("n2", "Ana Silva"))), (known) => known.map((event) => event.name)))
      .toEqual(Result.succeed(["plugin.knowledge.source", "plugin.knowledge.entity"]))
    expect(Result.isFailure(read(journalOf(source("s1"), later(false))))).toBe(true)
    expect(sourceEvent.skippable).toBe(false)
  })
})

describe("what a knowledge session's journal holds", () => {
  const first = noon("2026-11-12")
  const second = noon("2026-11-14")
  const third = noon("2026-11-17")

  test("an empty journal holds the user and nothing else", () => {
    const knowledge = knowledgeOf([])
    expect(knowledge).toEqual({ entities: [{ id: USER_ENTITY, name: "the user", kind: "person", aliases: ["I", "me"], source: Option.none() }], memories: [], sources: [] })
    expect<unknown>(nextIds(knowledge)).toEqual({ source: "s1", entity: "n2", memory: "m1" })
  })

  test("the next ids are one more than the highest held, whatever was passed over before", () => {
    const knowledge = knowledgeOf(journalOf(source("s1"), source("s4"), entity("n2", "Ana Silva"), entity("n7", "Porto", "place"), memory("m3", "Ana Silva lives in Porto.", ["n2", "n7"])))
    expect<unknown>(nextIds(knowledge)).toEqual({ source: "s5", entity: "n8", memory: "m4" })
  })

  test("entities come after the user, each with its other names, a name said twice kept once", () => {
    const knowledge = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Lisbon", "place"), entity("n3", "Ana Silva"),
      aliased("n2", "Lisboa"), aliased("n2", "LISBOA"), aliased("n2", "lisbon"), aliased("n3", "Ana"), aliased("n1", "Sam"),
    ))
    expect<unknown>(knowledge.entities.map((one) => [one.id, one.name, one.kind, one.aliases, Option.getOrNull(one.source)])).toEqual([
      ["n1", "the user", "person", ["I", "me", "Sam"], null],
      ["n2", "Lisbon", "place", ["Lisboa"], "s1"],
      ["n3", "Ana Silva", "person", ["Ana"], "s1"],
    ])
  })

  test("a memory said again is counted, with when it was first and last said and the sources that said it", () => {
    const knowledge = knowledgeOf(journalOf(
      first, source("s1", undefined, { at: first }), entity("n2", "Ana Silva"), memory("m1", "Ana Silva works at Acme.", ["n2"]),
      second, source("s2", undefined, { at: second }), restated("m1", "s2"), restated("m1", "s2"),
      third, source("s3", undefined, { at: third }), restated("m1", "s3"),
    ))
    expect<unknown>(knowledge.memories.map((one) => [one.id, one.count, dayOf(one.first), dayOf(one.last), one.sources])).toEqual([["m1", 4, "2026-11-12", "2026-11-17", ["s1", "s2", "s3"]]])
  })

  test("when a memory was said, and when it ended, is when its source happened, not when a record was stored", () => {
    // Three turns curated late, all on the 20th, and the oldest of them last.
    const knowledge = knowledgeOf(journalOf(
      noon("2026-11-20"),
      source("s1", undefined, { at: second }), entity("n2", "Ana Silva"), memory("m1", "Ana Silva works at Acme.", ["n2"]), memory("m2", "Ana Silva lives in Porto.", ["n2"]),
      source("s2", undefined, { at: third }), restated("m1", "s2"), ended("m2", "changed", { from: "s2" }),
      source("s3", undefined, { at: first }), restated("m1", "s3"),
    ))
    expect(knowledge.memories.map((one) => [one.count, dayOf(one.first), dayOf(one.last), Option.getOrNull(Option.map(one.ended, (end) => dayOf(end.at)))])).toEqual([
      [3, "2026-11-12", "2026-11-17", null],
      [1, "2026-11-14", "2026-11-14", "2026-11-17"],
    ])
    expect(knowledge.sources.map((one) => dayOf(one.stored))).toEqual(["2026-11-20", "2026-11-20", "2026-11-20"])
  })

  test("a memory that ended stays in the list, with when and why it ended and what came in its place", () => {
    const knowledge = knowledgeOf(journalOf(
      first, source("s1"), entity("n2", "Ana Silva"), entity("n3", "Porto", "place"), entity("n4", "Braga", "place"),
      memory("m1", "Ana Silva lives in Porto.", ["n2", "n3"]), memory("m2", "The user's order is QX-77120.", ["n1"]),
      second, source("s2", undefined, { at: second }), memory("m3", "Ana Silva lives in Braga since 2026-10.", ["n2", "n4"], { from: "s2", on: "2026-10" }), ended("m1", "changed", { by: "m3", from: "s2" }),
      third, source("s3", undefined, { at: third }), ended("m2", "asked", { from: "s3" }),
    ))
    expect(texts(knowledge)).toEqual(["m1: Ana Silva lives in Porto.", "m2: The user's order is QX-77120.", "m3: Ana Silva lives in Braga since 2026-10."])
    expect(knowledge.memories.map((one) => Option.match(one.ended, { onNone: () => "stands", onSome: (end) => `${end.why} on ${dayOf(end.at)} by ${Option.getOrElse(end.by, () => "nothing")}` })))
      .toEqual(["changed on 2026-11-14 by m3", "asked on 2026-11-17 by nothing", "stands"])
    expect<unknown>(standing(knowledge).map((one) => one.id)).toEqual(["m3"])
    expect<unknown>(endedBy(knowledge, MemoryId.make("m3")).map((one) => one.id)).toEqual(["m1"])
    expect(endedBy(knowledge, MemoryId.make("m1"))).toEqual([])
    expect(knowledge.memories.map((one) => Option.getOrNull(one.on))).toEqual([null, null, "2026-10"])
    // A memory that ended keeps its id: the next one takes a new one.
    expect<unknown>(nextIds(knowledge)).toEqual({ source: "s4", entity: "n5", memory: "m4" })
  })

  test("a source is pending until it is curated; a failed one says how many tries and why; curated wins over failed", () => {
    const knowledge = knowledgeOf(journalOf(
      first, source("s1"), second, source("s2"), source("s3"), source("s4"),
      failed("s2", 1, "the model is down"), failed("s2", 2, "the reply was no JSON"),
      failed("s3", 1, "the model is down"), curated("s3"), failed("s3", 2, "late"),
      curated("s4", 3),
    ))
    expect<unknown>(knowledge.sources.map((one) => [one.source.id, dayOf(one.stored), one.state])).toEqual([
      ["s1", "2026-11-12", { _tag: "Pending" }],
      ["s2", "2026-11-14", { _tag: "Failed", attempts: 2, reason: "the reply was no JSON" }],
      ["s3", "2026-11-14", { _tag: "Curated" }],
      ["s4", "2026-11-14", { _tag: "Curated" }],
    ])
  })

  test.each([
    ["an entity of a source that is not there", [source("s1"), entity("n2", "Ana Silva", "person", "s9")]],
    ["an entity under an id that is taken", [source("s1"), entity("n1", "Somebody")]],
    ["an alias of an entity that is not there", [source("s1"), aliased("n7", "Ana")]],
    ["a memory about an entity that is not there", [source("s1"), memory("m1", "Ana Silva works at Acme.", ["n7"])]],
    ["a memory of a source that is not there", [source("s1"), memory("m1", "The launch moved.", [], { from: "s9" })]],
    ["a restatement of a memory that is not there", [source("s1"), restated("m4")]],
    ["an end of a memory that is not there", [source("s1"), ended("m4", "wrong")]],
    ["a curation of a source that is not there", [source("s1"), curated("s9")]],
    ["a failure of a source that is not there", [source("s1"), failed("s9", 1, "down")]],
    ["a record of the conversation, and one of another plugin", [source("s1"), userMessage("Hello."), stored(storedEvent("other", "noted", { data: Schema.Json, skippable: true, tags: ["memory"] }), { id: "m1" })]],
  ])("%s is passed over", (_what, drafts) => {
    expect(knowledgeOf(journalOf(...drafts))).toEqual(knowledgeOf(journalOf(source("s1"))))
  })

  test("a second record under one id, a second end, an end by a memory that is not there and a restatement after the end are passed over", () => {
    const knowledge = knowledgeOf(journalOf(
      first, source("s1"), source("s1", parts(["user", "Another."])), entity("n2", "Ana Silva"), entity("n2", "Ana Costa"),
      memory("m1", "Ana Silva works at Acme.", ["n2"]), memory("m1", "Ana Silva works at Globex.", ["n2"]),
      ended("m1", "wrong", { by: "m9" }),
      second, source("s2", undefined, { at: second }), ended("m1", "wrong", { from: "s2" }),
      third, source("s3", undefined, { at: third }), ended("m1", "asked", { from: "s3" }), restated("m1", "s3"),
    ))
    expect(knowledge.sources.map((one) => sourceText(one.source))).toEqual(["User: Hello.", "User: Hello.", "User: Hello."])
    expect(knowledge.entities.map((one) => one.name)).toEqual(["the user", "Ana Silva"])
    expect(knowledge.memories.map((one) => [one.text, one.count, dayOf(one.last), Option.map(one.ended, (end) => `${end.why} on ${dayOf(end.at)}`)]))
      .toEqual([["Ana Silva works at Acme.", 1, "2026-11-12", Option.some("wrong on 2026-11-14")]])
  })
})

describe("what a curation stored for a source", () => {
  test("keptFrom reads back every record that names the source, by kind, in the order stored, and passes over the rest", () => {
    const journal = journalOf(
      source("s1"), entity("n2", "Ana Silva"), memory("m1", "Ana Silva lives in Porto.", ["n2"]), curated("s1", 2),
      source("s2"), failed("s2", 1, "The curator's reply holds no JSON object."),
      entity("n3", "Braga", "place", "s2"), aliased("n2", "Ana", "s2"), memory("m2", "Ana Silva lives in Braga.", ["n2", "n3"], { from: "s2" }),
      ended("m1", "changed", { by: "m2", from: "s2" }), restated("m2", "s2"), ended("m2", "asked", { from: "s3" }), curated("s2", 5),
      userMessage("Not a record of the knowledge."),
    )
    const kept = keptFrom(journal, SourceData.fields.id.make("s2"))
    expect<unknown>({ ...kept, curated: Option.getOrNull(kept.curated) }).toEqual({
      entities: [{ id: "n3", name: "Braga", kind: "place", source: "s2" }],
      aliases: [{ id: "n2", alias: "Ana", source: "s2" }],
      memories: [{ id: "m2", kind: "fact", text: "Ana Silva lives in Braga.", about: ["n2", "n3"], quote: "Ana Silva lives in Braga.", by: "user", source: "s2" }],
      restated: [{ id: "m2", source: "s2", quote: "said again" }],
      ended: [{ id: "m1", why: "changed", by: "m2", source: "s2" }],
      curated: { source: "s2", calls: 1, kept: 5, dropped: [] },
      failed: [{ source: "s2", attempt: 1, reason: "The curator's reply holds no JSON object." }],
    })
    expect(Option.isNone(keptFrom(journal, SourceData.fields.id.make("s9")).curated)).toBe(true)
  })
})
