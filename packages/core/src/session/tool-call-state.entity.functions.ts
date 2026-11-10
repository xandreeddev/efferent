import { Effect, Match, Option, Schema, Struct } from "effect"
import type { ToolCallId } from "../domain/message.entity.js"
import { RunOrdinal } from "../domain/run.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import { StepStartedEvent, ToolInterceptedEvent } from "../turn/turn-event.entity.js"
import { entryOfEvent, journalSchemaOf } from "./session-event.entity.functions.js"
import { ToolCompletedData, ToolRefusedData, ToolStartedData } from "./session-event.entity.js"
import type { SessionLogEvent } from "./session-log.entity.js"
import type { ToolCallResult, ToolCallReturn, ToolCallStart, ToolCallState } from "./tool-call-state.entity.js"

// A typed view of the fields read after the journal's own decoder.
const intercepted = Schema.Struct(Struct.omit(ToolInterceptedEvent.fields, ["_tag"]))
const stepStarted = Schema.Struct(Struct.pick(StepStartedEvent.fields, ["step", "run"]))
type Request = Extract<ToolCallState, { readonly _tag: "Requested" }>
type Lifecycle =
  | { readonly kind: "tool.started"; readonly event: SessionLogEvent; readonly data: ToolStartedData }
  | { readonly kind: "tool.completed"; readonly event: SessionLogEvent; readonly data: ToolCompletedData }
  | { readonly kind: "tool.refused"; readonly event: SessionLogEvent; readonly data: ToolRefusedData }
type MemoryFact = { readonly event: SessionLogEvent; readonly entry: LogEntry }
type RunBoundary = { readonly event: SessionLogEvent; readonly run: RunOrdinal }

const decodeStarted = Schema.decodeUnknownEffect(ToolStartedData)
const decodeCompleted = Schema.decodeUnknownEffect(ToolCompletedData)
const decodeRefused = Schema.decodeUnknownEffect(ToolRefusedData)

