import { expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, Schema } from "effect"
import { canonicalJson } from "@xandreed/core"
import { RevisionId } from "./domain/render-output.entity.js"
import type { UiOutputReceipt } from "./domain/render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceFrozen } from "./domain/render-surface.entity.js"
import type { SurfaceRecord, SurfaceScope } from "./domain/render-surface.entity.js"
import { UiOutputAdmission } from "./ports/render-output.port.js"
import { Render, RenderStore } from "./ports/render.port.js"
import { RenderLive } from "./render-surface.adapter.js"
import { renderSurfaceConformance } from "./render-surface.conformance.js"

interface Careless {
  readonly entries: ReadonlyArray<{ readonly owner: string; readonly record: SurfaceRecord }>
  readonly receipts: ReadonlyMap<string, { readonly proposal: string; readonly receipt: UiOutputReceipt }>
  readonly fences: ReadonlyMap<string, number>
}
type Written<A> = readonly [Result.Result<A, RenderError>, Careless]

const isFrozen = Schema.is(SurfaceFrozen)
const ownerOf = (scope: SurfaceScope) => canonicalJson([scope.threadId, scope.principalId])
const append = (current: Careless, scope: SurfaceScope, record: SurfaceRecord): Careless =>
  ({ ...current, entries: [...current.entries, { owner: ownerOf(scope), record }] })
const frozenIn = (current: Careless, scope: SurfaceScope) => current.entries.some((entry) => entry.owner === ownerOf(scope)
  && isFrozen(entry.record) && entry.record.surfaceId === scope.surfaceId && entry.record.messageId === scope.messageId)

/**
 * A store that keeps the whole contract but one rule: `plan` takes whatever
 * generation it is given, so a writer behind the store plans a version that
 * already exists.
 */
const carelessStore = Effect.gen(function* () {
  const state = yield* Ref.make<Careless>({ entries: [], receipts: new Map(), fences: new Map() })
  const write = <A>(scope: SurfaceScope, apply: (current: Careless) => Written<A>) => Ref.modify(state, (current): Written<A> => {
    const key = canonicalJson([ownerOf(scope), scope.surfaceId, scope.messageId])
    if (scope.fence < (current.fences.get(key) ?? 0)) return [Result.fail(new RenderError({ code: "forbidden", message: "A higher fence was accepted" })), current]
    const [result, next] = apply(current)
    return [result, Result.isSuccess(result) ? { ...next, fences: new Map([...next.fences, [key, scope.fence]]) } : next]
  }).pipe(Effect.flatMap(Effect.fromResult))
  return RenderStore.of({
    hydrate: (scope) => Ref.get(state).pipe(Effect.map((current) => current.entries.flatMap((entry) =>
      entry.owner === ownerOf(scope) && entry.record.surfaceId === scope.surfaceId ? [entry.record] : []))),
    plan: (scope, record) => write(scope, (current): Written<void> => frozenIn(current, scope)
      ? [Result.fail(new RenderError({ code: "frozen", message: "The surface is frozen for this message" })), current]
      : [Result.void, append(current, scope, record)]),
    commit: (scope, { versionId, proposal }) => write(scope, (current): Written<UiOutputReceipt> => {
      const key = canonicalJson([ownerOf(scope), proposal.operationId])
      const content = canonicalJson(proposal)
      const existing = current.receipts.get(key)
      if (existing !== undefined) {
        return [existing.proposal === content ? Result.succeed(existing.receipt) : Result.fail(new RenderError({ code: "conflict", message: "Reused operation id" })), current]
      }
      const sequence = current.receipts.size + 1
      const receipt: UiOutputReceipt = {
        threadId: scope.threadId, messageId: scope.messageId, revisionId: RevisionId.make(`revision-${sequence}`), sequence, nodeId: proposal.nodeId,
      }
      const committed = SurfaceCommitted.make({
        surfaceId: scope.surfaceId, messageId: scope.messageId, versionId, nodeId: proposal.nodeId, component: proposal.release.component, receipt,
      })
      return [Result.succeed(receipt), { ...append(current, scope, committed), receipts: new Map([...current.receipts, [key, { proposal: content, receipt }]]) }]
    }),
    complete: (scope, record) => write(scope, (current): Written<void> => [Result.void, append(current, scope, record)]),
    freeze: (scope, record) => write(scope, (current): Written<void> => [Result.void, frozenIn(current, scope) ? current : append(current, scope, record)]),
    annotate: () => Effect.void,
  })
})

test("the surface kit fails a store without the generation check, on the generation checks alone", async () => {
  const subject = {
    make: (admission: typeof UiOutputAdmission.Service) => carelessStore.pipe(Effect.flatMap((store) =>
      Effect.map(Render, (render) => ({ render, store })).pipe(
        Effect.provide(RenderLive().pipe(Layer.provide(Layer.mergeAll(Layer.succeed(RenderStore, store), Layer.succeed(UiOutputAdmission, admission))))),
      ))),
  }
  const failed = await Effect.runPromise(Effect.forEach(renderSurfaceConformance(subject), (check) => Effect.match(check.run, {
    onFailure: (error) => [{ check: check.name, failure: error._tag }],
    onSuccess: () => [],
  }), { concurrency: 1 }))
  expect(failed.flat()).toEqual([
    { check: "two writers of one message never plan the same version", failure: "ConformanceFailure" },
    { check: "the store refuses a plan that skips or repeats a generation", failure: "ConformanceFailure" },
  ])
})
