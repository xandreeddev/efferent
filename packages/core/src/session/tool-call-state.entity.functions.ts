import { Effect, Match, Option, Schema, Struct } from "effect"
import type { ToolCallId } from "../domain/message.entity.js"
import { RunOrdinal } from "../domain/run.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import { StepStartedEvent, ToolCompletedEvent, ToolRefusedEvent, ToolStartedEvent } from "../turn/turn-event.entity.js"
import { entryOfEvent, journalSchemaOf } from "./session-event.entity.functions.js"
import type { SessionLogEvent } from "./session-log.entity.js"
import type { ToolCallResult, ToolCallReturn, ToolCallStart, ToolCallState } from "./tool-call-state.entity.js"

// These are typed views of the fields read after the journal's own decoder.
const started = Schema.Struct(Struct.pick(ToolStartedEvent.fields, ["toolCallId", "invocationId", "step", "tool", "input"]))
const returned = Schema.Struct(Struct.pick(ToolCompletedEvent.fields, ["toolCallId", "invocationId", "step", "tool", "ok"]))
const refused = Schema.Struct(Struct.pick(ToolRefusedEvent.fields, ["toolCallId", "invocationId", "step", "tool", "reason", "message"]))
const stepStarted = Schema.Struct(Struct.pick(StepStartedEvent.fields, ["step", "run"]))
const facts = {
  "tool.started": started,
  "tool.completed": returned,
  "tool.refused": refused,
} as const

type Request = Extract<ToolCallState, { readonly _tag: "Requested" }>
type Lifecycle =
  | { readonly kind: "tool.started"; readonly event: SessionLogEvent; readonly data: typeof started.Type }
  | { readonly kind: "tool.completed"; readonly event: SessionLogEvent; readonly data: typeof returned.Type }
  | { readonly kind: "tool.refused"; readonly event: SessionLogEvent; readonly data: typeof refused.Type }
type MemoryFact = { readonly event: SessionLogEvent; readonly entry: LogEntry }
type RunBoundary = { readonly event: SessionLogEvent; readonly run: RunOrdinal }

const isLifecycleKind = (kind: string): kind is keyof typeof facts => Object.hasOwn(facts, kind)

