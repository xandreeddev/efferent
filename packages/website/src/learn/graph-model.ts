// What lesson 18's Graph tab shows, worked out from what the page heard: for
// one model call, what the walk of `withGraph` did. The kernel says it live
// for every request as `plugin.graph.recalled`, which the runtime forwards
// as every kernel event is (the `Event` trace); this file folds those, and
// the graph session's records, and draws one of them as a picture of the
// links the walk reached and a panel of its steps in words. Pure: no DOM,
// no clock. `panes/graph.ts` draws what these functions give.
import { Option } from "effect"
import { dataOf } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens, linkedEvent, linksNote, normalName, RECALL_SHOWN, recalledEvent, restatedEvent, saidOf, saidText, unlinkedEvent, weightOf } from "@xandreed/sdk/kernel"
import type { Link, RecalledData, SaidLink } from "@xandreed/sdk/kernel"
import type { Trace } from "./runtime.ts"

/** One request's walk, as the page heard it: the turn of the conversation, and which of its model calls (from 1). */
export interface HeardRecall {
  readonly turn: number
  readonly call: number
  readonly recalled: RecalledData
}

/**
 * Everything the Graph tab draws from: each walk heard in the conversation shown, in order, and the graph session's
 * records (its links, each saying again and each removal), whichever conversation stored them.
 */
export interface RecallBoard {
  readonly chat: string
  readonly recalls: ReadonlyArray<HeardRecall>
  readonly records: ReadonlyArray<StoredEvent>
}

export const emptyRecalls = (chat: string): RecallBoard => ({ chat, recalls: [], records: [] })

/** Whether a record is one of the graph's: a link stored, said again, or removed. */
const ofGraph = (record: StoredEvent): boolean =>
  Option.isSome(dataOf(linkedEvent, record)) || Option.isSome(dataOf(restatedEvent, record)) || Option.isSome(dataOf(unlinkedEvent, record))

/**
 * The board after one more trace: a walk said in the conversation shown is the next model call of its turn (memory
 * builds one context, and the walk runs once, for each call); a record of the graph's is kept, from any session. Any
 * other trace changes nothing, and the board is returned as it was.
 */
export const heardRecall = (board: RecallBoard, trace: Trace): RecallBoard => {
  if (trace._tag !== "Event") return board
  const event = trace.event
  if (event._tag === "Stored") {
    const { session: _session, _tag: _stored, ...record } = event
    return ofGraph(record) ? { ...board, records: [...board.records, record] } : board
  }
  if (event.session !== board.chat) return board
  return Option.match(dataOf(recalledEvent, event), {
    onNone: () => board,
    onSome: (recalled) => {
      const turn = event.turn ?? 0
      const call = board.recalls.filter((one) => one.turn === turn).length + 1
      return { ...board, recalls: [...board.recalls, { turn, call, recalled }] }
    },
  })
}

/** The board as a new conversation starts (Clear context): its walks are the old conversation's, the graph's records stay. */
export const recallsStartedOver = (board: RecallBoard, chat: string): RecallBoard => ({ chat, recalls: [], records: board.records })

/** Which walk the tab shows: the latest, or one picked by its turn and call. */
export type RecallPick = { readonly _tag: "Latest" } | { readonly _tag: "Call"; readonly turn: number; readonly call: number }

/** The walk picked, when the board holds it; the latest, when it holds none picked. */
export const pickedRecall = (board: RecallBoard, pick: RecallPick): Option.Option<HeardRecall> =>
  pick._tag === "Call"
    ? Option.orElse(Option.fromNullishOr(board.recalls.find((one) => one.turn === pick.turn && one.call === pick.call)), () => Option.fromNullishOr(board.recalls.at(-1)))
    : Option.fromNullishOr(board.recalls.at(-1))

/** How many model calls a turn has a walk for. */
const callsOf = (board: RecallBoard, turn: number): number => board.recalls.filter((one) => one.turn === turn).length

/** A walk's name in the tab's picker: its turn, and its model call when the turn made more than one. */
export const recallLabel = (board: RecallBoard, heard: HeardRecall): string => {
  const calls = callsOf(board, heard.turn)
  return calls > 1 ? `Turn ${heard.turn}, model call ${heard.call} of ${calls}` : `Turn ${heard.turn}`
}

/** What the tab says while it has no walk to draw. */
export const NO_WALK = "No request of this conversation has been walked yet. Send a message: withGraph walks the graph for each model call, and the walk shows here. A memory.ts without withGraph walks nothing, and nothing shows."

/** What the panel says of a question that named nothing. */
export const NAMED_NOTHING = "The question named nothing the graph holds: no links were sent."

/** How a thing was named, in words. */
export type NamedHow = "words" | "loose" | "speaker"

/** A thing the picture draws: its name as the graph tells things apart, as a link writes it, and where it goes. */
export interface ThingView {
  readonly key: string
  readonly label: string
  /** How many links away from a thing the question named: 0 for a named thing. */
  readonly column: number
  /** Its place in its column, from 0, the best ranked first. */
  readonly row: number
  readonly named: Option.Option<NamedHow>
}

