import { Clock, Effect, Option, Ref } from "effect"
import type { AgentMessage } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogHandle, MaintainSignal, MemoryReader, MemorySession, ToolViews } from "../ports/memory.port.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { CompactionAction, EntryId, LogBody, LogEntry } from "./memory-log.entity.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import {
  buildContext,
  currentTurnOf,
  entryId,
  queryLog,
  rawTranscript,
  referenceTranscript,
  renderLog,
  subjectsOf,
  toolInputsOf,
} from "./memory-log.entity.functions.js"

/** What a strategy decides at one maintain point. */
export interface MaintainDecision {
  readonly actions: ReadonlyArray<CompactionAction>
  /** Tool-result entries to digest now (recorded with trigger "compaction"). */
  readonly digest: ReadonlyArray<EntryId>
}

export const noMaintenance: MaintainDecision = { actions: [], digest: [] }

/** What distinguishes one memory strategy from another. */
export interface MemoryPolicy {
  readonly strategy: { readonly id: string; readonly version: string }
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
    readonly runId: string
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
  Option.fromNullishOr(entries.flatMap((entry) => entry.body._tag === "TurnStarted" ? [entry.body.userMessage] : []).at(-1))

/**
 * The shared session over a log handle. It loads the log once, assigns
 * entry ids (`<runId>:<n>`), appends through to storage, runs the tools'
 * digests the strategy asks for (with the `ResultDigester` of the environment
 * it is opened in, when there is one, for the latest user message: a log
 * without one digests nothing), and renders with the strategy's own compactions — so
 * every strategy stores, retrieves and rebuilds the same way and differs only
 * in the decisions it records.
 */
export const openLogSession = (
  log: LogHandle,
  policy: MemoryPolicy,
  scope: { readonly runId: string },
): Effect.Effect<MemorySession, HarnessError> =>
  Effect.gen(function* () {
    const runId = scope.runId
    const digester = yield* Effect.serviceOption(ResultDigester)
    const stored = yield* log.read
    const entries = yield* Ref.make(stored)
    const counter = yield* Ref.make(stored.filter((entry) => entry.runId === runId).length)
    const renderOptions = (all: ReadonlyArray<LogEntry>, stepContext: "tail" | "none"): RenderOptions => ({
      ...policy.render, stepContext, strategy: policy.strategy.id, currentTurn: currentTurnOf(all), currentRun: runId,
    })
    const record = (bodies: ReadonlyArray<LogBody>, step: number) => Effect.gen(function* () {
      if (bodies.length === 0) return []
      const current = currentTurnOf(yield* Ref.get(entries))
      const turn = bodies.some((body) => body._tag === "TurnStarted") ? current + 1 : Math.max(current, 1)
      const at = yield* Clock.currentTimeMillis
      const start = yield* Ref.getAndUpdate(counter, (value) => value + bodies.length)
      const appended = bodies.map((body, index): LogEntry => ({ id: entryId(runId, start + index), runId, turn, step, at, body }))
      yield* log.append(appended)
      yield* Ref.update(entries, (all) => [...all, ...appended])
      return appended
    })
    /** Digest the given results with their tools' prompts, concurrently, recorded in target order; a failed digest keeps the view. */
    const digest = (targets: ReadonlyArray<LogEntry>, views: ToolViews, trigger: "write" | "compaction", step: number) =>
      Ref.get(entries).pipe(Effect.flatMap((all) => Option.match(Option.all([digester, latestUserMessage(all)]), {
        onNone: () => Effect.succeed<ReadonlyArray<LogEntry>>([]),
        onSome: ([service, userMessage]) => Effect.gen(function* () {
          const inputs = toolInputsOf(all, [])
          const bodies = yield* Effect.forEach(targets, (entry): Effect.Effect<ReadonlyArray<LogBody>> => entry.body._tag !== "ToolResult" || entry.body.isError
            ? Effect.succeed([])
            : views.digest(entry.body.toolName, entry.body.encoded, inputs.get(String(entry.body.toolCallId)) ?? {}, userMessage).pipe(
              Effect.flatMap(Option.match({
                onNone: () => Effect.succeed<ReadonlyArray<LogBody>>([]),
                onSome: (task) => service.digest(task).pipe(
                  Effect.map((outcome) => Option.toArray(Option.map(task.apply(outcome), (text): LogBody => ({
                    _tag: "ToolDigest", entry: entry.id, version: task.version, mode: task.mode, keep: outcome.keep,
                    text, digester: `${service.id}@${service.version}`, trigger,
                  })))),
                  Effect.orElseSucceed((): ReadonlyArray<LogBody> => []),
                ),
              })),
            ), { concurrency: policy.digestConcurrency ?? defaultDigestConcurrency })
          return yield* record(bodies.flat(), step)
        }),
      })))
    const recordTail = (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number) => Effect.gen(function* () {
      const inputs = toolInputsOf(yield* Ref.get(entries), tail)
      const bodies = yield* Effect.forEach(tail, (message): Effect.Effect<ReadonlyArray<LogBody>> => message.role !== "tool"
        ? Effect.succeed([{ _tag: "Message", message }])
        : Effect.forEach(message.content, (part) => {
          const params = inputs.get(String(part.toolCallId)) ?? {}
          return views.view(part.toolName, part.output, params, part.isError ?? false).pipe(Effect.map((view): LogBody => ({
            _tag: "ToolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError: part.isError ?? false,
            encoded: part.output, view: view.text, viewVersion: view.version, subjects: view.subjects,
            artifacts: view.artifacts, pinned: view.pinned,
          })))
        }))
      const recorded = yield* record(bodies.flat(), step)
      const onWrite = policy.digestOnWrite
      const targets = Option.isNone(onWrite) ? [] : recorded.filter((entry) =>
        entry.body._tag === "ToolResult" && onWrite.value({ tool: entry.body.toolName, chars: entry.body.view.length }))
      const digests = yield* digest(targets, views, "write", step)
      return [...recorded, ...digests]
    })
    const maintain = (signal: MaintainSignal) => Effect.gen(function* () {
      const all = yield* Ref.get(entries)
      const decision = yield* policy.maintain({
        entries: all, signal, turn: currentTurnOf(all), runId,
        render: (candidate) => renderLog(candidate, renderOptions(candidate, "tail")),
      })
      const compactions = yield* record(decision.actions.map((action) => ({ _tag: "Compaction" as const, strategy: policy.strategy.id, version: policy.strategy.version, action })), 0)
      const wanted = new Set(decision.digest.map(String))
      const digests = yield* digest(all.filter((entry) => wanted.has(String(entry.id))), signal.views, "compaction", 0)
      return [...compactions, ...digests]
    })
    return {
      strategy: policy.strategy,
      turn: Ref.get(entries).pipe(Effect.map(currentTurnOf)),
      entries: Ref.get(entries),
      query: (query) => Ref.get(entries).pipe(Effect.map((all) => queryLog(all, query))),
      subjects: (kinds) => Ref.get(entries).pipe(Effect.map((all) => subjectsOf(all, kinds))),
      resolve: (id) => Ref.get(entries).pipe(Effect.map((all) => Option.fromNullishOr(all.find((entry) => entry.id === id)))),
      transcript: (fidelity) => Ref.get(entries).pipe(Effect.map((all) => fidelity === "raw" ? rawTranscript(all)
        : fidelity === "reference" ? referenceTranscript(all) : renderLog(all, renderOptions(all, "tail")))),
      record,
      recordTail,
      maintain,
      build: ({ stepContext }) => Ref.get(entries).pipe(Effect.map((all) => buildContext(all, renderOptions(all, stepContext)))),
    } satisfies MemorySession
  })
