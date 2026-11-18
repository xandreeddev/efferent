// Lesson 18's Graph tab, as a model with no DOM: the fold of what the page
// heard (each walk the kernel said, by turn and model call, and the graph
// session's records), and the drawing of one walk, a pure function of the
// kernel's `RecalledData` and those records. The walks are the kernel's own
// (`walked`, `recalledOf`) over the journal the page's Load the world
// writes, or heard on the page's runtime with Echo.
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { kernel, Sessions } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { graphSession, inProcessJournal, recalledOf, saidOf, saidText, sessions, walked, weightOf } from "@xandreed/sdk/kernel"
import type { GraphOptions, Link } from "@xandreed/sdk/kernel"
import { emptyRecalls, graphViewOf, heardRecall, NAMED_NOTHING, ordinal, pickedRecall, recallLabel, recallsStartedOver } from "./graph-model.ts"
import type { RecallBoard } from "./graph-model.ts"
import { connectedMemory, QUESTION, SEVEN } from "./lessons/connected-memory/lesson.ts"
import { loadWorld } from "./lessons/connected-memory/load-world.ts"
import { loadEcho } from "./models/mock.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/** The graph session's journal as Load the world writes it, on a store of its own: the world, and nothing before it. */
const worldJournal = (): Promise<ReadonlyArray<StoredEvent>> => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const built = yield* Layer.build(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))
  const store = Context.get(built, Sessions)
  yield* loadWorld.pipe(Effect.provideService(Sessions, store))
  const id = yield* graphSession.pipe(Effect.provideService(Sessions, store))
  return (yield* store.read(id)).events
})))

/** What withGraph says of a walk over these records, as the kernel builds it: `walked`, its weights, and `recalledOf`. */
const recalledOver = (records: ReadonlyArray<StoredEvent>, question: string, options: GraphOptions) => {
  const said = saidOf(records)
  const byId = new Map(said.map((one) => [one.link.id, options.weights === undefined ? 0 : weightOf(one, options.weights)]))
  const weigh = (link: Link) => byId.get(link.id) ?? 0
  const walk = walked(said.map((one) => one.link), question, { ...options, ...(options.weights === undefined ? {} : { weigh }) })
  return recalledOf(question, options, walk, said)
}

describe("the Graph tab's fold of what the page heard", () => {
  test("each walk said in the conversation is the next model call of its turn; the graph session's records are kept; a new conversation keeps the records and drops the walks", async () => {
    const runtime = await LessonRuntime.create(connectedMemory)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    let board: RecallBoard = emptyRecalls(runtime.conversation)
    const heard: Array<Trace> = []
    runtime.onTrace((trace) => { heard.push(trace); board = heardRecall(board, trace) })
    expect(await runtime.start(Object.fromEntries(connectedMemory.files.map((file) => [file.id, file.defaultText])))).toEqual({ _tag: "Built" })
    for (const message of [SEVEN, QUESTION]) {
      const done = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve() } }) })
      runtime.send(message)
      await done
    }
    // Turn 1 called the model twice (the seven calls, then the answer), turn 2 once: one walk each.
    expect(board.recalls.map((one) => [one.turn, one.call, one.recalled.question])).toEqual([[1, 1, SEVEN], [1, 2, SEVEN], [2, 1, QUESTION]])
    expect(board.recalls.map((one) => recallLabel(board, one))).toEqual(["Turn 1, model call 1 of 2", "Turn 1, model call 2 of 2", "Turn 2"])
    // The records of the graph session: the seven links, heard as they were stored, and nothing of the conversation's.
    expect(board.records.map((one) => String(one.name))).toEqual(Array.from({ length: 7 }, () => "plugin.graph.linked"))
    // The latest is shown unless one is picked; a pick the board no longer holds falls back to the latest.
    expect(Option.map(pickedRecall(board, { _tag: "Latest" }), (one) => one.turn)).toEqual(Option.some(2))
    expect(Option.map(pickedRecall(board, { _tag: "Call", turn: 1, call: 2 }), (one) => [one.turn, one.call])).toEqual(Option.some([1, 2]))
    expect(Option.map(pickedRecall(board, { _tag: "Call", turn: 9, call: 1 }), (one) => one.turn)).toEqual(Option.some(2))
    // Any other trace leaves the board as it was.
    const prompt = heard.find((trace) => trace._tag === "Prompt")!
    expect(heardRecall(board, prompt)).toBe(board)
    const next = recallsStartedOver(board, "the-next-conversation")
    expect([next.chat, next.recalls, next.records]).toEqual(["the-next-conversation", [], board.records])
    // A walk said in another conversation is not this one's.
    const walk = heard.findLast((trace) => trace._tag === "Event" && trace.event._tag === "Live")!
    expect(heardRecall(next, walk)).toBe(next)
  })
})

