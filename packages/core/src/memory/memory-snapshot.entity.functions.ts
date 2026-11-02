import { Effect, Match, Option, Schema } from "effect"
import { SessionLogError } from "../session/session-log.entity.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { LogEntry } from "./memory-log.entity.js"
import { buildContext, canonicalJson, requestEntryOfResult, retainedMemoryPrefix } from "./memory-log.entity.functions.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import { MemorySnapshotCandidate } from "./memory-snapshot.entity.js"
import type { MemoryProjection } from "./memory-snapshot.entity.js"
// Keep inferred entry declarations inside core when a host also re-exports this class.
import type { UserMessage } from "../turn/user-message.entity.js"

const full: MemoryProjection = { _tag: "Full" }
const invalid = (cause: unknown) => new SessionLogError({ code: "session.decode", message: "The selected memory snapshot is invalid.", cause })
const immutable = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(immutable)
  return Object.freeze(value)
}
const copyCandidate = Effect.fnUntraced(function* (candidate: MemorySnapshotCandidate) {
  const encoded = yield* Schema.encodeEffect(MemorySnapshotCandidate)(candidate)
  const json = yield* storedJson(encoded)
  return immutable(yield* Schema.decodeUnknownEffect(MemorySnapshotCandidate)(json))
})

/** Prepare raw dependencies for one real reducing cut; archive entries are never changed. */
export const prepareMemorySnapshot = Effect.fnUntraced(function* (entries: ReadonlyArray<LogEntry>, strategy: MemorySnapshotCandidate["strategy"]): Effect.fn.Return<Option.Option<MemorySnapshotCandidate>, SessionLogError> {
  const selected = retainedMemoryPrefix(entries, strategy.id)
  if (Option.isNone(selected)) return Option.none()
  const anchor = entries[selected.value.anchorIndex], through = entries.at(-1)
  if (anchor === undefined || through === undefined) return Option.none()
  const candidate = yield* copyCandidate({ strategy, anchor: anchor.id, through: through.id, entries: selected.value.entries }).pipe(Effect.mapError(invalid))
  return Option.some(candidate)
})

const sameEntries = Effect.fnUntraced(function* (left: ReadonlyArray<LogEntry>, right: ReadonlyArray<LogEntry>) {
  const encoded = yield* Effect.forEach([left, right], (entries) => Schema.encodeEffect(Schema.Array(LogEntry))(entries).pipe(Effect.flatMap((items) => storedJson({ entries: items }))), { concurrency: 1 })
  return canonicalJson(encoded[0]) === canonicalJson(encoded[1])
})

/**
 * Check a selected snapshot against the authoritative archive before reuse.
 * Undecodable data and anchor/frontier entries the archive does not hold fail
 * with `session.decode`. Another strategy, or retained facts that differ from
 * what this release keeps of the same prefix (an older release's selection, or
 * damage), use the full archive: logged, never fatal, since the archive alone
 * decides what a render shows. Render equality is checked lazily, by the first
 * projected build of each step-context placement (`projectMemorySnapshot`).
 */
export const validateMemorySnapshot = Effect.fnUntraced(function* (entries: ReadonlyArray<LogEntry>, input: MemorySnapshotCandidate, strategy: MemorySnapshotCandidate["strategy"]): Effect.fn.Return<MemoryProjection, SessionLogError> {
  const candidate = yield* copyCandidate(input).pipe(Effect.mapError(invalid))
  const anchorIndex = entries.findIndex((entry) => entry.id === candidate.anchor)
  const throughIndex = entries.findIndex((entry) => entry.id === candidate.through)
  if (anchorIndex < 0 || throughIndex < anchorIndex || entries[anchorIndex]?.body._tag !== "TurnStarted" ||
    entries.filter((entry) => entry.id === candidate.anchor || entry.id === candidate.through).length !== (candidate.anchor === candidate.through ? 1 : 2)) {
    return yield* Effect.fail(invalid({ anchor: candidate.anchor, through: candidate.through }))
  }
  if (candidate.strategy.id !== strategy.id || candidate.strategy.version !== strategy.version) return full
  const expected = retainedMemoryPrefix(entries.slice(0, throughIndex + 1), candidate.strategy.id)
  if (Option.isNone(expected) || expected.value.anchorIndex !== anchorIndex ||
    !(yield* sameEntries(candidate.entries, expected.value.entries).pipe(Effect.mapError(invalid)))) {
    return yield* Effect.logWarning("The selected memory snapshot differs from the archive's retained facts; rendering uses the full archive.").pipe(
      Effect.annotateLogs({ "efferent.memory.snapshot.anchor": candidate.anchor }), Effect.as(full))
  }
  return { _tag: "Projected", candidate, anchorIndex, throughIndex, cutTurn: expected.value.cutTurn, checkedThrough: throughIndex, verified: [] }
})

/** A projection's entries for one render, its next state, and whether a placement's first check found the render changed. */
export interface ProjectedEntries {
  readonly phase: MemoryProjection
  readonly entries: ReadonlyArray<LogEntry>
  /** True when the first projected build of this placement differed from the full archive's: the phase is now `Full`. */
  readonly mismatch: boolean
}

/**
 * A pure guarded projection; legitimate new dependencies, a render of a cut
 * run's step context, or a first build per placement that does not match the
 * full archive's, restore the full archive.
 */
export const projectMemorySnapshot = (entries: ReadonlyArray<LogEntry>, phase: MemoryProjection, options: RenderOptions): ProjectedEntries => Match.value(phase).pipe(
  Match.tag("Full", (): ProjectedEntries => ({ phase: full, entries, mismatch: false })),
  Match.tag("Projected", (state): ProjectedEntries => {
    const archive: ProjectedEntries = { phase: full, entries, mismatch: false }
    if (options.strategy !== state.candidate.strategy.id || entries[state.anchorIndex]?.id !== state.candidate.anchor ||
      entries[state.throughIndex]?.id !== state.candidate.through || entries.length <= state.checkedThrough) return archive
    const retained = new Set(state.candidate.entries.map((entry) => entry.id))
    const omitted = entries.slice(0, state.anchorIndex).filter((entry) => !retained.has(entry.id))
    // A snapshot keeps no cut run's step context: a render that shows one is the archive's.
    if (options.stepContext === "tail" && omitted.some((entry) => entry.body._tag === "StepContext" && entry.runId === options.currentRun && entry.body.run === options.run)) return archive
    const omittedIds = new Set(omitted.map((entry) => entry.id))
    const newEntries = entries.slice(state.checkedThrough + 1)
    const unsafe = newEntries.some((entry) => {
      if ((entry.body._tag === "ToolPresentation" || entry.body._tag === "ToolDigest") && omittedIds.has(entry.body.entry)) return true
      return entry.body._tag === "ToolResult" && Option.match(requestEntryOfResult(entries, entry), { onNone: () => false, onSome: (request) => omittedIds.has(request.id) })
    })
    if (unsafe) return archive
    const projected = [...state.candidate.entries, ...entries.slice(state.anchorIndex)]
    const checked = { ...state, checkedThrough: entries.length - 1 }
    if (state.verified.includes(options.stepContext)) return { phase: checked, entries: projected, mismatch: false }
    // This placement's first build: one full render here replaces every full render that would follow.
    return canonicalJson(buildContext(entries, options)) === canonicalJson(buildContext(projected, options))
      ? { phase: { ...checked, verified: [...state.verified, options.stepContext] }, entries: projected, mismatch: false }
      : { ...archive, mismatch: true }
  }),
  Match.exhaustive,
)
