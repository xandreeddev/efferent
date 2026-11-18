import { describe, expect, test } from "bun:test"
import type { StoredDraft } from "@xandreed/core/kernel"
import type { ShownKnowledge } from "./knowledge.entity.js"
import { knowledgeOf } from "./knowledge.entity.functions.js"
import { shownFor } from "./knowledge-shown.entity.functions.js"
import { aliased, called, ended, entity, journalOf, memory, noon, parts, restated, source } from "./knowledge.testing.js"

const names = (shown: ShownKnowledge) => shown.entities.map((one) => one.name)
const ids = (shown: ShownKnowledge) => shown.memories.map((one) => String(one.id))
const turn = (text: string, context?: string) => ({ said: parts(["user", text]), ...(context === undefined ? {} : { context }) })

/** A small world: two Anas, a Bruno, places and employers, and what is stored about them. */
const world = knowledgeOf(journalOf(
  source("s1"),
  entity("n2", "Ana Silva"), entity("n3", "Ana Costa"), entity("n4", "Bruno Reis"), entity("n5", "Acme Labs", "organization"), entity("n6", "Lisbon", "place"),
  entity("n7", "Porto", "place"), entity("n8", "João Reis"), entity("n9", "Pip", "pet"), entity("n10", "Ольга Петрова"),
  aliased("n5", "Acme"), aliased("n6", "Lisboa"),
  memory("m1", "Ana Silva works at Acme Labs.", ["n2", "n5"]),
  memory("m2", "Ana Silva lives in Porto.", ["n2", "n7"]),
  memory("m3", "Ana Silva has a parrot called Pip.", ["n2", "n9"]),
  memory("m4", "Ana Costa lives in Lisbon.", ["n3", "n6"]),
  memory("m5", "Bruno Reis works at Acme Labs.", ["n4", "n5"]),
  memory("m6", "Acme Labs has an office in Lisbon.", ["n5", "n6"]),
  memory("m7", "The user's name is Sam.", ["n1"], { kind: "profile" }),
  memory("m8", "João Reis leads Project Orchid.", ["n8"]),
  memory("m9", "Ольга Петрова живёт в Порту.", ["n10"]),
  memory("m10", "The launch was moved to 2027-01-15.", []),
))

