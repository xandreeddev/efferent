import { Effect, Option, Schema } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import type { Subscription, TurnEventsService } from "../ports/turn-events.port.js"
import { TransientTurnEvents, TurnEvent as TurnEventSchema } from "./turn-event.entity.js"
import type { TurnEvent, TurnEventName, TurnEventOf } from "./turn-event.entity.js"

const isNamed = <Name extends TurnEventName>(name: Name) => (event: TurnEvent): event is TurnEventOf<Name> => event._tag === name

/** Subscribe to one event kind by name, typed by the event's schema. */
export const onEvent = <Name extends TurnEventName, R>(
  name: Name,
  handle: (event: TurnEventOf<Name>) => Effect.Effect<void, HarnessError, R>,
): Subscription<R> => (events) => events.subscribe((event) => Option.liftPredicate(event, isNamed(name)), handle)

/**
 * React to one tool's successful calls, typed by the tool's own schemas:
 * the input and result are narrowed with `Schema.is`, never cast.
 */
export interface ToolCall<Input, Result> {
  readonly step: number
  readonly invocationId: string
  readonly input: Input
  readonly result: Result
}

export const onTool = <Params extends Schema.Schema.Any, Success extends Schema.Schema.Any, R>(
  tool: { readonly name: string; readonly parametersSchema: Params; readonly successSchema: Success },
  handle: (call: ToolCall<Schema.Schema.Type<Params>, Schema.Schema.Type<Success>>) => Effect.Effect<void, HarnessError, R>,
): Subscription<R> => {
  const isInput = Schema.is(tool.parametersSchema)
  const isResult = Schema.is(tool.successSchema)
  return (events) => events.subscribe((event): Option.Option<ToolCall<Schema.Schema.Type<Params>, Schema.Schema.Type<Success>>> => {
    if (event._tag !== "tool.completed" || event.tool !== tool.name || !event.ok) return Option.none()
    const input = event.input
    const result = event.result
    return isInput(input) && isResult(result)
      ? Option.some({ step: event.step, invocationId: event.invocationId, input, result })
      : Option.none()
  }, handle)
}

/** Attach several subscriptions to one bus. */
export const subscribeAll = <R>(events: TurnEventsService, subscriptions: ReadonlyArray<Subscription<R>>) =>
  Effect.forEach(subscriptions, (subscription) => subscription(events), { discard: true })

/**
 * An application's own typed event. Its name is the host's namespace
 * (e.g. `answer.published`); payloads are encoded with the schema, so a
 * journal sink can persist them like any other event.
 */
export const defineHostEvent = <A, I extends Readonly<Record<string, unknown>>>(name: string, schema: Schema.Schema<A, I>) => {
  const select = (event: TurnEvent): Option.Option<A> =>
    event._tag === "host" && event.name === name ? Schema.decodeUnknownOption(schema)(event.data) : Option.none()
  const make = (data: A): Effect.Effect<TurnEvent, HarnessError> => Schema.encode(schema)(data).pipe(
    Effect.map((encoded): TurnEvent => ({ _tag: "host", name, data: encoded })),
    Effect.mapError((error) => new HarnessError({ code: "events.encode", message: `${name}: ${error.message}` })),
  )
  return {
    name,
    make,
    select,
    publish: (events: TurnEventsService, data: A) => make(data).pipe(Effect.flatMap(events.publish)),
    on: <R>(handle: (data: A) => Effect.Effect<void, HarnessError, R>): Subscription<R> => (events) => events.subscribe(select, handle),
  }
}

const encodeEvent = Schema.encodeSync(TurnEventSchema)

/**
 * The journal form of one event: its name and encoded payload. Transient
 * events have none; a completed tool keeps only its encoded result.
 */
export const journalBodyOf = (runId: string, event: TurnEvent): Option.Option<EventBody> => {
  if (TransientTurnEvents.includes(event._tag)) return Option.none()
  if (event._tag === "host") return Option.some({ name: event.name, runId, data: event.data })
  const { _tag, ...data } = encodeEvent(event)
  const payload: Record<string, unknown> = _tag === "tool.completed"
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "result"))
    : data
  return Option.some({ name: _tag, runId, data: payload })
}
