import { Effect, Result, Layer, Ref, Schema } from "effect"
import { canonicalJson } from "@xandreed/core"
import type { UiOutputReceipt } from "./domain/render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceFrozen } from "./domain/render-surface.entity.js"
import type { SurfaceRecord, SurfaceScope } from "./domain/render-surface.entity.js"
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
  readonly annotations: ReadonlyArray<MemoryAnnotation>
  readonly sequence: number
}

const isFrozen = Schema.is(SurfaceFrozen)

const ownerOf = (scope: SurfaceScope): string => canonicalJson([scope.threadId, scope.principalId])

/** Whether a freeze, with or without a version, binds this surface and message for the scope's thread and principal. */
const frozenIn = (entries: ReadonlyArray<MemoryEntry>, scope: SurfaceScope, record: { readonly surfaceId: string; readonly messageId: string }) =>
  entries.some((entry) => entry.owner === ownerOf(scope) && isFrozen(entry.record)
    && entry.record.surfaceId === record.surfaceId && entry.record.messageId === record.messageId)

/** A complete in-process RenderStore, for tests, examples and single-process hosts. */
export const makeMemoryRenderStore = Effect.gen(function* () {
  const stored = yield* Ref.make<MemoryState>({ entries: [], receipts: new Map(), annotations: [], sequence: 0 })
  const append = (scope: SurfaceScope, record: SurfaceRecord) =>
    Ref.update(stored, (state) => ({ ...state, entries: [...state.entries, { owner: ownerOf(scope), record }] }))
  const store = RenderStore.of({
    hydrate: (scope) => Ref.get(stored).pipe(Effect.map((state) => state.entries.flatMap((entry) =>
      entry.owner === ownerOf(scope) && entry.record.surfaceId === scope.surfaceId ? [entry.record] : []))),
    plan: (scope, record) => Ref.modify(stored, (state): readonly [boolean, MemoryState] =>
      frozenIn(state.entries, scope, record)
        ? [false, state]
        : [true, { ...state, entries: [...state.entries, { owner: ownerOf(scope), record }] }],
    ).pipe(Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new RenderError({ code: "frozen", message: "The surface is frozen for this message" })))),
    commit: (scope, { versionId, proposal }) => Ref.modify(stored, (state): readonly [Result.Result<UiOutputReceipt, RenderError>, MemoryState] => {
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
        threadId: scope.threadId, messageId: scope.messageId, revisionId: `${proposal.operationId}:r${sequence}`, sequence, nodeId: proposal.nodeId,
      }
      const committed = SurfaceCommitted.make({
        surfaceId: scope.surfaceId, messageId: scope.messageId, versionId, nodeId: proposal.nodeId, component: proposal.release.component, receipt,
      })
      return [Result.succeed(receipt), {
        ...state,
        sequence,
        receipts: new Map([...state.receipts, [key, { proposal: content, receipt }]]),
        entries: [...state.entries, { owner: ownerOf(scope), record: committed }],
      }]
    }).pipe(Effect.flatMap(Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }))),
    complete: (scope, record) => append(scope, record),
    freeze: (scope, record) => Ref.update(stored, (state) => frozenIn(state.entries, scope, record)
      ? state
      : { ...state, entries: [...state.entries, { owner: ownerOf(scope), record }] }),
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