describe("what a curator is shown", () => {
  test("the user is always shown, with what is stored about them; a source that names nobody shows nothing else", () => {
    const shown = shownFor(world, turn("Thanks, that's kind of you."))
    expect(names(shown)).toEqual(["the user"])
    expect(ids(shown)).toEqual(["m7"])
  })

  test("an entity the source names in full is shown with every memory it is the subject of, even one that shares no word with the source", () => {
    const shown = shownFor(world, turn("And Ana Silva moved to Braga last month."))
    // "lives in Porto" shares no word with the source but the name: it is shown because it is about Ana Silva.
    // Ana Costa shares the first name, so she is shown too, after, and her memory fills a place that is left.
    expect(ids(shown)).toEqual(["m7", "m1", "m2", "m3", "m4"])
    // Every entity a shown memory is about is shown too: Acme Labs, Porto, Pip and Lisbon are named by id in those lines.
    expect(names(shown)).toEqual(["the user", "Ana Silva", "Ana Costa", "Acme Labs", "Porto", "Pip", "Lisbon"])
  })

  test("an entity is named by another name it bears, and a name is found whatever its case, accents and punctuation", () => {
    expect(names(shownFor(world, turn("Acme's office is in LISBOA.")))).toEqual(["the user", "Acme Labs", "Lisbon", "Ana Silva", "Bruno Reis", "Ana Costa"])
    expect(names(shownFor(world, turn("Remember Joao Reis? He got promoted.")))).toEqual(["the user", "João Reis"])
    expect(ids(shownFor(world, turn("Remember Joao Reis? He got promoted.")))).toEqual(["m7", "m8"])
  })

  test("a name in another script is found, as a run of whole words", () => {
    const shown = shownFor(world, turn("Вчера ОЛЬГА ПЕТРОВА переехала в Брагу."))
    expect(names(shown)).toEqual(["the user", "Ольга Петрова"])
    expect(ids(shown)).toEqual(["m7", "m9"])
    expect(names(shownFor(world, turn("ОльгаПетрова")))).toEqual(["the user"])
  })

  test("a name is a run of whole words: part of a word names nothing", () => {
    expect(names(shownFor(world, turn("I ate a banana in Oporto with the Reisinger family.")))).toEqual(["the user"])
  })

  test("a label a part is read under names no entity, and is no word the source shares with a memory", () => {
    const knowledge = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Eva Novak"), entity("n3", "Tool", "organization"), entity("n4", "Host", "organization"),
      memory("m1", "Eva Novak likes jazz.", ["n2"]), memory("m2", "Eva Novak told the user a secret.", ["n2"]), memory("m3", "Tool is a band.", ["n3"]),
    ))
    const said = { said: parts(["user", "Eva Novak called."], called(`play, called with {"song":"Lateralus"}`, "playing"), ["host", "Plan renewed."], ["assistant", "Done."]) }
    // "Tool play, …" and "Host: …" are how a curator reads those parts: neither names the band or the organization.
    expect(names(shownFor(knowledge, said))).toEqual(["the user", "Eva Novak"])
    // "User: Eva Novak called." shares no "user" with m2, so the two stay in the order written.
    expect(ids(shownFor(knowledge, said))).toEqual(["m1", "m2"])
    // Said in the part itself, a name is found; and so is one the model put in a call's parameters.
    expect(names(shownFor(knowledge, turn("I saw Tool live.")))).toEqual(["the user", "Tool"])
    expect(names(shownFor(knowledge, { said: parts(["user", "Call her."], called(`dial, called with {"contact":"Eva Novak"}`, "ringing")) }))).toEqual(["the user", "Eva Novak"])
  })

  test("an entity the context names in full is shown after those the source names", () => {
    const shown = shownFor(world, turn("And she moved to Porto last month.", "User: My friend Ana Silva works at Acme.\nAssistant's final answer: Good to know."))
    expect(names(shown).slice(0, 4)).toEqual(["the user", "Porto", "Ana Silva", "Acme Labs"])
    expect(ids(shown)).toContain("m2")
  })

  test("a person's first name alone shows them, after those named in full, with what is stored about them", () => {
    const shown = shownFor(world, turn("Ana is thinking of quitting her job."))
    // Both Anas: the curator, and the context, tell which one is meant. A first name gives no places of its own.
    expect(names(shown).slice(0, 3)).toEqual(["the user", "Ana Silva", "Ana Costa"])
    expect(ids(shown)).toEqual(["m7", "m1", "m2", "m3", "m4"])
    // Only a person's: "Acme" is another name of Acme Labs, never its first name, and a pet's first name names nothing here.
    expect(names(shownFor(world, turn("The labs were cold.")))).toEqual(["the user"])
    // With the context naming one of them in full, that one comes first.
    expect(names(shownFor(world, turn("Ana is thinking of quitting.", "User: Ana Costa adopted a second cat.\nAssistant's final answer: Nice."))).slice(0, 3)).toEqual(["the user", "Ana Costa", "Ana Silva"])
  })

  test("memories that stand come before those that ended, then those that share most words with the source", () => {
    const knowledge = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Bruno Reis"),
      memory("m1", "Bruno Reis lived in Madrid.", ["n2"]), memory("m2", "Bruno Reis likes green tea.", ["n2"]), memory("m3", "Bruno Reis lives in Lisbon since June.", ["n2"]),
      ended("m1", "changed", { by: "m3" }),
    ))
    expect(ids(shownFor(knowledge, turn("Bruno Reis still lives in Madrid, right?")))).toEqual(["m3", "m2", "m1"])
  })

  test("among memories that share as many words, the latest said comes first", () => {
    const knowledge = knowledgeOf(journalOf(
      source("s1", undefined, { at: noon("2026-11-10") }), entity("n2", "Eva Novak"), memory("m1", "Eva Novak likes jazz.", ["n2"]), memory("m2", "Eva Novak likes tea.", ["n2"]),
      source("s2", undefined, { at: noon("2026-11-12") }), restated("m2", "s2"),
    ))
    expect(ids(shownFor(knowledge, turn("Eva Novak called.")))).toEqual(["m2", "m1"])
  })

  test("each entity named in full gets places of its own, so one that many memories mention cannot crowd a person out", () => {
    const many: ReadonlyArray<StoredDraft> = Array.from({ length: 12 }, (_, at) => memory(`m${at + 1}`, `Acme Labs opened office number ${at + 1} in Lisbon.`, ["n2"]))
    const knowledge = knowledgeOf(journalOf(
      source("s1"), entity("n2", "Acme Labs", "organization"), entity("n3", "Carla Mendes"),
      ...many, memory("m13", "Carla Mendes likes green tea.", ["n3"]), memory("m14", "Carla Mendes works at Acme Labs.", ["n3", "n2"]),
    ))
    const source13 = turn("Carla Mendes opened the Acme Labs office in Lisbon.")
    // By shared words alone, the twelve office memories take every place of ten.
    expect(ids(shownFor(knowledge, source13, { entities: 10, each: 30, memories: 10 }))).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"])
    // With three places each, Acme Labs takes three and Carla Mendes her two, before the rest is filled.
    expect(ids(shownFor(knowledge, source13, { entities: 10, each: 3, memories: 10 }))).toEqual(["m1", "m2", "m3", "m14", "m13", "m4", "m5", "m6", "m7", "m8"])
  })

  test("at most the given number of entities and of memories are shown, but every entity a shown memory is about", () => {
    const shown = shownFor(world, turn("Ana Silva, Ana Costa, Bruno Reis and João Reis met at Acme Labs in Lisbon."), { entities: 3, each: 30, memories: 2 })
    expect(ids(shown)).toEqual(["m7", "m1"])
    // The user and the first two named, then Acme Labs, which the shown memory m1 is about.
    expect(names(shown)).toEqual(["the user", "Ana Silva", "Ana Costa", "Acme Labs"])
    expect(shownFor(world, turn("Ana Silva."), { entities: 0, each: 0, memories: 0 })).toEqual({ entities: [], memories: [] })
  })

  test("a memory about no entity is not shown", () => {
    expect(ids(shownFor(world, turn("The launch was moved to February.")))).toEqual(["m7"])
  })

  test("the default limits are ten entities, thirty memories each and forty in all", () => {
    const drafts: ReadonlyArray<StoredDraft> = Array.from({ length: 45 }, (_, at) => memory(`m${at + 1}`, `Eva Novak said thing number ${at + 1}.`, ["n2"]))
    const crowd: ReadonlyArray<StoredDraft> = Array.from({ length: 12 }, (_, at) => entity(`n${at + 3}`, `Person${at + 3} Smith`))
    const knowledge = knowledgeOf(journalOf(source("s1"), entity("n2", "Eva Novak"), ...crowd, ...drafts))
    const shown = shownFor(knowledge, turn(`Eva Novak met ${Array.from({ length: 12 }, (_, at) => `Person${at + 3} Smith`).join(", ")}.`))
    expect(shown.entities).toHaveLength(10)
    // One entity with more than thirty memories: thirty places are its own, and the ten left are filled with more of them.
    expect(shown.memories).toHaveLength(40)
    const two = knowledgeOf(journalOf(source("s1"), entity("n2", "Eva Novak"), entity("n3", "Uma Weber"), ...drafts, ...Array.from({ length: 30 }, (_, at) => memory(`m${at + 46}`, `Uma Weber did thing number ${at + 1}.`, ["n3"]))))
    // Two such entities: the first named takes its thirty, and the second the ten that are left of forty.
    const about = shownFor(two, turn("Eva Novak met Uma Weber.")).memories.map((one) => String(one.about[0]))
    expect([about.length, about.filter((id) => id === "n2").length, about.filter((id) => id === "n3").length]).toEqual([40, 30, 10])
  })
})
