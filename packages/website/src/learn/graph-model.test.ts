// Lesson 18's Graph tab, as a model with no DOM: the picture of the memory a
// knowledge session holds, a pure function of its records, drawn whether or
// not anything was asked; and what the latest curation did. The records are
// the world as Load the world writes them, and a few a curation would store.
// What the latest recall lit, and the recall's steps, are pinned on the page's
// runtime in the lesson's own test, where `withKnowledge` says them.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { SessionId, stored, TurnNumber } from "@xandreed/core"
import type { StoredEvent } from "@xandreed/core"
import { curatedEvent, curationFailedEvent, EntityId, entityEvent, knowledgeOf, memoryEndedEvent, memoryEvent, MemoryId, memoryRestatedEvent, SourceId, sourceEvent } from "@xandreed/sdk"
import type { StoredDraft } from "@xandreed/core"
import { COLUMN_ROWS, curationCutLine, latestCuration, memoryViewOf, MOST_SAID, namedBy, NEIGHBOURS, ordinal } from "./graph-model.ts"
import { worldDrafts } from "./lessons/connected-memory/load-world.ts"

/** Drafts as the journal stores them, each at its own time and place. */
const journalOf = (drafts: ReadonlyArray<{ readonly draft: StoredDraft; readonly at: number }>, from = 0): ReadonlyArray<StoredEvent> =>
  drafts.map(({ draft, at }, index) => ({ ...draft, seq: from + index + 1, turn: 1, at } as unknown as StoredEvent))

const CHAT = "chat-1"
const DAY = Date.parse("2026-11-18T12:00:00Z")
const s1 = SourceId.make("s1")
const s2 = SourceId.make("s2")
const n = (id: number) => EntityId.make(`n${id}`)
const m = (id: number) => MemoryId.make(`m${id}`)
const from = (turn: number) => ({ session: SessionId.make(CHAT), turn: TurnNumber.make(turn) })

/** Two turns of a chat, as curations stored them: Ana Silva works at Acme, Acme is in Lisbon; then she moved to Globex, and a guess was dropped. */
const TURNS = journalOf([
  stored(sourceEvent, { id: s1, said: [{ by: "user", text: "My friend Ana Silva works at Acme. Acme is in Lisbon." }], at: DAY, from: from(1) }),
  stored(entityEvent, { id: n(2), name: "Ana Silva", kind: "person", source: s1 }),
  stored(entityEvent, { id: n(3), name: "Acme", kind: "organization", source: s1 }),
  stored(entityEvent, { id: n(4), name: "Lisbon", kind: "place", source: s1 }),
  stored(memoryEvent, { id: m(1), kind: "fact", text: "Ana Silva works at Acme.", about: [n(2), n(3)], quote: "My friend Ana Silva works at Acme.", by: "user", source: s1 }),
  stored(memoryEvent, { id: m(2), kind: "fact", text: "Acme is in Lisbon.", about: [n(3), n(4)], quote: "Acme is in Lisbon.", by: "user", source: s1 }),
  stored(curatedEvent, { source: s1, calls: 1, kept: 5, dropped: [] }),
  stored(sourceEvent, { id: s2, said: [{ by: "user", text: "Ana Silva now works at Globex. Acme is in Lisbon." }], at: DAY + 60_000, from: from(2) }),
  stored(entityEvent, { id: n(5), name: "Globex", kind: "organization", source: s2 }),
  stored(memoryEvent, { id: m(3), kind: "fact", text: "Ana Silva works at Globex.", about: [n(2), n(5)], quote: "Ana Silva now works at Globex.", by: "user", source: s2 }),
  stored(memoryEndedEvent, { id: m(1), why: "changed", by: m(3), source: s2 }),
  stored(memoryRestatedEvent, { id: m(2), source: s2, quote: "Acme is in Lisbon." }),
  stored(curatedEvent, { source: s2, calls: 1, kept: 4, dropped: [{ what: 'memory "Ana Silva works at Acme."', why: "Its quote is not in what the user said, a tool returned or the host wrote." }] }),
].map((draft) => ({ draft, at: DAY })))

