import { Array as Arr, Effect, Match, Option, Schema, Struct } from "effect"
import { ModelCallUsage } from "../domain/model-call.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import { canonicalJson, estimateTokens, shownResults } from "../memory/memory-log.entity.functions.js"
import type { ShownResult } from "../memory/memory-log.entity.functions.js"
import { CompactionAction, EntryId } from "../memory/memory-log.entity.js"
import type { LogBody, LogEntry } from "../memory/memory-log.entity.js"
import { resolveRequestHeader } from "../turn/model-request-header.entity.functions.js"
import type { ModelRequestHeader } from "../turn/model-request.entity.js"
import { hostNote } from "../turn/model-text.js"
import { ContextBuiltEvent } from "../turn/turn-event.entity.js"
import type { ContextReport, ContextReportResult, ContextReportRow, ContextReportTurn, ContextReportUsage } from "./context-report.entity.js"
import { decodeStored, entryOfEvent } from "./session-event.entity.functions.js"
import type { SessionLogEvent } from "./session-log.entity.js"

// The fields read of each record, decoded as the journal stores them.
const decodeBuilt = Schema.decodeUnknownEffect(Schema.Struct(Struct.pick(ContextBuiltEvent.fields, ["turn", "run", "step", "estimatedTokens", "reservedTokens", "budgetTokens", "compactions"])))
const decodeEnded = Schema.decodeUnknownEffect(Schema.Struct({ results: Schema.Array(Schema.Struct({ entry: EntryId })) }))

/** A memory entry, the event that holds it and that event's place in the journal. */
interface Located {
  readonly at: number
  readonly event: SessionLogEvent
  readonly entry: LogEntry
}

/** A prepared request: its header with its system text and tools resolved, its place in the journal and its cut. */
interface Prepared {
  readonly at: number
  readonly event: SessionLogEvent
  readonly header: ModelRequestHeader
  readonly turn: number
  /** The step it was prepared for (`stepKey`): a request prepared again for the step shares it. */
  readonly key: string
  /** The place in the memory log of the last entry its build folded; -1 for an empty build. */
  readonly cut: number
}

/** A reported usage, where the journal holds it and the step it answered. */
interface Reported {
  readonly at: number
  readonly key: string
  readonly usage: ContextReportUsage
}

const turnKey = (session: string, turn: number): string => JSON.stringify([session, turn])
/** A step as the journal names it: its session, turn, run and step. */
const stepKey = (session: string, turn: number, run: number, step: number): string => JSON.stringify([session, turn, run, step])
const records = (events: ReadonlyArray<SessionLogEvent>, kind: string): ReadonlyArray<{ readonly event: SessionLogEvent; readonly at: number }> =>
  events.flatMap((event, at) => event.kind === kind ? [{ event, at }] : [])

const groupBy = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyMap<string, ReadonlyArray<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const value of values) {
    const id = key(value)
    const held = groups.get(id)
    if (held) held.push(value)
    else groups.set(id, [value])
  }
  return groups
}

/** The largest first; equals keep the order they came in. */
const largestFirst = <A extends { readonly characters: number }>(items: ReadonlyArray<A>, count: number): ReadonlyArray<A> =>
  items.toSorted((left, right) => right.characters - left.characters).slice(0, count)

/**
 * A tool declaration's text as a request's reserve counts it: its
 * description, then the canonical JSON of its parameters (the turn's
 * `schemaTokens` estimates each tool's on its own).
 */
const declarationOf = (tool: ModelRequestHeader["tools"][number]): string => `${tool.description}${canonicalJson(tool.parameters)}`

/**
 * A recorded step context split as a request hook's note was joined to it:
 * the note alone, or the step policy's text, a blank line and the note.
 * Neither count includes that blank line.
 */
