import { Effect, Option, Schema } from "effect"
import type { InvocationId } from "../domain/run.entity.js"
import type { ToolCallId } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { CurrentToolInvocation } from "../loop/stepContext.js"
import { RunContext } from "../ports/run-context.port.js"
import type { SubscribeOptions, Subscription, TurnEventsService } from "../ports/turn-events.port.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import type { TurnError } from "../session/sessions.entity.js"

import type { TurnEvent, TurnEventName, TurnEventOf } from "./turn-event.entity.js"

const isNamed = <Name extends TurnEventName>(name: Name) => (event: TurnEvent): event is TurnEventOf<Name> => event._tag === name

/** Subscribe to one event kind by name, typed by the event's schema (inline unless `options.mode` says background). */
export const onEvent = <Name extends TurnEventName, R>(
  name: Name,
  handle: (event: TurnEventOf<Name>) => Effect.Effect<void, TurnError, R>,
  options?: SubscribeOptions,
): Subscription<R> => (events) => events.subscribe((event) => Option.liftPredicate(event, isNamed(name)), handle, options)

/**
 * React to one tool's successful calls, typed by the tool's own schemas:
 * the input and result are narrowed with `Schema.is`, never cast.
 *
 * @public
 */
export interface ToolCall<Input, Result> {
  readonly step: number
  readonly invocationId: InvocationId
  readonly toolCallId?: ToolCallId
  readonly input: Input
  readonly result: Result
}

export const onTool = <Params extends Schema.Top, Success extends Schema.Top, R>(
  tool: { readonly name: string; readonly parametersSchema: Params; readonly successSchema: Success },
  handle: (call: ToolCall<Params["Type"], Success["Type"]>) => Effect.Effect<void, TurnError, R>,
  options?: SubscribeOptions,
): Subscription<R> => {
  const isInput = Schema.is(tool.parametersSchema)
  const isResult = Schema.is(tool.successSchema)
  return (events) => events.subscribe((event): Option.Option<ToolCall<Params["Type"], Success["Type"]>> => {
    if (event._tag !== "tool.completed" || event.tool !== tool.name || !event.ok) return Option.none()
    const input = event.input
    const result = event.result
    return isInput(input) && isResult(result)
      ? Option.some({ step: event.step, invocationId: event.invocationId, ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }), input, result })
      : Option.none()
  }, handle, options)
}

/** Attach several subscriptions to one bus. */
export const subscribeAll = <R>(events: TurnEventsService, subscriptions: ReadonlyArray<Subscription<R>>) =>
  Effect.forEach(subscriptions, (subscription) => subscription(events), { concurrency: 1, discard: true })

/**
 * An application's own typed event. Its name is the host's namespace
 * (e.g. `answer.published`); payloads are encoded with the schema and
 * carried as JSON (`storedJson`: `undefined` fields dropped), so a journal
 * sink can persist them like any other event. A payload that does not
 * encode, or whose encoded form JSON cannot hold (a BigInt), fails `make`
 * with `events.encode`.
 */
export const defineHostEvent = <A, I extends Readonly<Record<string, unknown>>>(name: string, schema: Schema.Codec<A, I>) => {
  const select = (event: TurnEvent): Option.Option<A> =>
    event._tag === "host" && event.name === name ? Schema.decodeUnknownOption(schema)(event.data) : Option.none()
  const make = (data: A): Effect.Effect<TurnEvent, HarnessError> => Schema.encodeEffect(schema)(data).pipe(
    Effect.flatMap(storedJson),
    Effect.map((encoded): TurnEvent => ({ _tag: "host", name, data: encoded })),
    Effect.mapError((error) => new HarnessError({ code: "events.encode", message: `${name}: ${error.message}` })),
  )
  return {
    name,
    make,
    select,
    publish: (events: TurnEventsService, data: A) => make(data).pipe(Effect.flatMap(events.publish)),
    on: <R>(handle: (data: A) => Effect.Effect<void, TurnError, R>, options?: SubscribeOptions): Subscription<R> =>
      (events) => events.subscribe(select, handle, options),
  }
}

/**
 * Report progress from inside a tool handler: publishes a transient
 * `tool.progress` with the call's step, invocation id and tool name (from
 * `CurrentToolInvocation`) on the run's bus. `channel` is `stdout` or
 * `stderr` for a command's output as it arrives, `status` for anything else.
 * Outside a tool call, or without a `RunContext`, it does nothing. As for
 * `tool.started`, a subscriber failure fails the turn: the handler stops
 * there, and the tool registry fails the turn after `tool.completed`
 * instead of handing the failure to the model as the tool's result.
 */
export const publishToolProgress = Effect.fnUntraced(function* (channel: TurnEventOf<"tool.progress">["channel"], text: string): Effect.fn.Return<void> {
  const invocation = yield* Effect.service(CurrentToolInvocation)
  const run = yield* Effect.serviceOption(RunContext)
  if (Option.isNone(invocation) || Option.isNone(run)) return
  yield* run.value.events.publish({ _tag: "tool.progress", ...invocation.value, channel, text }).pipe(Effect.orDie)
})