/** A tool lifecycle record, decoded with its stored schema (`StoredData`) as it was stored; any other kind is none of them. */
const lifecycleOf = (event: SessionLogEvent): Effect.Effect<ReadonlyArray<Lifecycle>, Schema.SchemaError> => Match.value(event.kind).pipe(
  Match.when("tool.started", () => decodeStarted(event.data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.started", event, data }]))),
  Match.when("tool.completed", () => decodeCompleted(event.data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.completed", event, data }]))),
  Match.when("tool.refused", () => decodeRefused(event.data).pipe(Effect.map((data): ReadonlyArray<Lifecycle> => [{ kind: "tool.refused", event, data }]))),
  Match.orElse(() => Effect.succeed([])),
)

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
  const interceptions = yield* Effect.forEach(events.filter((event) => event.kind === "tool.intercepted"), (event) => Schema.decodeUnknownEffect(intercepted)(event.data).pipe(
    Effect.map((data) => ({ event, data })),
  ), { concurrency: 1 })
  const stepBoundaries = yield* Effect.forEach(events.filter((event) => event.kind === "step.started"), (event) => Option.match(journalSchemaOf(event.kind), {
    onNone: () => Effect.die("The step.started kind has no journal schema"),
    onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(stepStarted)),
      Effect.map((data): RunBoundary => ({ event, run: data.run })),
    ),
  }), { concurrency: 1 })
  const boundaries: ReadonlyArray<RunBoundary> = [...stepBoundaries, ...memory.flatMap(({ event, entry }): ReadonlyArray<RunBoundary> => entry.body._tag === "StepContext" ? [{ event, run: entry.body.run }] : [])]
    .sort((left, right) => left.event.seq - right.event.seq)
  const boundaryGroups = new Map<string, RunBoundary[]>()
  for (const boundary of boundaries) { const key = JSON.stringify([boundary.event.session, Option.getOrElse(boundary.event.turn, () => 0)]); const group = boundaryGroups.get(key); if (group) group.push(boundary); else boundaryGroups.set(key, [boundary]) }
  const runAt = (event: SessionLogEvent): RunOrdinal => {
    const own = boundaryGroups.get(JSON.stringify([event.session, Option.getOrElse(event.turn, () => 0)])) ?? []
    let low = 0, high = own.length
    while (low < high) { const mid = (low + high) >>> 1; if (own[mid]!.event.seq <= event.seq) low = mid + 1; else high = mid }
    return own[low - 1]?.run ?? RunOrdinal.make(0)
  }
  const requests: ReadonlyArray<Request> = memory.flatMap(({ event, entry }) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
    ? entry.body.message.content.flatMap((part): ReadonlyArray<Request> => part.type === "tool-call" && part.providerExecuted !== true ? [{
      _tag: "Requested", session: event.session, turn: entry.turn, runId: entry.runId, run: entry.body._tag === "Message" ? entry.body.run ?? runAt(event) : runAt(event), step: entry.step,
      toolCallId: part.toolCallId, tool: part.toolName, input: part.input, request: entry.id, requestedSeq: event.seq,
    }] : []) : [])
  const identity = (session: string, turn: number, step: number, id: string | undefined, tool: string): string => JSON.stringify([session, turn, step, id, tool])
  const requestKey = (request: Request) => identity(request.session, request.turn, request.step, request.toolCallId, request.tool)
  const factKey = (fact: { readonly event: SessionLogEvent; readonly data: { readonly step: number; readonly toolCallId?: ToolCallId; readonly tool: string } }) => identity(fact.event.session, Option.getOrElse(fact.event.turn, () => 0), fact.data.step, fact.data.toolCallId, fact.data.tool)
  const group = <A>(values: ReadonlyArray<A>, key: (value: A) => string): Map<string, A[]> => {
    const groups = new Map<string, A[]>()
    for (const value of values) { const id = key(value); const held = groups.get(id); if (held) held.push(value); else groups.set(id, [value]) }
    return groups
  }
  const requestsByIdentity = group(requests, requestKey)
  const lifecycleByIdentity = group(lifecycle, factKey)
  const auditsByIdentity = group(interceptions, factKey)
  const memoryByIdentity = group(memory.filter(({ entry }) => entry.body._tag === "ToolResult"), ({ event, entry }) => entry.body._tag === "ToolResult" ? identity(event.session, entry.turn, entry.step, entry.body.toolCallId, entry.body.toolName) : "")
  const identityRequests = (request: Request) => requestsByIdentity.get(requestKey(request)) ?? []
  const sameIdentity = (request: Request, other: Request): boolean => requestKey(request) === requestKey(other)
  const resultCache = new Map<Request, ReadonlyArray<ToolCallResult>>()
  const explicit = new Set(memory.flatMap(({ entry }) => entry.body._tag === "Message" && entry.body.run !== undefined ? [entry.id] : []))
  const resultFactsOf = (request: Request): ReadonlyArray<ToolCallResult> => {
    const cached = resultCache.get(request)
    if (cached !== undefined) return cached
    const next = identityRequests(request).find((other) => sameIdentity(request, other) && other.run === request.run && other.requestedSeq > request.requestedSeq)
    const results = (memoryByIdentity.get(requestKey(request)) ?? []).flatMap(({ event, entry }): ReadonlyArray<ToolCallResult> => entry.body._tag === "ToolResult"
      && event.session === request.session && entry.turn === request.turn && entry.runId === request.runId && entry.step === request.step && (entry.body.run ?? runAt(event)) === request.run
      && entry.body.toolCallId === request.toolCallId && entry.body.toolName === request.tool
      && event.seq > request.requestedSeq && (next === undefined || event.seq < next.requestedSeq)
      ? [{ entry: entry.id, seq: event.seq, encoded: entry.body.encoded, isError: entry.body.isError, ...(entry.body.interception === undefined ? {} : { interception: entry.body.interception }) }] : [])
    resultCache.set(request, results)
    return results
  }
  const settledByInvocation = new Map<string, Request[]>()
  for (const request of requests) for (const result of resultFactsOf(request)) if (result.interception) { const id = result.interception.invocationId; const owners = settledByInvocation.get(id) ?? []; if (!owners.includes(request)) owners.push(request); settledByInvocation.set(id, owners) }
  return requests.map((request): ToolCallState => {
    const ownRequests = identityRequests(request).filter((other) => sameIdentity(request, other) && other.run === request.run)
    const next = ownRequests.find((other) => other.requestedSeq > request.requestedSeq)
    const first = ownRequests[0]?.request === request.request
    const ownLifecycle = (lifecycleByIdentity.get(requestKey(request)) ?? []).filter((fact) => {
      if (!scopeOf(request, fact.event, fact.data)) return false
      // Exact result receipts and pre-handler audits disambiguate overlapping
      // runs without making provider keys globally unique or inventing starts.
      const settledOwners = settledByInvocation.get(fact.data.invocationId) ?? []
      if (settledOwners.length > 0) return settledOwners.length === 1 && settledOwners[0]?.request === request.request
      const owners = (auditsByIdentity.get(requestKey(request)) ?? []).filter((audit) => audit.data.source === "loop" && audit.data.phase._tag === "Before"
        && scopeOf(request, audit.event, audit.data) && audit.event.seq >= request.requestedSeq
        && (next === undefined || audit.event.seq < next.requestedSeq) && Option.match(audit.data.run, {
          onNone: () => identityRequests(request).filter((other) => sameIdentity(request, other) && other.requestedSeq <= audit.event.seq
            && !resultFactsOf(other).some((result) => result.seq < audit.event.seq)).length === 1,
          onSome: (run) => run.id === request.runId && run.turn === request.turn && run.ordinal === request.run,
        }))
      if (owners.length > 0) return new Set(owners.map((audit) => audit.data.invocationId)).size === 1
        && owners.every((audit) => audit.data.invocationId === fact.data.invocationId && audit.event.seq <= fact.event.seq)
      // Direct or unqualified audits describe an invocation, not ownership of
      // this root request, even when all public pairing fields are reused.
      if ((auditsByIdentity.get(requestKey(request)) ?? []).some((audit) => audit.data.invocationId === fact.data.invocationId && scopeOf(request, audit.event, audit.data))) return false
      if (ownRequests.length > 1) return false
      if (explicit.has(request.request)) {
        // Tool events have no run ordinal. A pairing key shared by overlapping runs proves
        // no particular call started: correlate only while exactly one request is live.
        const live = identityRequests(request).filter((other) => sameIdentity(request, other) && other.requestedSeq <= fact.event.seq
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
