import { Effect, Option, Ref } from "effect"
import type { AgentMessage } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { MaintainSignal, MemorySession, ToolViews } from "../ports/memory.port.js"
import type { CompactionAction, LogBody, LogEntry } from "./memory-log.entity.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import {
  buildContext,
  currentTurnOf,
  queryLog,
  rawTranscript,
  referenceTranscript,
  renderLog,
  subjectsOf,
  toolInputsOf,
} from "./memory-log.entity.functions.js"

/** An opened log: what MemoryLog.open returns. */
export interface LogHandle {
  readonly read: Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  readonly append: (runId: string, at: { readonly turn: number; readonly step: number }, bodies: ReadonlyArray<LogBody>) =>
    Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
}

/** What distinguishes one memory strategy from another. */
export interface MemoryPolicy {
  readonly strategy: { readonly id: string; readonly version: string }
  readonly render: Pick<RenderOptions, "turnContext" | "replies" | "stepContext">
  /** Decide compactions from the full log; the session records them before the next build. */
  readonly maintain: (input: {
    readonly entries: ReadonlyArray<LogEntry>
    readonly signal: MaintainSignal
    readonly turn: number
    readonly runId: string
    /** The render the strategy would send now (its own compactions applied). */
    readonly render: (entries: ReadonlyArray<LogEntry>) => ReadonlyArray<AgentMessage>
  }) => Effect.Effect<ReadonlyArray<CompactionAction>, HarnessError>
}

/**
 * The shared session over a log handle. It loads the log once, appends
 * through to storage, and renders with the strategy's own compactions —
 * so every strategy stores, retrieves and rebuilds the same way and differs
 * only in the decisions it records.
 */
export const openLogSession = (log: LogHandle, policy: MemoryPolicy, runId: string): Effect.Effect<MemorySession, HarnessError> =>
  Effect.gen(function* () {
    const entries = yield* Ref.make(yield* log.read)
    const renderOptions = (all: ReadonlyArray<LogEntry>): RenderOptions => ({
      ...policy.render, strategy: policy.strategy.id, currentTurn: currentTurnOf(all), currentRun: runId,
    })
    const record = (bodies: ReadonlyArray<LogBody>, step: number) => Effect.gen(function* () {
      if (bodies.length === 0) return []
      const current = currentTurnOf(yield* Ref.get(entries))
      const turn = bodies.some((body) => body._tag === "TurnStarted") ? current + 1 : Math.max(current, 1)
      const appended = yield* log.append(runId, { turn, step }, bodies)
      yield* Ref.update(entries, (all) => [...all, ...appended])
      return appended
    })
    const recordTail = (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number) => Effect.gen(function* () {
      const inputs = toolInputsOf(yield* Ref.get(entries), tail)
      const bodies = yield* Effect.forEach(tail, (message): Effect.Effect<ReadonlyArray<LogBody>> => message.role !== "tool"
        ? Effect.succeed([{ _tag: "Message", message }])
        : Effect.forEach(message.content, (part) => {
          const params = inputs.get(String(part.toolCallId)) ?? {}
          return views.view(part.toolName, part.output, params, part.isError ?? false).pipe(Effect.map((view): LogBody => ({
            _tag: "ToolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError: part.isError ?? false,
            encoded: part.output, view: view.text, viewVersion: view.version, subjects: view.subjects, pinned: view.pinned,
          })))
        }))
      return yield* record(bodies.flat(), step)
    })
    const maintain = (signal: MaintainSignal) => Effect.gen(function* () {
      const all = yield* Ref.get(entries)
      const actions = yield* policy.maintain({
        entries: all, signal, turn: currentTurnOf(all), runId,
        render: (candidate) => renderLog(candidate, renderOptions(candidate)),
      })
      return yield* record(actions.map((action) => ({ _tag: "Compaction" as const, strategy: policy.strategy.id, version: policy.strategy.version, action })), 0)
    })
    return {
      strategy: policy.strategy,
      turn: Ref.get(entries).pipe(Effect.map(currentTurnOf)),
      entries: Ref.get(entries),
      query: (query) => Ref.get(entries).pipe(Effect.map((all) => queryLog(all, query))),
      subjects: (kinds) => Ref.get(entries).pipe(Effect.map((all) => subjectsOf(all, kinds))),
      resolve: (id) => Ref.get(entries).pipe(Effect.map((all) => Option.fromNullable(all.find((entry) => entry.id === id)))),
      transcript: (fidelity) => Ref.get(entries).pipe(Effect.map((all) => fidelity === "raw" ? rawTranscript(all)
        : fidelity === "reference" ? referenceTranscript(all) : renderLog(all, renderOptions(all)))),
      record,
      recordTail,
      maintain,
      build: Ref.get(entries).pipe(Effect.map((all) => buildContext(all, renderOptions(all)))),
    } satisfies MemorySession
  })