const lifecycleOf = (event: SessionLogEvent): Effect.Effect<ReadonlyArray<Lifecycle>, Schema.SchemaError> => {
  if (!isLifecycleKind(event.kind)) return Effect.succeed([])
  const kind = event.kind
  return Option.match(journalSchemaOf(kind), {
    onNone: () => Effect.die("A tool lifecycle kind has no journal schema"),
    onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data).pipe(Effect.flatMap((data) => Match.value(kind).pipe(
      Match.when("tool.started", () => Schema.decodeUnknownEffect(started)(data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.started", event, data }]))),
      Match.when("tool.completed", () => Schema.decodeUnknownEffect(returned)(data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.completed", event, data }]))),
      Match.when("tool.refused", () => Schema.decodeUnknownEffect(refused)(data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.refused", event, data }]))),
      Match.exhaustive,
    ))),
  })
}

const scopeOf = (request: Request, event: SessionLogEvent, call: { readonly toolCallId?: ToolCallId; readonly step: number; readonly tool: string }): boolean =>
  event.session === request.session && Option.contains(event.turn, request.turn)
    && call.toolCallId === request.toolCallId && call.step === request.step && call.tool === request.tool

/**
 * Reconstruct the durable state of every non-provider tool call in a session
 * journal. Its request entry distinguishes occurrences; input is the encoded
 * request, while started.input is the decoded input admitted by the registry.
 * A lifecycle record without a pairing id cannot prove which request ran, so
 * older records contribute their memory results but no inferred start.
 * Run boundaries distinguish repeated Turn.run calls; when a pairing id is
 * reused in one step without those boundaries, ambiguous lifecycle evidence
 * is omitted rather than assigned to a call it cannot identify.
 * Records that do not decode fail with SchemaError, never disappear silently.
 *
 * @public
 */
export const toolCallStatesOf = Effect.fnUntraced(function* (events: ReadonlyArray<SessionLogEvent>): Effect.fn.Return<ReadonlyArray<ToolCallState>, Schema.SchemaError> {
  const memory = (yield* Effect.forEach(events, (event) => entryOfEvent(event).pipe(
    Effect.map((entry): ReadonlyArray<MemoryFact> => Option.toArray(entry).map((entry) => ({ event, entry }))),
  ), { concurrency: 1 })).flat()
  const lifecycle = (yield* Effect.forEach(events, lifecycleOf, { concurrency: 1 })).flat()
  const stepBoundaries = yield* Effect.forEach(events.filter((event) => event.kind === "step.started"), (event) => Option.match(journalSchemaOf(event.kind), {
    onNone: () => Effect.die("The step.started kind has no journal schema"),
    onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(stepStarted)),
      Effect.map((data): RunBoundary => ({ event, run: data.run })),
    ),
  }), { concurrency: 1 })
  const boundaries: ReadonlyArray<RunBoundary> = [...stepBoundaries, ...memory.flatMap(({ event, entry }): ReadonlyArray<RunBoundary> => entry.body._tag === "StepContext" ? [{ event, run: entry.body.run }] : [])]
    .sort((left, right) => left.event.seq - right.event.seq)
  const runAt = (event: SessionLogEvent): RunOrdinal => boundaries.reduce((run, boundary) => boundary.event.session === event.session
    && Option.getOrElse(boundary.event.turn, () => 0) === Option.getOrElse(event.turn, () => 0) && boundary.event.seq <= event.seq ? boundary.run : run, RunOrdinal.make(0))
  const requests: ReadonlyArray<Request> = memory.flatMap(({ event, entry }) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
    ? entry.body.message.content.flatMap((part): ReadonlyArray<Request> => part.type === "tool-call" && part.providerExecuted !== true ? [{
      _tag: "Requested", session: event.session, turn: entry.turn, runId: entry.runId, run: entry.body._tag === "Message" ? entry.body.run ?? runAt(event) : runAt(event), step: entry.step,
      toolCallId: part.toolCallId, tool: part.toolName, input: part.input, request: entry.id, requestedSeq: event.seq,
    }] : []) : [])
  const sameIdentity = (request: Request, other: Request): boolean => other.session === request.session && other.turn === request.turn
    && other.step === request.step && other.toolCallId === request.toolCallId && other.tool === request.tool
  const explicit = new Set(memory.flatMap(({ entry }) => entry.body._tag === "Message" && entry.body.run !== undefined ? [entry.id] : []))
  const resultFactsOf = (request: Request): ReadonlyArray<ToolCallResult> => {
    const next = requests.find((other) => sameIdentity(request, other) && other.run === request.run && other.requestedSeq > request.requestedSeq)
    return memory.flatMap(({ event, entry }): ReadonlyArray<ToolCallResult> => entry.body._tag === "ToolResult"
      && event.session === request.session && entry.turn === request.turn && entry.runId === request.runId && entry.step === request.step && (entry.body.run ?? runAt(event)) === request.run
      && entry.body.toolCallId === request.toolCallId && entry.body.toolName === request.tool
      && event.seq > request.requestedSeq && (next === undefined || event.seq < next.requestedSeq)
      ? [{ entry: entry.id, seq: event.seq, encoded: entry.body.encoded, isError: entry.body.isError }] : [])
  }
  return requests.map((request): ToolCallState => {
    const ownRequests = requests.filter((other) => sameIdentity(request, other) && other.run === request.run)
    const next = ownRequests.find((other) => other.requestedSeq > request.requestedSeq)
    const first = ownRequests[0]?.request === request.request
    const ownLifecycle = ownRequests.length > 1 ? [] : lifecycle.filter((fact) => {
      if (!scopeOf(request, fact.event, fact.data)) return false
      if (explicit.has(request.request)) {
        // Tool events have no run ordinal. A pairing key shared by overlapping runs proves
        // no particular call started: correlate only while exactly one request is live.
        const live = requests.filter((other) => sameIdentity(request, other) && other.requestedSeq <= fact.event.seq
          && !resultFactsOf(other).some((result) => result.seq < fact.event.seq))
        return live.length === 1 && live[0] === request
      }
      return runAt(fact.event) === request.run && (fact.event.seq >= request.requestedSeq || first)
        && (next === undefined || fact.event.seq < next.requestedSeq)
    })
    const starts = ownLifecycle.flatMap((fact): ReadonlyArray<ToolCallStart> => fact.kind === "tool.started" ? [{ invocationId: fact.data.invocationId, seq: fact.event.seq, input: fact.data.input }] : [])
    const returns = ownLifecycle.flatMap((fact): ReadonlyArray<ToolCallReturn> => fact.kind === "tool.completed" ? [{ invocationId: fact.data.invocationId, seq: fact.event.seq, ok: fact.data.ok }] : [])
    const refusals = ownLifecycle.flatMap((fact) => fact.kind === "tool.refused" ? [fact] : [])
    const results = resultFactsOf(request)
    const start = Option.fromNullishOr(starts.at(-1))
    const returned = Option.fromNullishOr(returns.at(-1))
    const result = Option.fromNullishOr(results.at(-1))
    const refusal = refusals.at(-1)
    if (refusal !== undefined) return {
      ...request, _tag: "Refused", invocationId: refusal.data.invocationId, refusedSeq: refusal.event.seq,
      reason: refusal.data.reason, message: refusal.data.message, result,
    }
    if (Option.isSome(result)) return { ...request, _tag: "Completed", started: start, returned, result: result.value }
    if (Option.isSome(returned)) return { ...request, _tag: "Returned", started: start, returned: returned.value }
    return Option.match(start, { onNone: () => request, onSome: (started) => ({ ...request, _tag: "Started", started }) })
  })
})
