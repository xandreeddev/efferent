import { Effect, Result, Layer, Ref, Schema } from "effect"
import { canonicalJson } from "@xandreed/core"
import { RevisionId } from "./domain/render-output.entity.js"
import type { RenderMessageId, UiOutputReceipt } from "./domain/render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceFrozen, SurfacePlanned } from "./domain/render-surface.entity.js"
import type { SurfaceId, SurfaceRecord, SurfaceScope } from "./domain/render-surface.entity.js"
import { RenderStore } from "./ports/render.port.js"

export interface MemoryAnnotation {
  readonly surfaceId: string
  readonly kind: string
  readonly data: Readonly<Record<string, unknown>>
}

/** A record under the thread and principal whose scope wrote it. */
interface MemoryEntry {
  readonly owner: string
  readonly record: SurfaceRecord
}

interface MemoryState {
  readonly entries: ReadonlyArray<MemoryEntry>
  readonly receipts: ReadonlyMap<string, { readonly proposal: string; readonly receipt: UiOutputReceipt }>
  /** The highest fence accepted per surface and message (`fenceKeyOf`). */
  readonly fences: ReadonlyMap<string, number>
  readonly annotations: ReadonlyArray<MemoryAnnotation>
  readonly sequence: number
}

/** A write's outcome and the state it leaves, decided in one `Ref.modify`. */
type Decision<A> = readonly [Result.Result<A, RenderError>, MemoryState]

/** The surface and message a write names. */
interface Target {
  readonly surfaceId: SurfaceId
  readonly messageId: RenderMessageId
}

const isPlanned = Schema.is(SurfacePlanned)
const isFrozen = Schema.is(SurfaceFrozen)

const ownerOf = (scope: SurfaceScope): string => canonicalJson([scope.threadId, scope.principalId])

/** The surface and message under the scope's thread and principal, the key its fence is kept under. */
const fenceKeyOf = (scope: SurfaceScope, target: Target): string =>
  canonicalJson([scope.threadId, scope.principalId, target.surfaceId, target.messageId])

/** The scope's records of the surface and message. */
const recordsOf = (entries: ReadonlyArray<MemoryEntry>, scope: SurfaceScope, target: Target): ReadonlyArray<SurfaceRecord> =>
  entries.flatMap((entry) => entry.owner === ownerOf(scope) && entry.record.surfaceId === target.surfaceId && entry.record.messageId === target.messageId
    ? [entry.record]
    : [])

/** Whether a freeze, with or without a version, binds this surface and message for the scope's thread and principal. */
const frozenIn = (entries: ReadonlyArray<MemoryEntry>, scope: SurfaceScope, target: Target) => recordsOf(entries, scope, target).some(isFrozen)

/** The generation a plan for this surface and message must carry: the highest planned plus one. */
const nextGeneration = (entries: ReadonlyArray<MemoryEntry>, scope: SurfaceScope, target: Target): number =>
  Math.max(0, ...recordsOf(entries, scope, target).flatMap((record) => isPlanned(record) ? [record.generation] : [])) + 1

const appended = (state: MemoryState, scope: SurfaceScope, record: SurfaceRecord): MemoryState =>
  ({ ...state, entries: [...state.entries, { owner: ownerOf(scope), record }] })

/**
 * A write under the scope's fence: refused (`forbidden`) when the surface and
 * message accepted a higher fence; once the write is accepted, its fence is
 * the highest.
 */
const fenced = <A>(scope: SurfaceScope, target: Target, write: (state: MemoryState) => Decision<A>) => (state: MemoryState): Decision<A> => {
  const key = fenceKeyOf(scope, target)
  const highest = state.fences.get(key) ?? 0
  if (scope.fence < highest) {
    return [Result.fail(new RenderError({
      code: "forbidden", message: `Fence ${scope.fence} is stale: surface ${target.surfaceId} of message ${target.messageId} accepted fence ${highest}`,
    })), state]
  }
  const [result, next] = write(state)
  return Result.isSuccess(result) ? [result, { ...next, fences: new Map([...next.fences, [key, scope.fence]]) }] : [result, next]
}

/** A complete in-process RenderStore, for tests, examples and single-process hosts. */
export const makeMemoryRenderStore = Effect.gen(function* () {
  const stored = yield* Ref.make<MemoryState>({ entries: [], receipts: new Map(), fences: new Map(), annotations: [], sequence: 0 })
  const decide = <A>(decision: (state: MemoryState) => Decision<A>) => Ref.modify(stored, decision).pipe(Effect.flatMap(Effect.fromResult))
  const store = RenderStore.of({
    hydrate: (scope) => Ref.get(stored).pipe(Effect.map((state) => state.entries.flatMap((entry) =>
      entry.owner === ownerOf(scope) && entry.record.surfaceId === scope.surfaceId ? [entry.record] : []))),
    plan: (scope, record) => decide(fenced(scope, record, (state): Decision<void> => {
      if (frozenIn(state.entries, scope, record)) return [Result.fail(new RenderError({ code: "frozen", message: "The surface is frozen for this message" })), state]
      const next = nextGeneration(state.entries, scope, record)
      return record.generation === next
        ? [Result.void, appended(state, scope, record)]
        : [Result.fail(new RenderError({ code: "conflict", message: `Generation ${record.generation} is not the next for this surface and message (${next})` })), state]
    })),
    commit: (scope, { versionId, proposal }) => decide(fenced(scope, scope, (state): Decision<UiOutputReceipt> => {
      const content = canonicalJson(proposal)
      const key = canonicalJson([scope.threadId, scope.principalId, proposal.operationId])
      const existing = state.receipts.get(key)
      if (existing !== undefined) {
        return existing.proposal === content
          ? [Result.succeed(existing.receipt), state]
          : [Result.fail(new RenderError({ code: "conflict", message: `Operation ${proposal.operationId} was already committed with other content` })), state]
      }
      const sequence = state.sequence + 1
      const receipt: UiOutputReceipt = {
        threadId: scope.threadId, messageId: scope.messageId, revisionId: RevisionId.make(`${proposal.operationId}:r${sequence}`), sequence, nodeId: proposal.nodeId,
      }
      const committed = SurfaceCommitted.make({
        surfaceId: scope.surfaceId, messageId: scope.messageId, versionId, nodeId: proposal.nodeId, component: proposal.release.component, receipt,
      })
      return [Result.succeed(receipt), {
        ...appended(state, scope, committed),
        sequence,
        receipts: new Map([...state.receipts, [key, { proposal: content, receipt }]]),
      }]
    })),
    complete: (scope, record) => decide(fenced(scope, record, (state): Decision<void> => [Result.void, appended(state, scope, record)])),
    freeze: (scope, record) => decide(fenced(scope, record, (state): Decision<void> =>
      [Result.void, frozenIn(state.entries, scope, record) ? state : appended(state, scope, record)])),
    annotate: (scope, kind, data) => Ref.update(stored, (state) => ({
      ...state, annotations: [...state.annotations, { surfaceId: scope.surfaceId, kind, data }],
    })),
  })
  return {
    store,
    /** Every record, of every thread and principal, in write order. */
    records: Ref.get(stored).pipe(Effect.map((state) => state.entries.map((entry) => entry.record))),
    annotations: Ref.get(stored).pipe(Effect.map((state) => state.annotations)),
  }
})

export const MemoryRenderStoreLive = Layer.effect(RenderStore, makeMemoryRenderStore.pipe(Effect.map(({ store }) => store)))
