// Lesson 18's Graph tab, as a model with no DOM: the drawing of one walk of
// the graph contract, a pure function of the kernel's `RecalledData` and the
// graph session's records. The walks are the kernel's own (`walked`,
// `recalledOf`) over the world written as links. Lesson 18's page keeps its
// memory with a curator now and makes no walk of the graph; the tab's
// drawing of the knowledge session replaces this one in the lesson's next
// part, with its own tests.
import { describe, expect, test } from "bun:test"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { kernel, SessionId, Sessions, stored, TurnNumber } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { graphSession, inProcessJournal, LinkId, linkedEvent, normalName, recalledOf, restatedEvent, saidOf, saidText, sessions, walked, weightOf } from "@xandreed/sdk/kernel"
import type { GraphOptions, Link } from "@xandreed/sdk/kernel"
import { graphViewOf, NAMED_NOTHING, ordinal } from "./graph-model.ts"
import { clockAt } from "./lessons/connected-memory/load-world.ts"
import { WORLD } from "./lessons/connected-memory/world.ts"

/**
 * The world as links in a graph session of its own, as lesson 18 loaded it before its curator: each sentence
 * `plugin.graph.linked` the first time its parts are seen and `plugin.graph.restated` after, each at midnight of its
 * day. The Graph tab still draws the graph's walks; lesson 18's page no longer makes any.
 */
const worldJournal = (): Promise<ReadonlyArray<StoredEvent>> => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const built = yield* Layer.build(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))
  const store = Context.get(built, Sessions)
  const id = yield* graphSession.pipe(Effect.provideService(Sessions, store))
  const live = yield* Clock.Clock
  const known = new Map<string, LinkId>()
  yield* store.turn(id, (session) => Effect.forEach(WORLD, ([subject, relation, object, said], index) => {
    const key = [subject, relation, object].map(normalName).join("|")
    const from = { session: SessionId.make("world"), turn: TurnNumber.make(index + 1) }
    const again = known.get(key)
    const link = again ?? LinkId.make(`e${known.size + 1}`)
    if (again === undefined) known.set(key, link)
    const draft = again === undefined ? stored(linkedEvent, { id: link, subject, relation, object, from }) : stored(restatedEvent, { id: again, from })
    return session.append(draft).pipe(Effect.provideService(Clock.Clock, clockAt(Date.parse(`${said}T00:00:00Z`), live)))
  }, { concurrency: 1, discard: true }))
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

describe("the Graph tab's drawing of one walk", () => {
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
