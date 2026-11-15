import { Option } from "effect"
import { assistantMessageEvent, dataOf, messageOf, toolResultEvent, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { Message, Seq, StoredEvent, TurnNumber } from "@xandreed/core/kernel"
import { callAt, pairsOf } from "../memory/memory.entity.functions.js"
import type { CallRead, ResultRead, StepRead, TurnRead } from "./turns.entity.js"

/**
 * The message a record of the conversation bears, when the record is one of the three the kernel's own functions
 * write (`userMessage`, `modelAnswer`, `callTool`): read by the record's name. A plugin's record can bear a message
 * in the same role, and is no message, step or result of a turn.
 */
const saidBy = (event: StoredEvent): Option.Option<Message> =>
  event.name === userMessageEvent.name || event.name === assistantMessageEvent.name || event.name === toolResultEvent.name ? messageOf(event) : Option.none()

/** A record of the conversation with the message it bears. */
interface Said {
  readonly event: StoredEvent
  readonly message: Message
}

/**
 * The result each call of a journal has: by the place of the assistant record that asked and the call's place in
 * it. The pairs are `pairsOf`'s, the rule `paired` sends a conversation by, so what a test reads as a call's result
 * is what a model was sent as it.
 */
const resultsOf = (events: ReadonlyArray<StoredEvent>): ReadonlyMap<string, ResultRead> => {
  const said = events.flatMap((event): ReadonlyArray<Said> => Option.match(saidBy(event), { onNone: () => [], onSome: (message) => [{ event, message }] }))
  const pairs = pairsOf(said.map((one) => one.message))
  const results = new Map<string, ResultRead>()
  said.forEach(({ event, message }, at) => {
    if (message._tag !== "Assistant") return
    message.toolCalls.forEach((_, index) => {
      const answer = said[pairs.get(callAt(at, index)) ?? -1]
      if (answer?.message._tag === "ToolResult") results.set(`${event.seq} ${index}`, { seq: answer.event.seq, result: answer.message.result, isFailure: answer.message.isFailure })
    })
  })
  return results
}

/** One answer of the model as a step, each of its calls with the result the journal holds for it. */
const stepOf = (event: StoredEvent, results: ReadonlyMap<string, ResultRead>): ReadonlyArray<StepRead> =>
  Option.match(saidBy(event), {
    onNone: () => [],
    onSome: (message) => {
      if (message._tag !== "Assistant") return []
      const data = dataOf(assistantMessageEvent, event)
      return [{
        seq: event.seq,
        text: message.text,
        calls: message.toolCalls.map((call, index): CallRead => ({ ...call, result: Option.fromNullishOr(results.get(`${event.seq} ${index}`)) })),
        model: Option.flatMap(data, (known) => Option.fromNullishOr(known.model)),
        usage: Option.flatMap(data, (known) => Option.fromNullishOr(known.usage)),
      }]
    },
  })

/** One turn, from the records stored in it. */
const turnOf = (turn: TurnNumber, records: ReadonlyArray<StoredEvent>, results: ReadonlyMap<string, ResultRead>): TurnRead => {
  const place = (found: StoredEvent | undefined): Option.Option<Seq> => Option.map(Option.fromNullishOr(found), (one) => one.seq)
  const steps = records.flatMap((event) => stepOf(event, results))
  const last = Option.fromNullishOr(steps.at(-1))
  return {
    turn,
    opened: place(records.find((event) => event.name === turnStartedEvent.name)),
    messages: records.flatMap((event) => Option.match(saidBy(event), {
      onNone: () => [],
      onSome: (message) => (message._tag === "User" ? [{ seq: event.seq, text: message.text }] : []),
    })),
    steps,
    answer: Option.flatMap(last, (step) => (step.calls.length === 0 ? Option.some(step.text) : Option.none())),
    // The first record that closes the turn: the kernel writes one, and a later one changes nothing.
    closed: Option.fromNullishOr(records.flatMap((event) => Option.match(dataOf(turnEndedEvent, event), {
      onNone: () => [],
      onSome: ({ outcome }) => [{ seq: event.seq, outcome }],
    }))[0]),
    records,
  }
}

/**
 * A journal as its turns, in the order they first appear: for each, the messages it took, the steps the model
 * answered in with their calls and results, the answer, how it closed, and every record stored in it
 * (`TurnRead`). It is what a host's test checks after running its program on a scripted model, and what a client
 * draws a turn from.
 *
 * A pure function of the records, and total: it refuses no journal. A record belongs to the turn it was stored in
 * (`turn`), whatever its place. One it does not know is in its turn's `records` and nowhere else: this reads a
 * journal for a person or a test, and builds nothing a model is sent, so the rule a memory holds to (refuse a
 * record it does not know, or pass over one marked skippable) is not its rule.
 *
 * @public
 */
export const turnsOf = (events: ReadonlyArray<StoredEvent>): ReadonlyArray<TurnRead> => {
  const results = resultsOf(events)
  const byTurn = new Map<TurnNumber, Array<StoredEvent>>()
  for (const event of events) {
    const held = byTurn.get(event.turn)
    if (held === undefined) byTurn.set(event.turn, [event])
    else held.push(event)
  }
  return [...byTurn].map(([turn, records]) => turnOf(turn, records, results))
}