const splitContext = (text: string, note: Option.Option<string>): Pick<ContextReportRow, "hookNote" | "stepContext"> => Option.match(note, {
  onNone: () => ({ hookNote: Option.none(), stepContext: Option.some(text.length) }),
  onSome: (framed) => text === framed ? { hookNote: Option.some(framed.length), stepContext: Option.none() }
    : text.endsWith(`\n\n${framed}`) ? { hookNote: Option.some(framed.length), stepContext: Option.some(text.length - framed.length - 2) }
      : { hookNote: Option.none(), stepContext: Option.some(text.length) },
})

/**
 * The host context a request showed. With the context after the messages
 * (`tail`), a build shows the latest step context its run recorded up to its
 * cut, so a step that recorded none still shows an earlier step's; inside the
 * system text, a request holds its own step's only. A hook's note is told
 * from the step policy's text by the header of the request that context was
 * recorded for: that header keeps the hook's patch.
 */
const hostContextOf = (memory: ReadonlyArray<Located>, request: Prepared, prepared: ReadonlyArray<Prepared>): Pick<ContextReportRow, "hookNote" | "stepContext" | "contextPlacement"> => {
  const { header } = request
  const tail = header.render.stepContext === "tail"
  const shown = Arr.findLast(memory.slice(0, request.cut + 1), ({ entry }) => entry.body._tag === "StepContext" && (tail
    ? entry.runId === header.render.currentRun && entry.body.run === header.render.run
    : entry.runId === header.runId && entry.body.run === header.run && entry.body.step === header.step))
  const context = Option.flatMap(shown, ({ at, entry }) => entry.body._tag !== "StepContext" ? Option.none() : Option.some({ at, runId: entry.runId, body: entry.body }))
  return {
    contextPlacement: tail ? "tail" : "system",
    ...Option.match(context, {
      onNone: () => ({ hookNote: Option.none(), stepContext: Option.none() }),
      onSome: ({ at, runId, body }) => {
        const recordedFor = Arr.findFirst(prepared, (other) => other.at > at && other.header.runId === runId && other.header.run === body.run && other.header.step === body.step)
        const note = Option.filter(Option.flatMap(recordedFor, (other) => Option.fromNullishOr(other.header.hook?.context)), (text) => text.length > 0)
        return splitContext(body.text, Option.map(note, hostNote))
      },
    }),
  }
}

/**
 * What filled each model request of a session, from its journal alone: a
 * row per `request.prepared`, in journal order, and a summary per turn.
 * `largest` (5 by default) is how many of the largest tool declarations a
 * row lists, and how many of the largest tool results a turn lists.
 *
 * A row pairs a request with the `context.built` published for it (the
 * latest one of its turn, run and step since that step's previous request)
 * and resolves its header (`resolveRequestHeader`), so the system text and
 * the tool declarations are counted from the `request.part` records the
 * header names. A request prepared again in the same step, after the
 * provider refused it for its size or over an image, is a row of its own,
 * numbered by `resend`.
 *
 * - `system` and `tools` are characters and tokens. A declaration counts its
 *   description and the canonical JSON of its parameters, and each text's
 *   tokens are estimated on its own, as the turn's reserve counts them:
 *   `system.tokens + tools.tokens` is `built.reservedTokens`. The two differ
 *   only for a tool declared without a description, where the header stores
 *   the one its parameter schema carries, and for a tool declared from a raw
 *   JSON schema.
 * - The messages are reported as `built.estimatedTokens`, the memory
 *   strategy's estimate: the journal stores the entries a request is rebuilt
 *   from, never a character count of the messages, and this report invents
 *   none. Of the messages it counts what it can name: the tool results the
 *   request showed (`results`) and the host context.
 * - `hookNote` and `stepContext` are the request hook's note and the step
 *   policy's step context, as the request showed them; either is none when
 *   the request showed none of it, and 0 only for an empty text. Placed
 *   after the messages (`tail`), a request shows the latest step context of
 *   its run, an earlier step's when its own step recorded none; placed in
 *   the system text, `system` already counts it.
 * - `usage` is the usage of the `Loop` call that completed for this request
 *   (`model.called`), else of the response the step accepted (`step.usage`),
 *   each given to the latest request of its turn, run and step prepared
 *   before it. A request the provider refused therefore has none, and the
 *   request sent in its place carries the usage.
 *
 * A turn lists each tool result its requests showed once, at the largest
 * size any of them showed it, with how that request showed it: read through
 * `shownResults`, the function the render itself folds results with, so the
 * report is what the request carried. `bounded` is a result whose preview
 * was recorded before the `step.ended` of the step that returned it (as it
 * was written), `spilled` one shortened after; when the journal holds no
 * such `step.ended`, a preview recorded before the first request that
 * included the result counts as `bounded`. A turn's `bounds` and `spills`
 * count the previews recorded during it by the same rule. `steps` and
 * `requests` are two counts: a host-planned step prepares no request.
 *
 * Give it every event of the session, from its start, as `Sessions.read`
 * returns them: a header's parts are stored once, each before the first
 * request that names it, and a request is rebuilt from the memory before it
 * (a fork needs the events it inherited too). Each row rebuilds its
 * request's render plan, so the work grows with the requests times the
 * memory entries. A record that does not decode fails the report with its
 * `SchemaError`, and a header that does not resolve, or whose cut is not
 * among the events, with the `request.*` code `resolveRequestHeader` and a
 * replay fail with.
 *
 * @public
 */
