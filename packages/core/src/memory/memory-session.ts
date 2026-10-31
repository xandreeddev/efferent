import { Clock, Effect, Option, Ref, Semaphore } from "effect"
import { elideMediaData, mediaSlotsOf, toolResultMedia } from "../domain/media.entity.functions.js"
import type { AgentMessage } from "../domain/message.entity.js"
import type { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogHandle, MaintainSignal, MemoryReader, MemorySession, ToolViews } from "../ports/memory.port.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { CompactionAction, EntryId, LogBody, LogEntry } from "./memory-log.entity.js"
import { MemoryStrategyId } from "./memory-snapshot.entity.js"
import type { MemoryProjection } from "./memory-snapshot.entity.js"
import { prepareMemorySnapshot, projectMemorySnapshot, validateMemorySnapshot } from "./memory-snapshot.entity.functions.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import {
  buildContext,
  canonicalJson,
  currentTurnOf,
  entryId,
  latestRunOf,
  presentedEntries,
  queryLog,
  rawTranscript,
  referenceTranscript,
  renderLog,
  subjectsOf,
  toolInputOf,
  userMessageIn,
} from "./memory-log.entity.functions.js"

/**
 * What a strategy decides at one maintain point.
 *
 * @public
 */
export interface MaintainDecision {
  readonly actions: ReadonlyArray<CompactionAction>
  /** Tool-result entries to digest now (recorded with trigger "compaction"). */
  readonly digest: ReadonlyArray<EntryId>
}

/** @public */
export const noMaintenance: MaintainDecision = { actions: [], digest: [] }

/** What distinguishes one memory strategy from another. */
export interface MemoryPolicy {
  readonly strategy: { readonly id: string; readonly version: string }
  /** Opt in to durable render acceleration; full archive and maintenance semantics remain unchanged. */
  readonly checkpoint?: "render"
  readonly render: Pick<RenderOptions, "turnContext" | "replies" | "digests" | "media">
  /** Digest a result as it is written; None never digests at write time. */
  readonly digestOnWrite: Option.Option<(result: { readonly tool: string; readonly chars: number }) => boolean>
  /** Digest calls run at once (default 4); results are recorded in log order either way. */
  readonly digestConcurrency?: number
  /** Decide compactions and digests from the full log; the session records them before the next build. */
  readonly maintain: (input: {
    readonly entries: ReadonlyArray<LogEntry>
    readonly signal: MaintainSignal
    readonly turn: number
    readonly runId: RunId
    /** The render the strategy would send now (its own compactions applied). */
    readonly render: (entries: ReadonlyArray<LogEntry>) => ReadonlyArray<AgentMessage>
  }) => Effect.Effect<MaintainDecision, HarnessError>
}

const defaultDigestConcurrency = 4

/** The read-only view of a session, as tools, sections, matchers and reactions get it. */
export const readerOf = (session: MemorySession): MemoryReader => ({
  turn: session.turn,
  entries: session.entries,
  query: session.query,
  subjects: session.subjects,
  resolve: session.resolve,
  transcript: session.transcript,
})

/** The latest user message of the log — what a digest must serve. */
const latestUserMessage = (entries: ReadonlyArray<LogEntry>): Option.Option<UserMessage> =>
  Option.fromNullishOr(entries.flatMap((entry) => Option.toArray(userMessageIn(entry))).at(-1))

/**
 * The shared session over a log handle. It loads the log once, assigns
 * entry ids (`<runId>:<n>`), appends through to storage, runs the tools'
 * digests the strategy asks for (with the `ResultDigester` of the environment
 * it is opened in, when there is one, for the latest user message: a log
 * without one digests nothing), and renders with the strategy's own compactions — so
 * every strategy stores, retrieves and rebuilds the same way and differs only
 * in the decisions it records.
 */
