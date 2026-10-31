import { Effect, Match, Option, Schema } from "effect"
import { SessionLogError } from "../session/session-log.entity.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { LogEntry } from "./memory-log.entity.js"
import { buildContext, canonicalJson, entriesSendingMedia, requestEntryOfResult, retainedMemoryPrefix } from "./memory-log.entity.functions.js"
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

/** Validate the selected snapshot against authoritative raw facts before enabling reuse. */
export const validateMemorySnapshot = Effect.fnUntraced(function* (entries: ReadonlyArray<LogEntry>, input: MemorySnapshotCandidate, strategy: MemorySnapshotCandidate["strategy"], options: RenderOptions): Effect.fn.Return<MemoryProjection, SessionLogError> {
  const candidate = yield* copyCandidate(input).pipe(Effect.mapError(invalid))
  const anchorIndex = entries.findIndex((entry) => entry.id === candidate.anchor)
  const throughIndex = entries.findIndex((entry) => entry.id === candidate.through)
  if (anchorIndex < 0 || throughIndex < anchorIndex || entries[anchorIndex]?.body._tag !== "TurnStarted" ||
    entries.filter((entry) => entry.id === candidate.anchor || entry.id === candidate.through).length !== (candidate.anchor === candidate.through ? 1 : 2)) {
    return yield* Effect.fail(invalid({ anchor: candidate.anchor, through: candidate.through }))
  }
  const prefix = entries.slice(0, throughIndex + 1)
  const expected = retainedMemoryPrefix(prefix, candidate.strategy.id)
  if (Option.isNone(expected) || expected.value.anchorIndex !== anchorIndex ||
    !(yield* sameEntries(candidate.entries, expected.value.entries).pipe(Effect.mapError(invalid)))) {
    return yield* Effect.fail(invalid({ anchor: candidate.anchor, entries: candidate.entries }))
  }
  if (candidate.strategy.id !== strategy.id || candidate.strategy.version !== strategy.version) return full
  const selected: MemoryProjection = { _tag: "Projected", candidate, anchorIndex, throughIndex, cutTurn: expected.value.cutTurn, checkedThrough: throughIndex }
  const projected = projectMemorySnapshot(entries, selected, options)
  if (projected.phase._tag === "Full") return full
  // Verify both placements once on open. Repeated builds use the guarded prefix,
  // rather than paying for a full archive render each time.
  const equal = ["none", "tail"].every((stepContext) => {
    const render: RenderOptions = { ...options, stepContext: stepContext === "none" ? "none" : "tail" }
    return canonicalJson(buildContext(entries, render)) === canonicalJson(buildContext(projected.entries, render)) &&
      canonicalJson(entriesSendingMedia(entries, render)) === canonicalJson(entriesSendingMedia(projected.entries, render))
  })
  return equal ? projected.phase : yield* Effect.fail(invalid({ anchor: candidate.anchor, reason: "render mismatch" }))
})

/** A pure guarded projection; legitimate new dependencies restore the full archive. */
export const projectMemorySnapshot = (entries: ReadonlyArray<LogEntry>, phase: MemoryProjection, options: RenderOptions): { readonly phase: MemoryProjection; readonly entries: ReadonlyArray<LogEntry> } => Match.value(phase).pipe(
  Match.tag("Full", () => ({ phase: full, entries })),
  Match.tag("Projected", (state) => {
    if (options.strategy !== state.candidate.strategy.id || entries[state.anchorIndex]?.id !== state.candidate.anchor ||
      entries[state.throughIndex]?.id !== state.candidate.through || entries.length <= state.checkedThrough) return { phase: full, entries }
    const retained = new Set(state.candidate.entries.map((entry) => entry.id))
    const omitted = new Set(entries.slice(0, state.anchorIndex).flatMap((entry) => retained.has(entry.id) ? [] : [entry.id]))
    const newEntries = entries.slice(state.checkedThrough + 1)
    const unsafe = newEntries.some((entry) => {
      if ((entry.body._tag === "ToolPresentation" || entry.body._tag === "ToolDigest") && omitted.has(entry.body.entry)) return true
      return entry.body._tag === "ToolResult" && Option.match(requestEntryOfResult(entries, entry), { onNone: () => false, onSome: (request) => omitted.has(request.id) })
    })
    if (unsafe) return { phase: full, entries }
    const updated: MemoryProjection = { ...state, checkedThrough: entries.length - 1 }
    return { phase: updated, entries: [...state.candidate.entries, ...entries.slice(state.anchorIndex)] }
  }),
  Match.exhaustive,
)
