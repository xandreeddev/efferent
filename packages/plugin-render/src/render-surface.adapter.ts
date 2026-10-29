import { Deferred, Effect, Layer, Option, Ref, Schema, Stream, Semaphore } from "effect"
import { UiOutputProposal } from "./domain/render-output.entity.js"
import type { UiOutputReceipt } from "./domain/render-output.entity.js"
import { RenderError, RenderNode, RenderSnapshot, SurfaceCompleted, SurfaceFrozen, SurfacePlanned } from "./domain/render-surface.entity.js"
import type { FreezeReason, PublishResult, RenderSnapshotInput, SurfaceScope, SurfaceState } from "./domain/render-surface.entity.js"
import {
  describeError,
  fillOperationIdOf,
  fromOutputError,
  missingNodesOf,
  operationIdOf,
  outputScopeOf,
  progressOf,
  proposalOf,
  signatureOf,
  versionIdOf,
} from "./domain/render-surface.entity.functions.js"
import type { SurfaceProgress } from "./domain/render-surface.entity.functions.js"
import { UiOutputAdmission } from "./ports/render-output.port.js"
import { Render, RenderStore } from "./ports/render.port.js"
import type { RenderOpenOptions, RenderSurface } from "./ports/render.port.js"

const invalid = (message: string) => new RenderError({ code: "invalid", message })

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

/**
 * One surface for one message: versions (`<messageId>:v<generation>`),
 * signature dedupe, one idempotent commit per node, completion, freeze and
 * background preparation. Writes are serialized; preparations run one at a
 * time through the host's `fork`. Identical content opens no generation but
 * still commits the nodes an earlier attempt left uncommitted.
 */