describe("the Graph tab's drawing of one walk", () => {
  test("the page's first question over its seven links: the things by how far they are, each link from the thing it was reached from, the two sent first lit, the rest dimmed with why", async () => {
    const runtime = await LessonRuntime.create(connectedMemory)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    let board: RecallBoard = emptyRecalls(runtime.conversation)
    runtime.onTrace((trace) => { board = heardRecall(board, trace) })
    await runtime.start(Object.fromEntries(connectedMemory.files.map((file) => [file.id, file.defaultText])))
    for (const message of [SEVEN, QUESTION]) {
      const done = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve() } }) })
      runtime.send(message)
      await done
    }
    const view = graphViewOf(board.recalls.at(-1)!.recalled, board.records)
    expect(view.question).toBe(QUESTION)
    expect(view.options).toBe('hops: 2 · limit: 5 · names: "exact" · weights: none')
    expect(view.named).toEqual(['ana, by its own words in the question: "ana"'])
    expect(view.nothing).toEqual(Option.none())
    expect(view.walk).toBe("The walk reached 6 links, up to 2 links away from what was named, ranked best first: by the question's words their path met, then fewer links away, then the newer.")
    expect(view.rows.map((row) => [row.rank, row.id, row.sentence, row.reached, row.met, row.sent, Option.getOrNull(row.why)])).toEqual([
      [1, "e1", "Ana works at Acme", "1 link away, from named ana", ["work"], true, null],
      [2, "e2", "Acme is in Lisbon", "2 links away, from acme, reached by e1", ["work"], true, null],
      [3, "e7", "Ana drives a red car", "1 link away, from named ana", [], true, null],
      [4, "e6", "Ana is the sister of Eva", "1 link away, from named ana", [], true, null],
      [5, "e4", "Ana likes tea", "1 link away, from named ana", [], true, null],
      [6, "e3", "Ana lives in Porto", "1 link away, from named ana", [], false, "met no word of the question, and ranked 6th, past the limit of 5"],
    ])
    expect(view.rows.every((row) => row.said.startsWith("said once, last ") && Option.isNone(row.weight))).toBe(true)
    expect(view.sent).toBe("Sent 5 of the 6 links reached, in a note of about 121 tokens. Sending every link the graph holds, all 7, would take about 148 tokens.")
    // Ana, named, on the left; her links' other ends one column on; Lisbon, two links away, the next.
    expect(view.things.map((thing) => [thing.key, thing.label, thing.column, thing.row, Option.getOrNull(thing.named)])).toEqual([
      ["ana", "Ana", 0, 0, "words"], ["acme", "Acme", 1, 0, null], ["lisbon", "Lisbon", 2, 0, null], ["a red car", "a red car", 1, 1, null],
      ["eva", "Eva", 1, 2, null], ["tea", "tea", 1, 3, null], ["porto", "Porto", 1, 4, null],
    ])
    // Each link from the thing the walk reached it from: Acme is in Lisbon goes from Acme, which e1 led to. Every link
    // was said once, so each is drawn as thick as the most said.
    expect(view.edges.map((edge) => [edge.id, edge.from, edge.to, edge.rank, edge.sent, edge.width])).toEqual([
      ["e1", "ana", "acme", 1, true, 4], ["e2", "acme", "lisbon", 2, true, 4], ["e7", "ana", "a red car", 3, true, 4],
      ["e6", "ana", "eva", 4, true, 4], ["e4", "ana", "tea", 5, true, 4], ["e3", "ana", "porto", 6, false, 4],
    ])
    // How often and when, in the note's words, read from the journal: the page's clock is the real one.
    const e3 = saidOf(board.records).find((one) => one.link.id === "e3")!
    expect(view.edges[5]?.title).toBe(`e3: Ana lives in Porto. Ranked 6th, not sent; ${saidText(e3)}.`)
    expect(view.rows[5]?.said).toBe(saidText(e3))
  })

  test("over the world: a question named loosely, links weighed by count, how often each was said and when, and the thickness of each link against the most said", async () => {
    const records = await worldJournal()
    const recalled = recalledOver(records, "Where does Eva Nowak work now?", { hops: 2, limit: 5, names: "loose", weights: "count" })
    const view = graphViewOf(recalled, records)
    expect(view.options).toBe('hops: 2 · limit: 5 · names: "loose" · weights: "count"')
    expect(view.named).toEqual(['eva novak, loosely: the question\'s "eva nowak" is a letter away from it, or the same without accent marks'])
    expect(view.rows.slice(0, 2).map((row) => [row.sentence, row.met, row.said, Option.getOrNull(row.weight), row.sent])).toEqual([
      ["Eva Novak works at Globex", ["work"], "said 3 times, last 2025-05-03", "weight 1.39", true],
      ["Eva Novak works at Cyberdyne", ["work"], "said once, last 2026-08-10", "weight 0.69", true],
    ])
    expect(view.things[0]).toEqual({ key: "eva novak", label: "Eva Novak", column: 0, row: 0, named: Option.some("loose") })
    // The most said link the walk reached was said 4 times, and is drawn 4 wide: one said 3 times 3.3, one said once 1.8.
    expect(Math.max(...recalled.reached.map((one) => one.count))).toBe(4)
    expect(view.edges.filter((edge) => edge.width === 4)).toHaveLength(recalled.reached.filter((one) => one.count === 4).length)
    expect(view.edges.slice(0, 2).map((edge) => [edge.from, edge.to, edge.width])).toEqual([["eva novak", "globex", 3.3], ["eva novak", "cyberdyne", 1.8]])
  })

  test("over the world: by a half-life, a weight is said against the heaviest link reached, which needs no clock", async () => {
    const records = await worldJournal()
    const view = graphViewOf(recalledOver(records, "Where does Eva Novak work now?", { hops: 2, limit: 5, names: "loose", weights: { halfLifeDays: 365 } }), records)
    expect(view.rows.slice(0, 2).map((row) => [row.sentence, Option.getOrNull(row.weight)])).toEqual([
      ["Eva Novak works at Cyberdyne", "weight 0.36 of the heaviest reached"],
      ["Eva Novak works at Globex", "weight 0.30 of the heaviest reached"],
    ])
  })

  test("over the world: a walk of two links names João Reis by his written name, with his accent mark, and the second link goes from him", async () => {
    const records = await worldJournal()
    const view = graphViewOf(recalledOver(records, "Where does the person who leads Project Orchid live?", { hops: 2, limit: 5, names: "loose" }), records)
    expect(view.rows[0]).toMatchObject({ sentence: "João Reis lives in Porto", reached: "2 links away, from joão reis, reached by e24", met: ["leads", "live"], sent: true })
    expect(view.things.slice(0, 3).map((thing) => [thing.key, thing.label, thing.column])).toEqual([["project orchid", "Project Orchid", 0], ["joão reis", "João Reis", 1], ["porto", "Porto", 2]])
    expect(view.edges[0]).toMatchObject({ from: "joão reis", to: "porto", sent: true })
  })

  test("a question that names nothing: said in words, no row and no picture, and the size of every link", async () => {
    const records = await worldJournal()
    const view = graphViewOf(recalledOver(records, "What city is it in?", { hops: 2, limit: 5 }), records)
    expect(view.nothing).toEqual(Option.some(NAMED_NOTHING))
    expect(NAMED_NOTHING).toBe("The question named nothing the graph holds: no links were sent.")
    expect([view.named, view.rows, view.things, view.edges]).toEqual([[], [], [], []])
    expect(view.walk).toBe("The walk did not start: there was nothing to start from.")
    expect(view.sent).toBe("Sent no link. Sending every link the graph holds, all 557, would take about 9,232 tokens.")
  })

  test("a walk that reached more than the event lists counts the rest", async () => {
    const records = await worldJournal()
    const recalled = recalledOver(records, "Who works at Acme Labs?", { hops: 3, limit: 5 })
    expect(recalled.reached).toHaveLength(100)
    expect(recalled.more).toBeGreaterThan(0)
    const view = graphViewOf(recalled, records)
    expect(view.more).toEqual(Option.some(`And ${recalled.more} more links reached, ranked after these: the panel lists the first 100.`))
    expect(view.walk.startsWith(`The walk reached ${100 + recalled.more} links, up to 3 links away`)).toBe(true)
  })

  test("a rank in words", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 16, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "16th", "21st", "22nd", "101st"])
  })
})