export const openLogSession = Effect.fnUntraced(function* (
  log: LogHandle,
  policy: MemoryPolicy,
  scope: { readonly runId: RunId },
): Effect.fn.Return<MemorySession, TurnError> {
  const runId = scope.runId
  const digester = yield* Effect.serviceOption(ResultDigester)
  const stored = yield* log.read
  const entries = yield* Ref.make(stored)
  const nextIndex = (all: ReadonlyArray<LogEntry>): number => {
    const own = all.filter((entry) => entry.runId === runId)
    const prefix = `${runId}:`
    return own.reduce((next, entry) => {
      const suffix = String(entry.id).startsWith(prefix) ? String(entry.id).slice(prefix.length) : ""
      const index = /^\d+$/.test(suffix) ? Number(suffix) : -1
      return Number.isSafeInteger(index) && index >= 0 ? Math.max(next, index + 1) : next
    }, own.length)
  }
  const counter = yield* Ref.make(nextIndex(stored))
  const writing = yield* Semaphore.make(1)
  /** A render of the log: the step context of run `run` of the turn; the latest run that recorded one when none is named. */
  const renderOptions = (all: ReadonlyArray<LogEntry>, stepContext: "tail" | "none", run: RunOrdinal = latestRunOf(all, runId)): RenderOptions => ({
    ...policy.render, stepContext, strategy: policy.strategy.id, currentTurn: currentTurnOf(all), currentRun: runId, run,
  })
  const strategy = { ...policy.strategy, id: MemoryStrategyId.make(policy.strategy.id) }
  const loaded = policy.checkpoint === "render" && log.checkpoint !== undefined ? yield* log.checkpoint.load : Option.none()
  const projection = yield* Ref.make<MemoryProjection>(Option.isNone(loaded) ? { _tag: "Full" }
    : yield* validateMemorySnapshot(stored, loaded.value, strategy, renderOptions(stored, "tail")))
  const projected = (all: ReadonlyArray<LogEntry>, options: RenderOptions) => Ref.modify(projection, (phase) => {
    const selected = projectMemorySnapshot(all, phase, options)
    return [selected.entries, selected.phase] as const
  })
  // One record at a time: ids, the stored order and the session's order agree (a request is
  // rebuilt from the stored entries up to its build's last one). A failed acknowledgement
  // is reconciled from storage; a proven refusal takes no id, an uncertain write reserves it.
  const record = (bodies: ReadonlyArray<LogBody>, step: number, commit?: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<boolean, TurnError>) => bodies.length === 0 ? Effect.succeed<ReadonlyArray<LogEntry>>([]) : writing.withPermits(1)(Effect.gen(function* () {
    const current = currentTurnOf(yield* Ref.get(entries))
    const turn = bodies.some((body) => body._tag === "TurnStarted") ? current + 1 : Math.max(current, 1)
    const at = yield* Clock.currentTimeMillis
    const start = yield* Ref.get(counter)
    const appended = bodies.map((body, index): LogEntry => ({ id: entryId(runId, start + index), runId, turn, step, at, body }))
    const accepted = yield* (commit === undefined ? log.append(appended).pipe(Effect.as(true)) : commit(appended)).pipe(Effect.onError(() => Ref.set(projection, { _tag: "Full" }).pipe(Effect.andThen((log.snapshot ?? log.read).pipe(
      Effect.flatMap((actual) => Ref.set(entries, actual).pipe(Effect.andThen(Ref.set(counter, nextIndex(actual))))),
      Effect.catchCause((cause) => Effect.logWarning("the memory append failed and its durable snapshot could not be read", cause).pipe(
        Effect.andThen(Ref.update(counter, (next) => Math.max(next, start + bodies.length))),
      )),
    )))))
    if (!accepted) return []
    yield* Ref.set(counter, start + bodies.length)
    yield* Ref.update(entries, (all) => [...all, ...appended])
    return appended
  }))
  /** Digest the given results with their tools' prompts, concurrently, recorded in target order; a failed digest keeps the view. */
  const digest = (targets: ReadonlyArray<LogEntry>, views: ToolViews, trigger: "write" | "compaction", step: number) =>
    Ref.get(entries).pipe(Effect.flatMap((all) => Option.match(Option.all([digester, latestUserMessage(all)]), {
      onNone: () => Effect.succeed<ReadonlyArray<LogEntry>>([]),
      onSome: ([service, userMessage]) => Effect.gen(function* () {
        const bodies = yield* Effect.forEach(targets, (entry): Effect.Effect<ReadonlyArray<LogBody>> => entry.body._tag !== "ToolResult" || entry.body.isError
          ? Effect.succeed([])
          : views.digest(entry.body.toolName, entry.body.encoded, toolInputOf(all, entry), userMessage).pipe(
            Effect.flatMap(Option.match({
              onNone: () => Effect.succeed<ReadonlyArray<LogBody>>([]),
              onSome: (task) => service.digest(task).pipe(
                Effect.map((outcome) => Option.toArray(Option.map(task.apply(outcome), (text): LogBody => ({
                  _tag: "ToolDigest", entry: entry.id, version: task.version, mode: task.mode, keep: outcome.keep,
                  text, digester: `${service.id}@${service.version}`, trigger,
                })))),
                Effect.tapError((error) => Effect.logWarning(`the digest of tool result ${entry.id} failed; the result stays whole`, error)),
                Effect.orElseSucceed((): ReadonlyArray<LogBody> => []),
              ),
            })),
          ), { concurrency: policy.digestConcurrency ?? defaultDigestConcurrency })
        return yield* record(bodies.flat(), step)
      }),
    })))
  const recordTail = (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => Effect.gen(function* () {
    // Persist the returned value before calling any host view or optional digester.
    const bodies = yield* Effect.forEach(tail, (message): Effect.Effect<ReadonlyArray<LogBody>> => message.role !== "tool"
      ? Effect.succeed([{ _tag: "Message", message, ...(run === undefined ? {} : { run }) }])
      : Effect.forEach(message.content, (part) => {
        const isError = part.isError ?? false
        const elided = elideMediaData(part.output)
        const text = typeof elided === "string" ? elided : canonicalJson(elided)
        return toolResultMedia(part.output, isError ? [] : mediaSlotsOf(part.output)).pipe(Effect.map((media): LogBody => ({
            _tag: "ToolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError,
            ...(run === undefined ? {} : { run }),
            encoded: part.output,
            view: media.labels.length === 0 ? text : [text, ...media.labels].filter((line) => line.length > 0).join("\n"),
            viewVersion: "raw", subjects: [], artifacts: [], pinned: false,
            ...(media.slots.length === 0 ? {} : { media: media.slots }),
            ...(media.labels.length === 0 ? {} : { mediaNotes: media.labels }),
          })))
      }, { concurrency: 1 }), { concurrency: 1 })
    const recorded = yield* record(bodies.flat(), step)
    const all = yield* Ref.get(entries)
    const presentations = yield* Effect.forEach(recorded, (entry): Effect.Effect<ReadonlyArray<LogBody>> => {
      if (entry.body._tag !== "ToolResult") return Effect.succeed([])
      const body = entry.body
      return views.view(body.toolName, body.encoded, toolInputOf(all, entry), body.isError).pipe(
        Effect.flatMap((view) => toolResultMedia(body.encoded, body.isError ? [] : view.media ?? []).pipe(Effect.map((media): ReadonlyArray<LogBody> => {
          const presentation = {
            view: media.labels.length === 0 ? view.text : [view.text, ...media.labels].filter((line) => line.length > 0).join("\n"),
            viewVersion: view.version, subjects: view.subjects, artifacts: view.artifacts, pinned: view.pinned,
            media: media.slots, mediaNotes: media.labels,
          }
          const previous = { view: body.view, viewVersion: body.viewVersion, subjects: body.subjects, artifacts: body.artifacts, pinned: body.pinned, media: body.media ?? [], mediaNotes: body.mediaNotes ?? [] }
          return canonicalJson(presentation) === canonicalJson(previous) ? [] : [{ _tag: "ToolPresentation", entry: entry.id, ...presentation }]
        }))),
      )
    }, { concurrency: 1 })
    const presented = yield* record(presentations.flat(), step)
    const shown = presentedEntries([...recorded, ...presented]).slice(0, recorded.length)
    const onWrite = policy.digestOnWrite
    const targets = Option.isNone(onWrite) ? [] : shown.filter((entry) =>
      entry.body._tag === "ToolResult" && onWrite.value({ tool: entry.body.toolName, chars: entry.body.view.length }))
    const digests = yield* digest(targets, views, "write", step)
    return [...shown, ...presented, ...digests]
  })
  const maintain = (signal: MaintainSignal) => Effect.gen(function* () {
    const original = yield* Ref.get(entries)
    const all = presentedEntries(original)
    const options = renderOptions(original, signal.phase === "turn-end" ? "none" : signal.render?.stepContext ?? "tail", signal.render?.run ?? latestRunOf(all, runId))
    const decision = yield* policy.maintain({
      entries: all, signal, turn: currentTurnOf(all), runId,
      render: (candidate) => renderLog(candidate, renderOptions(candidate,
        signal.phase === "turn-end" ? "none" : signal.render?.stepContext ?? "tail",
        signal.render?.run ?? latestRunOf(all, runId))),
    })
    const compactions = yield* record(decision.actions.map((action) => ({ _tag: "Compaction" as const, strategy: policy.strategy.id, version: policy.strategy.version, action })), 0)
    const wanted = new Set(decision.digest.map(String))
    const digests = yield* digest(all.filter((entry) => wanted.has(String(entry.id))), signal.views, "compaction", 0)
    if (policy.checkpoint === "render" && log.checkpoint !== undefined && compactions.some((entry) => entry.body._tag === "Compaction" && entry.body.action._tag === "Summarize")) {
      const actual = yield* Ref.get(entries)
      if (buildContext(actual, options).estimatedTokens < buildContext(original, options).estimatedTokens) {
        const candidate = yield* prepareMemorySnapshot(actual, strategy)
        // record/digest have released the allocation permit before this callback.
        if (Option.isSome(candidate)) yield* log.checkpoint.save(candidate.value)
      }
    }
    return [...compactions, ...digests]
  })
  return {
    strategy: policy.strategy,
    renderRecipe: (stepContext, run) => Ref.get(entries).pipe(Effect.map((all) => renderOptions(all, stepContext, run))),
    turn: Ref.get(entries).pipe(Effect.map(currentTurnOf)),
    entries: Ref.get(entries),
    query: (query) => Ref.get(entries).pipe(Effect.map((all) => queryLog(all, query))),
    subjects: (kinds) => Ref.get(entries).pipe(Effect.map((all) => subjectsOf(all, kinds))),
    resolve: (id) => Ref.get(entries).pipe(Effect.map((all) => Option.fromNullishOr(presentedEntries(all).find((entry) => entry.id === id)))),
    transcript: (fidelity) => Ref.get(entries).pipe(Effect.flatMap((all) => fidelity === "raw" ? Effect.succeed(rawTranscript(all))
      : fidelity === "reference" ? Effect.succeed(referenceTranscript(all)) : projected(all, renderOptions(all, "tail")).pipe(Effect.map((selected) => renderLog(selected, renderOptions(all, "tail")))))),
    record,
    recordTail,
    maintain,
    build: ({ stepContext, run }) => Ref.get(entries).pipe(Effect.flatMap((all) => projected(all, renderOptions(all, stepContext, run)).pipe(Effect.map((selected) => buildContext(selected, renderOptions(all, stepContext, run)))))),
  } satisfies MemorySession
})
