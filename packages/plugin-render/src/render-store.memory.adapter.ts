import { Effect, Either, Layer, Ref, Schema } from "effect"
import { canonicalJson } from "@xandreed/core"
import type { UiOutputReceipt } from "./domain/render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceFrozen } from "./domain/render-surface.entity.js"
import type { SurfaceRecord } from "./domain/render-surface.entity.js"
import { RenderStore } from "./ports/render.port.js"

export interface MemoryAnnotation {
  readonly surfaceId: string
  readonly kind: string
  readonly data: Readonly<Record<string, unknown>>
}

interface MemoryState {
  readonly records: ReadonlyArray<SurfaceRecord>
  readonly receipts: ReadonlyMap<string, { readonly proposal: string; readonly receipt: UiOutputReceipt }>
  readonly annotations: ReadonlyArray<MemoryAnnotation>
  readonly sequence: number
}

const isFrozen = Schema.is(SurfaceFrozen)

/** A complete in-process RenderStore, for tests, examples and single-process hosts. */
export const makeMemoryRenderStore = Effect.gen(function* () {
  const stored = yield* Ref.make<MemoryState>({ records: [], receipts: new Map(), annotations: [], sequence: 0 })
  const append = (record: SurfaceRecord) => Ref.update(stored, (state) => ({ ...state, records: [...state.records, record] }))
  const store = RenderStore.of({
    hydrate: (scope) => Ref.get(stored).pipe(Effect.map((state) => state.records.filter((record) => record.surfaceId === scope.surfaceId))),
    plan: (_scope, record) => Ref.modify(stored, (state): readonly [boolean, MemoryState] =>
      state.records.some((existing) => isFrozen(existing) && existing.surfaceId === record.surfaceId && existing.messageId === record.messageId)
        ? [false, state]
        : [true, { ...state, records: [...state.records, record] }],
    ).pipe(Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new RenderError({ code: "frozen", message: "The surface is frozen for this message" })))),
    commit: (scope, { versionId, proposal }) => Ref.modify(stored, (state): readonly [Either.Either<UiOutputReceipt, RenderError>, MemoryState] => {
      const content = canonicalJson(proposal)
      const existing = state.receipts.get(proposal.operationId)
      if (existing !== undefined) {
        return existing.proposal === content
          ? [Either.right(existing.receipt), state]
          : [Either.left(new RenderError({ code: "conflict", message: `Operation ${proposal.operationId} was already committed with other content` })), state]
      }
      const sequence = state.sequence + 1
      const receipt: UiOutputReceipt = {
        threadId: scope.threadId, messageId: scope.messageId, revisionId: `${proposal.operationId}:r${sequence}`, sequence, nodeId: proposal.nodeId,
      }
      const committed = SurfaceCommitted.make({
        surfaceId: scope.surfaceId, messageId: scope.messageId, versionId, nodeId: proposal.nodeId, component: proposal.release.component, receipt,
      })
      return [Either.right(receipt), {
        ...state,
        sequence,
        receipts: new Map([...state.receipts, [proposal.operationId, { proposal: content, receipt }]]),
        records: [...state.records, committed],
      }]
    }).pipe(Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed }))),
    complete: (_scope, record) => append(record),
    freeze: (_scope, record) => Ref.update(stored, (state) =>
      state.records.some((existing) => isFrozen(existing) && existing.versionId === record.versionId)
        ? state
        : { ...state, records: [...state.records, record] }),
    annotate: (scope, kind, data) => Ref.update(stored, (state) => ({
      ...state, annotations: [...state.annotations, { surfaceId: scope.surfaceId, kind, data }],
    })),
  })
  return {
    store,
    records: Ref.get(stored).pipe(Effect.map((state) => state.records)),
    annotations: Ref.get(stored).pipe(Effect.map((state) => state.annotations)),
  }
})

export const MemoryRenderStoreLive = Layer.effect(RenderStore, makeMemoryRenderStore.pipe(Effect.map(({ store }) => store)))