export const contextReportOf = Effect.fnUntraced(function* (
  events: ReadonlyArray<SessionLogEvent>, options: { readonly largest?: number } = {},
): Effect.fn.Return<ContextReport, HarnessError | Schema.SchemaError> {
  const largest = Math.max(0, options.largest ?? 5)
  const memory = (yield* Effect.forEach(events, (event, at) => entryOfEvent(event).pipe(
    Effect.map((entry): ReadonlyArray<Located> => Option.toArray(entry).map((entry) => ({ at, event, entry }))),
  ), { concurrency: 1 })).flat()
  const entries = memory.map((located) => located.entry)
  // An entry's place in the memory log and in the journal; the first entry holding an id.
  const placeOf = new Map(Arr.reverse(memory.map((located, index) => [String(located.entry.id), { index, at: located.at }] as const)))

  const prepared = yield* Effect.forEach(records(events, "request.prepared"), ({ event, at }): Effect.Effect<Prepared, HarnessError> => Effect.gen(function* () {
    const header = yield* resolveRequestHeader(events, event)
    const cut = yield* Option.match(header.through, {
      onNone: (): Effect.Effect<number, HarnessError> => Effect.succeed(-1),
      onSome: (id) => Option.match(Option.fromNullishOr(placeOf.get(id)), {
        onNone: () => Effect.fail(harnessError("request.diverged", `context: the memory entry ${id} the request was built through is not in the events`)),
        onSome: (place) => Effect.succeed(place.index),
      }),
    })
    const turn = Option.getOrElse(event.turn, () => header.render.currentTurn)
    return { at, event, header, turn, cut, key: stepKey(event.session, turn, header.run, header.step) }
  }), { concurrency: 1 })
  const requestsOf = groupBy(prepared, (request) => request.key)
  const stepRequests = (key: string): ReadonlyArray<Prepared> => requestsOf.get(key) ?? []

  // A context.built belongs to the next request of its step: the latest one before a request is that request's.
  const builds = yield* Effect.forEach(records(events, "context.built"), ({ event, at }) => decodeBuilt(event.data).pipe(
    Effect.map((data) => ({ at, key: stepKey(event.session, Option.getOrElse(event.turn, () => data.turn), data.run, data.step), data })),
  ), { concurrency: 1 })
  const builtFor = new Map(builds.flatMap((build) => Option.toArray(Option.map(
    Arr.findFirst(stepRequests(build.key), (request) => request.at > build.at),
    (request) => [request.at, { estimatedTokens: build.data.estimatedTokens, reservedTokens: build.data.reservedTokens, budgetTokens: build.data.budgetTokens, compactions: build.data.compactions }] as const,
  ))))

  // A response's usage belongs to the latest request of its step prepared before it.
  const called = (yield* Effect.forEach(records(events, "model.called"), ({ event, at }) => decodeStored("model.called", event).pipe(
    Effect.map((call) => {
      const reported: ReadonlyArray<TokenUsage> = call.purpose !== "Loop" || call.outcome._tag !== "Completed" ? [] : ModelCallUsage.match(call.usage, {
        Unknown: () => [], Known: (known) => [known.usage], Partial: (partial) => [partial.usage],
      })
      return Option.toArray(Option.all([event.turn, call.run, call.step])).flatMap(([turn, run, step]) =>
        reported.map((usage): Reported => ({ at, key: stepKey(event.session, turn, run, step), usage: { source: "model.called", usage } })))
    }),
  ), { concurrency: 1 })).flat()
  const accepted = (yield* Effect.forEach(records(events, "step.usage"), ({ event, at }) => decodeStored("step.usage", event).pipe(
    Effect.map((data) => Option.toArray(event.turn).map((turn): Reported =>
      ({ at, key: stepKey(event.session, turn, data.run, data.step), usage: { source: "step.usage", usage: data.usage } }))),
  ), { concurrency: 1 })).flat()
  const requestOf = (fact: Reported): Option.Option<Prepared> => Arr.findLast(stepRequests(fact.key), (request) => request.at < fact.at)
  const usedBy = (facts: ReadonlyArray<Reported>): ReadonlyMap<number, ContextReportUsage> =>
    new Map(facts.flatMap((fact) => Option.toArray(Option.map(requestOf(fact), (request) => [request.at, fact.usage] as const))))
  // The call that completed for a request tells its usage; the accepted response's stands in where no call was recorded.
  const calledFor = usedBy(called)
  const acceptedFor = usedBy(accepted)
  const usageOf = (request: Prepared): Option.Option<ContextReportUsage> =>
    Option.orElse(Option.fromNullishOr(calledFor.get(request.at)), () => Option.fromNullishOr(acceptedFor.get(request.at)))

  // Where each result's step ended: a preview recorded before it was recorded as the result was written.
  const endings = yield* Effect.forEach(records(events, "step.ended"), ({ event, at }) => decodeEnded(event.data).pipe(
    Effect.map((data) => data.results.map((result) => [String(result.entry), at] as const)),
  ), { concurrency: 1 })
  const endedAt = new Map(Arr.reverse(endings.flat()))
  const boundedOnWrite = (spill: EntryId, result: EntryId): boolean => Option.match(Option.all([Option.fromNullishOr(placeOf.get(spill)), Option.fromNullishOr(placeOf.get(result))]), {
    onNone: () => false,
    onSome: ([spilled, shown]) => Option.match(Option.fromNullishOr(endedAt.get(result)), {
      onSome: (ended) => spilled.at < ended,
      // No step.ended names the result: bounded when the preview is in the cut of the first request that included the result.
      onNone: () => Option.match(Arr.findFirst(prepared, (request) => request.cut >= shown.index), { onNone: () => true, onSome: (first) => spilled.index <= first.cut }),
    }),
  })

  const resultOf = (shown: ShownResult, body: Extract<LogBody, { readonly _tag: "ToolResult" }>, request: Prepared, resend: number): ContextReportResult => {
    const output = shown.part.output
    return {
      entry: shown.entry.id,
      tool: body.toolName,
      characters: (typeof output === "string" ? output : canonicalJson(output)).length,
      shown: Match.value(shown.by).pipe(
        Match.when("View", () => "whole" as const),
        Match.when("CompactViews", () => "compact" as const),
        Match.when("ToolDigest", () => "digest" as const),
        Match.when("Spill", () => Option.exists(shown.source, (spill) => boundedOnWrite(spill, shown.entry.id)) ? "bounded" as const : "spilled" as const),
        Match.exhaustive,
      ),
      // A compact view and a digest are the tool's own text; a view, and a preview cut from it, are raw when the tool wrote none.
      view: (shown.by === "View" || shown.by === "Spill") && body.viewVersion === "raw" ? "raw" : "tool",
      run: request.header.run, step: request.header.step, resend,
    }
  }

  const detailed = prepared.map((request) => {
    const { header } = request
    const resend = stepRequests(request.key).indexOf(request)
    const declarations = header.tools.map((tool) => {
      const text = declarationOf(tool)
      return { name: tool.name, characters: text.length, tokens: estimateTokens(text) }
    })
    const results = shownResults(entries.slice(0, request.cut + 1), header.render)
      .flatMap((shown) => shown.entry.body._tag === "ToolResult" ? [resultOf(shown, shown.entry.body, request, resend)] : [])
    const row: ContextReportRow = {
      session: request.event.session, seq: request.event.seq, turn: request.turn,
      runId: header.runId, run: header.run, step: header.step, resend,
      system: { characters: header.system.length, tokens: estimateTokens(header.system) },
      tools: {
        count: declarations.length,
        characters: declarations.reduce((sum, tool) => sum + tool.characters, 0),
        tokens: declarations.reduce((sum, tool) => sum + tool.tokens, 0),
        largest: largestFirst(declarations, largest),
      },
      results: { count: results.length, characters: results.reduce((sum, result) => sum + result.characters, 0) },
      built: Option.fromNullishOr(builtFor.get(request.at)),
      ...hostContextOf(memory, request, prepared),
      usage: usageOf(request),
    }
    return { row, results }
  })

  // The turns, in the order the journal first names them.
  const rowsOf = groupBy(detailed, (item) => turnKey(item.row.session, item.row.turn))
  const stepsOf = groupBy(events.filter((event) => event.kind === "step.started" && Option.isSome(event.turn)), (event) => turnKey(event.session, Option.getOrElse(event.turn, () => 0)))
  const recordedOf = groupBy(memory.filter(({ entry }) => entry.body._tag === "Compaction" || entry.body._tag === "ToolDigest"), ({ event, entry }) => turnKey(event.session, entry.turn))
  const named = new Map<string, { readonly session: SessionLogEvent["session"]; readonly turn: number }>()
  for (const event of events) {
    if (Option.isNone(event.turn) || !["turn.started", "step.started", "request.prepared", "memory.compaction", "memory.digest"].includes(event.kind)) continue
    const key = turnKey(event.session, event.turn.value)
    if (!named.has(key)) named.set(key, { session: event.session, turn: event.turn.value })
  }
  const zero = { bounds: 0, spills: 0, drops: 0, summaries: 0, digests: 0 }
  const turns = Array.from(named, ([key, { session, turn }]): ContextReportTurn => {
    const own = rowsOf.get(key) ?? []
    // Each result once, at the largest size a request of the turn showed it; the first such request among equals.
    const shown = new Map<string, ContextReportResult>()
    for (const result of own.flatMap((item) => item.results)) {
      const held = shown.get(result.entry)
      if (held === undefined || result.characters > held.characters) shown.set(result.entry, result)
    }
    const recorded = (recordedOf.get(key) ?? []).reduce((sum, { entry }) => Match.value(entry.body).pipe(
      Match.tag("ToolDigest", () => ({ ...sum, digests: sum.digests + 1 })),
      Match.tag("Compaction", (body) => CompactionAction.match(body.action, {
        Spill: (spill) => boundedOnWrite(entry.id, spill.entry) ? { ...sum, bounds: sum.bounds + 1 } : { ...sum, spills: sum.spills + 1 },
        DropTurns: () => ({ ...sum, drops: sum.drops + 1 }),
        Summarize: () => ({ ...sum, summaries: sum.summaries + 1 }),
        CompactViews: () => sum,
        OmitMedia: () => sum,
      })),
      Match.orElse(() => sum),
    ), zero)
    return {
      session, turn,
      steps: (stepsOf.get(key) ?? []).length,
      requests: own.length,
      results: largestFirst([...shown.values()], largest),
      ...recorded,
    }
  })
  return { rows: detailed.map((item) => item.row), turns }
})