/** A link the picture draws, from the thing the walk reached it from to its other end. */
export interface EdgeView {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly relation: string
  /** Its place among the links reached, best first, from 1. */
  readonly rank: number
  readonly sent: boolean
  /** How thick it is drawn: by how many turns said it, against the link reached that was said most. From 1 to 4. */
  readonly width: number
  /** What it says when pointed at. */
  readonly title: string
}

/** One link of the walk as the panel lists it. */
export interface RankedRow {
  readonly rank: number
  readonly id: string
  readonly sentence: string
  /** How many links away, and from what. */
  readonly reached: string
  /** The question's words its path met, each once. */
  readonly met: ReadonlyArray<string>
  /** How many turns said it, and when it was last said, in the words the note sends beside it (`saidText`). */
  readonly said: string
  /** Its weight, when the walk weighed links. */
  readonly weight: Option.Option<string>
  readonly sent: boolean
  /** Why it was not sent, for a link that was not. */
  readonly why: Option.Option<string>
}

/** What the tab draws of one walk. */
export interface GraphView {
  readonly question: string
  /** The options the walk ran with, as memory.ts writes them. */
  readonly options: string
  /** Step 1: each thing the question named, and how. */
  readonly named: ReadonlyArray<string>
  /** Said when the question named nothing. */
  readonly nothing: Option.Option<string>
  /** Step 2: how far the walk went, and how many links it reached. */
  readonly walk: string
  readonly rows: ReadonlyArray<RankedRow>
  /** The links reached past the event's list, counted. */
  readonly more: Option.Option<string>
  /** Step 3: the note sent, its size, and the size of sending every link. */
  readonly sent: string
  readonly things: ReadonlyArray<ThingView>
  readonly edges: ReadonlyArray<EdgeView>
}

/** A rank in words: 1st, 2nd, 3rd, 11th, 21st. */
export const ordinal = (n: number): string => {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"
  return `${n}${suffix}`
}

/** A number of tokens as the panel writes it: 4,400. */
const tokens = (n: number): string => n.toLocaleString("en-US")

/** A name with its accent marks taken off, as loose naming reads one. */
const withoutMarks = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")

/** Whether a name a link writes is the thing an event names: by the graph's own rule, or with accent marks off (loose naming). */
const isThing = (written: string, key: string): boolean => normalName(written) === key || withoutMarks(normalName(written)) === withoutMarks(key)

/** The options a walk ran with, as memory.ts writes them. */
const optionsOf = (recalled: RecalledData): string => {
  const weights = recalled.weights === null ? "none" : recalled.weights === "count" ? '"count"' : `{ halfLifeDays: ${recalled.weights.halfLifeDays} }`
  return `hops: ${recalled.hops} · limit: ${recalled.limit} · names: "${recalled.names}" · weights: ${weights}`
}

/** How a thing was named, in words. */
const namedWords = (one: RecalledData["named"][number]): string =>
  one.by === "words" ? `${one.thing}, by its own words in the question: "${one.words.join(" ")}"`
    : one.by === "loose" ? `${one.thing}, loosely: the question's "${one.words.join(" ")}" is a letter away from it, or the same without accent marks`
      : `${one.thing}, the speaker: the question holds "${one.words.join(" ")}"`

/**
 * What the tab draws of one walk: the things named and how, every link reached (at most `RECALL_SHOWN`), ranked, with
 * the words its path met, how often and when it was said, its weight when links were weighed, and whether it was sent
 * and why not; the note's size in tokens against the size of sending every link the graph holds; and the picture,
 * each thing in a column by how many links away from a named thing it is. `records` are the graph session's, as
 * heard: what every link says, its count and its last day, for the weights and the sizes. Nothing here reads a clock.
 */