export const openSurface = (
  store: typeof RenderStore.Service,
  admission: typeof UiOutputAdmission.Service,
  maxBytes: number,
) => (scope: SurfaceScope, options: RenderOpenOptions): Effect.Effect<RenderSurface, RenderError> => Effect.gen(function* () {
  const records = yield* store.hydrate(scope)
  const progress = yield* Ref.make<SurfaceProgress>(progressOf(scope.surfaceId, scope.messageId, records))
  const writer = yield* Semaphore.make(1)
  const preparer = yield* Semaphore.make(1)
  const preparations = yield* Ref.make<ReadonlyArray<Deferred.Deferred<void>>>([])
  const output = outputScopeOf(scope)
  const identity = { surfaceId: scope.surfaceId, messageId: scope.messageId }
  const updateState = (change: (state: SurfaceProgress["state"]) => SurfaceProgress["state"]) =>
    Ref.update(progress, (current) => ({ ...current, state: change(current.state) }))

  const commitNode = (versionId: string, operationId: string, node: RenderNode): Effect.Effect<UiOutputReceipt, RenderError> => Effect.gen(function* () {
    const proposal = proposalOf(operationId, node)
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(UiOutputProposal))(proposal).pipe(
      Effect.mapError(() => invalid("A component must be serializable")),
    )
    if (new TextEncoder().encode(json).byteLength > maxBytes) return yield* Effect.fail(invalid("A component exceeds the configured size limit"))
    yield* admission.validate(output, proposal).pipe(Effect.mapError(fromOutputError))
    return yield* store.commit(scope, { versionId, proposal })
  })

  /** A node landed in the current version: it is no longer missing, and its component is on the surface. */
  const recordCommitted = (node: RenderNode) => Ref.update(progress, (value) => ({
    ...value,
    committed: [...value.committed, node.nodeId],
    state: { ...value.state, components: unique([...value.state.components, node.release.component]) },
  }))

  const commitNodes = (versionId: string, generation: number, nodes: ReadonlyArray<RenderNode>) => Effect.forEach(nodes, (node) =>
    commitNode(versionId, operationIdOf(scope.runId, scope.surfaceId, generation, node.nodeId), node).pipe(Effect.andThen(recordCommitted(node))),
  { discard: true })

  const snapshotResult = (frozen: boolean) => Ref.get(progress).pipe(Effect.map((current): PublishResult => ({
    version: current.state.version, generation: current.state.generation, changed: false, frozen,
  })))

  /** Recorded once: the version this message reached is final but partial (a completed version stays complete). */
  const recordFrozenCompletion = Effect.gen(function* () {
    const current = yield* Ref.get(progress)
    if (current.frozenRecorded) return
    yield* Option.match(current.state.completed ? Option.none() : current.state.version, {
      onNone: () => Effect.void,
      onSome: (versionId) => store.complete(scope, SurfaceCompleted.make({
        ...identity, versionId, generation: current.state.generation, phase: "partial", frozen: true,
      })),
    })
    yield* Ref.update(progress, (value) => ({ ...value, frozenRecorded: true, state: { ...value.state, frozen: true } }))
  })

  const markComplete = (versionId: string, generation: number) => store.complete(scope, SurfaceCompleted.make({
    ...identity, versionId, generation, phase: "complete", frozen: false,
  })).pipe(Effect.andThen(updateState((state) => ({ ...state, completed: true }))))

  const publishNow = (input: RenderSnapshotInput): Effect.Effect<PublishResult, RenderError> => Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(RenderSnapshot)(input, { onExcessProperty: "error", reportInput: true }).pipe(
      Effect.mapError((error) => invalid(`Invalid snapshot: ${error.message}`)),
    )
    const current = yield* Ref.get(progress)
    if (current.state.frozen) return yield* recordFrozenCompletion.pipe(Effect.andThen(snapshotResult(true)))
    const signature = signatureOf(snapshot)
    if (Option.contains(current.signature, signature)) {
      return yield* Option.match(current.state.version, {
        onNone: () => snapshotResult(false),
        onSome: (versionId) => resume(versionId, current, snapshot),
      })
    }
    const generation = current.state.generation + 1
    const versionId = versionIdOf(scope.messageId, generation)
    const planned = yield* store.plan(scope, SurfacePlanned.make({
      ...identity,
      versionId,
      generation,
      baseVersionId: Option.orElse(scope.baseVersion, () => current.state.version),
      phase: snapshot.phase,
      spec: snapshot.spec,
      nodes: snapshot.nodes.map((node) => node.nodeId),
      placeholders: snapshot.placeholders,
      signature,
    })).pipe(
      Effect.as(true),
      Effect.catchIf((error) => error.code === "frozen", () => Effect.succeed(false)),
    )
    if (!planned) {
      yield* updateState((state) => ({ ...state, frozen: true }))
      return yield* recordFrozenCompletion.pipe(Effect.andThen(snapshotResult(true)))
    }
    yield* Ref.update(progress, (value) => ({
      ...value,
      signature: Option.some(signature),
      committed: [],
      state: { ...value.state, version: Option.some(versionId), generation, completed: false, components: [], placeholders: snapshot.placeholders },
    }))
    yield* commitNodes(versionId, generation, snapshot.nodes)
    if (snapshot.phase === "complete") yield* markComplete(versionId, generation)
    return { version: Option.some(versionId), generation, changed: true, frozen: false }
  })

  /** Identical content keeps its version: commit what is still missing (same operation ids), then complete. */
  const resume = (versionId: string, current: SurfaceProgress, snapshot: RenderSnapshot): Effect.Effect<PublishResult, RenderError> => Effect.gen(function* () {
    const missing = missingNodesOf(current, snapshot)
    yield* commitNodes(versionId, current.state.generation, missing)
    if (snapshot.phase === "complete" && !current.state.completed) yield* markComplete(versionId, current.state.generation)
    return { version: Option.some(versionId), generation: current.state.generation, changed: missing.length > 0, frozen: false }
  })

  const publish = (input: RenderSnapshotInput) => writer.withPermits(1)(publishNow(input))

  const fill = (placeholder: string, input: RenderNode) => writer.withPermits(1)(Effect.gen(function* () {
    const node = yield* Schema.decodeUnknownEffect(RenderNode)(input, { onExcessProperty: "error", reportInput: true }).pipe(
      Effect.mapError((error) => invalid(`Invalid node: ${error.message}`)),
    )
    const current = yield* Ref.get(progress)
    const versionId = yield* Option.match(current.state.version, {
      onNone: () => Effect.fail(invalid("Nothing has been published on this surface")),
      onSome: Effect.succeed,
    })
    if (!current.state.placeholders.includes(placeholder)) return yield* Effect.fail(invalid(`The current version declares no placeholder ${placeholder}`))
    if (node.nodeId !== placeholder) return yield* Effect.fail(invalid("A fill must use its placeholder as node id"))
    const receipt = yield* commitNode(versionId, fillOperationIdOf(scope.runId, scope.surfaceId, current.state.generation, placeholder), node)
    yield* store.annotate(scope, "render.filled", { versionId, placeholder })
    yield* recordCommitted(node)
    return receipt
  }))

  const prepare = <E>(work: Stream.Stream<RenderSnapshotInput, E>, recover: (error: E | RenderError) => Effect.Effect<void>) => Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    yield* Ref.update(preparations, (all) => [...all, done])
    const run = preparer.withPermits(1)(Stream.runForEach(work, publish)).pipe(
      Effect.catch((error: E | RenderError) => store.annotate(scope, "render.preparation-failed", { message: describeError(error) }).pipe(
        Effect.ignore,
        Effect.andThen(recover(error)),
      )),
      Effect.ensuring(Deferred.succeed(done, undefined)),
    )
    yield* options.fork(`render:${scope.surfaceId}`, run)
  })

  const settled = Ref.get(preparations).pipe(Effect.flatMap((all) => Effect.forEach(all, Deferred.await, { discard: true })))

  const state = Effect.gen(function* () {
    const current = yield* Ref.get(progress)
    const finished = yield* Effect.forEach(yield* Ref.get(preparations), Deferred.isDone)
    return { ...current.state, pending: finished.some((done) => !done) } satisfies SurfaceState
  })

  /** Freezes at the version reached, or before the first one: either way no later generation is planned. */
  const freeze = (reason: FreezeReason) => writer.withPermits(1)(Effect.gen(function* () {
    const current = yield* Ref.get(progress)
    yield* store.freeze(scope, SurfaceFrozen.make({ ...identity, versionId: current.state.version, reason }))
    yield* updateState((value) => ({ ...value, frozen: true }))
  }))

  return {
    scope,
    records,
    state,
    publish,
    fill,
    prepare,
    settled,
    freeze,
    annotate: (kind, data) => store.annotate(scope, kind, data),
  } satisfies RenderSurface
})

export const RenderLive = (maxBytes = 32_768) => Layer.effect(Render, Effect.gen(function* () {
  const store = yield* RenderStore
  const admission = yield* UiOutputAdmission
  return Render.of({ open: openSurface(store, admission, maxBytes) })
}))