describe("the Graph tab's picture of the memory", () => {
  test("after a conversation's curations, with nothing asked: the user and what it named, on the left, and the memories between them, an ended one dashed and the latest curation's lit", () => {
    const knowledge = knowledgeOf(TURNS)
    const named = namedBy(knowledge, CHAT, [])
    expect(named).toEqual(["n1", "n2", "n3", "n4", "n5"])
    const view = memoryViewOf(TURNS, "named", named, Option.none(), latestCuration(TURNS))
    expect(view.heading).toBe(`The user and what the conversation named, with their neighbours, at most ${NEIGHBOURS} each, the most said first: 5 entities. The picture starts on the left from the first of them a memory is about, a column for each memory further.`)
    expect(view.counts).toBe("The knowledge session holds 5 entities and 3 memories, 1 of them ended.")
    // Ana Silva, the first named a memory is about, on the left; Acme and Globex a memory away; Lisbon two; the user,
    // whom no memory reaches, under the start.
    expect(view.things.map((thing) => `${thing.label} ${thing.column}:${thing.row}`)).toEqual(["Ana Silva 0:0", "the user 0:1", "Acme 1:0", "Globex 1:1", "Lisbon 2:0"])
    expect(view.edges.map((edge) => `${edge.id} ${edge.from}→${edge.to} w${edge.width}${edge.ended ? " ended" : ""} ${Option.getOrElse(edge.light, () => "-")}`)).toEqual([
      "m1 n2→n3 w2.5 ended curated", "m2 n3→n4 w4 curated", "m3 n2→n5 w2.5 curated",
    ])
    expect(view.edges[0]?.title).toBe("m1: Ana Silva works at Acme. (said on 2026-11-18; ended on 2026-11-18, changed)")
  })

  test("another conversation, which has named nothing kept yet: the entities said about most often, never an empty picture", () => {
    const view = memoryViewOf(TURNS, "named", namedBy(knowledgeOf(TURNS), "chat-2", []), Option.none(), Option.none())
    expect(view.heading).toBe(`The conversation has named nothing kept yet, so these are the ${MOST_SAID} entities said about most often, on the left, and their neighbours: 5 entities.`)
    expect(view.things[0]?.label).toBe("the user")
    expect(view.things.map((thing) => thing.label).toSorted()).toEqual(["Acme", "Ana Silva", "Globex", "Lisbon", "the user"])
    expect(view.edges.every((edge) => Option.isNone(edge.light))).toBe(true)
  })

  test("after Load the world, with nothing said: never an empty picture, but the entities said about most often, each with at most six neighbours; everything draws every entity, a long column wrapped", () => {
    const world = journalOf(worldDrafts(knowledgeOf([])).drafts)
    const knowledge = knowledgeOf(world)
    const view = memoryViewOf(world, "named", namedBy(knowledge, CHAT, []), Option.none(), latestCuration(world))
    expect(view.heading).toStartWith(`The conversation has named nothing kept yet, so these are the ${MOST_SAID} entities said about most often`)
    const first = view.things.filter((thing) => thing.column === 0)
    expect(first).toHaveLength(MOST_SAID + 1)
    expect(view.things.length).toBeGreaterThan(MOST_SAID + 1)
    expect(view.things.length).toBeLessThanOrEqual(MOST_SAID + 1 + MOST_SAID * NEIGHBOURS)
    expect(view.edges.length).toBeGreaterThan(0)
    // A memory about one entity is listed under it: "Ana Silva enjoys hiking." names no entity but her.
    expect(view.things.some((thing) => thing.alone.length > 0)).toBe(true)
    // Load the world's sources were curated by no model: no curation of a turn to show yet.
    expect(latestCuration(world)).toEqual(Option.none())
    const all = memoryViewOf(world, "everything", [], Option.none(), Option.none())
    expect(all.things).toHaveLength(knowledge.entities.length)
    expect(Math.max(...all.things.map((thing) => thing.row))).toBe(COLUMN_ROWS - 1)
    expect(all.heading).toBe(`Everything the knowledge session holds: ${knowledge.entities.length} entities, each in the column of how many memories away it is from where the picture starts.`)
  })
})

describe("the Graph tab's latest curation", () => {
  test("what it kept, ended, said again and dropped, each with why; a failed try says why, and that the next turn takes it up", () => {
    expect(latestCuration(TURNS)).toEqual(Option.some({
      heading: "Source s2 (turn 2 of a conversation): 1 model call, 1 new memory, 1 ended, 1 said again, 1 dropped.",
      lines: [
        "New: Ana Silva works at Globex.", "Ended (changed): Ana Silva works at Acme., replaced by Ana Silva works at Globex.", "Said again: Acme is in Lisbon.",
        'Dropped: memory "Ana Silva works at Acme.". Its quote is not in what the user said, a tool returned or the host wrote.',
      ],
      memories: ["m3", "m1", "m2"],
    }))
    const failed = [...TURNS, ...journalOf([{ draft: stored(curationFailedEvent, { source: s2, attempt: 2, reason: "the model gave no reply" }), at: DAY }], TURNS.length)]
    expect(latestCuration(failed)).toEqual(Option.some({ heading: "Source s2: try 2 failed.", lines: ["the model gave no reply", "The program's next turn takes it up again."], memories: [] }))
  })

  test("the status line's words when a curation is cut short", () => {
    expect(curationCutLine("s1")).toBe("Curating stopped: s1 was not kept yet, and the next turn takes it up.")
  })

  test("ranks in words", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"])
  })
})