export const graphViewOf = (recalled: RecalledData, records: ReadonlyArray<StoredEvent>): GraphView => {
  const everStored = new Map<string, Link>(records.flatMap((record) => Option.toArray(dataOf(linkedEvent, record))).map((link) => [link.id, link]))
  const standing = saidOf(records)
  const reached = recalled.reached
  const total = reached.length + recalled.more
  // Each link reached as the note was given it: the link, and how often and when it was said at that request.
  const saying = reached.map((one): Option.Option<SaidLink> => Option.map(Option.fromNullishOr(everStored.get(one.id)), (link) => ({ link, count: one.count, last: one.last })))
  const sentLinks = reached.flatMap((one, at) => (one.sent ? Option.toArray(saying[at] ?? Option.none()) : []))
  const weights = recalled.weights
  // A weight is shown as the kernel orders by it: by count, ln(1 + count); by a half-life, against the heaviest link
  // reached, which needs no clock (each weight decays by the same factor at any moment).
  const weightsOf = saying.map((said) => Option.map(said, (one) => (weights === null ? 0 : weightOf(one, weights))))
  const heaviest = Math.max(...weightsOf.flatMap(Option.toArray))
  const mostSaid = Math.max(1, ...reached.map((one) => one.count))
  const rows = reached.map((one, at): RankedRow => {
    const rank = at + 1
    const fromLabel = one.via === null ? `named ${one.from}` : `${one.from}, reached by ${one.via}`
    return {
      rank, id: one.id, sentence: `${one.subject} ${one.relation} ${one.object}`,
      reached: `${one.hops} link${one.hops === 1 ? "" : "s"} away, from ${fromLabel}`,
      met: [...new Set(one.met)],
      // The note's own words for it, so the panel and what the model read never disagree about a day.
      said: Option.match(saying[at] ?? Option.none(), { onNone: () => "how often it was said is not known here", onSome: saidText }),
      weight: weights === null ? Option.none() : Option.map(Option.flatten(Option.fromNullishOr(weightsOf[at])), (weight) =>
        weights === "count" ? `weight ${weight.toFixed(2)}` : `weight ${Math.exp(weight - heaviest).toFixed(2)} of the heaviest reached`),
      sent: one.sent,
      why: one.sent ? Option.none() : Option.some(`${one.met.length === 0 ? "met no word of the question, and " : ""}ranked ${ordinal(rank)}, past the limit of ${recalled.limit}`),
    }
  })

  // The picture: a named thing in the first column, each other thing in the column of how many links away it is.
  const columns = new Map<string, number>(recalled.named.map((one) => [one.thing, 0]))
  const labels = new Map<string, string>()
  const ends = reached.map((one) => {
    const to = isThing(one.subject, one.from) ? one.object : one.subject
    const toKey = normalName(to)
    labels.set(toKey, labels.get(toKey) ?? to)
    const fromWritten = isThing(one.subject, one.from) ? one.subject : one.object
    labels.set(one.from, labels.get(one.from) ?? fromWritten)
    columns.set(one.from, Math.min(columns.get(one.from) ?? Infinity, one.hops - 1))
    columns.set(toKey, Math.min(columns.get(toKey) ?? Infinity, one.hops))
    return { from: one.from, to: toKey }
  })
  // Rows: each column's things in the order the links best ranked first name them, the named things first of all.
  const order = [...recalled.named.map((one) => one.thing), ...ends.flatMap((end) => [end.from, end.to])]
  const placed = new Map<string, number>()
  const filled = new Map<number, number>()
  for (const key of order) {
    if (placed.has(key)) continue
    const column = columns.get(key) ?? 0
    placed.set(key, filled.get(column) ?? 0)
    filled.set(column, (filled.get(column) ?? 0) + 1)
  }
  const things = [...placed].map(([key, row]): ThingView => ({
    key, label: labels.get(key) ?? key, column: columns.get(key) ?? 0, row,
    named: Option.map(Option.fromNullishOr(recalled.named.find((one) => one.thing === key)), (one) => one.by),
  }))
  const edges = reached.map((one, at): EdgeView => ({
    id: one.id, from: ends[at]!.from, to: ends[at]!.to, relation: one.relation, rank: at + 1, sent: one.sent,
    width: Math.round((1 + (3 * one.count) / mostSaid) * 10) / 10,
    title: `${one.id}: ${one.subject} ${one.relation} ${one.object}. Ranked ${ordinal(at + 1)}, ${one.sent ? "sent" : "not sent"}; ${rows[at]!.said}.`,
  }))
  return {
    question: recalled.question,
    options: optionsOf(recalled),
    named: recalled.named.map(namedWords),
    nothing: recalled.named.length === 0 ? Option.some(NAMED_NOTHING) : Option.none(),
    walk: recalled.named.length === 0 ? "The walk did not start: there was nothing to start from."
      : `The walk reached ${total} link${total === 1 ? "" : "s"}, up to ${recalled.hops} link${recalled.hops === 1 ? "" : "s"} away from what was named, ranked best first: by the question's words their path met, then fewer links away${weights === null ? "" : ", then the heavier"}, then the newer.`,
    rows,
    more: recalled.more > 0 ? Option.some(`And ${recalled.more} more link${recalled.more === 1 ? "" : "s"} reached, ranked after these: the panel lists the first ${RECALL_SHOWN}.`) : Option.none(),
    sent: sentLinks.length === 0
      ? `Sent no link. Sending every link the graph holds, all ${tokens(standing.length)}, would take about ${tokens(Number(estimateTokens(linksNote(standing))))} tokens.`
      : `Sent ${sentLinks.length} of the ${tokens(total)} links reached, in a note of about ${tokens(Number(estimateTokens(linksNote(sentLinks))))} tokens. Sending every link the graph holds, all ${tokens(standing.length)}, would take about ${tokens(Number(estimateTokens(linksNote(standing))))} tokens.`,
    things,
    edges,
  }
}
