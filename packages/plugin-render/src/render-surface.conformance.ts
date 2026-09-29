import { Effect, Option, Ref, Schema, Stream } from "effect"
import { canonicalJson } from "@xandreed/core"
import { ConformanceFailure } from "./domain/conformance.entity.js"
import { UiOutputError } from "./domain/render-output.entity.js"
import type { UiOutputProposal } from "./domain/render-output.entity.js"
import { SurfaceCommitted, SurfaceCompleted, SurfaceFrozen, SurfacePlanned } from "./domain/render-surface.entity.js"
import type { RenderError, RenderNode, RenderSnapshotInput, SurfaceRecord, SurfaceScope } from "./domain/render-surface.entity.js"
import type { UiOutputAdmission } from "./ports/render-output.port.js"
import type { Render, RenderOpenOptions, RenderStore } from "./ports/render.port.js"

export interface ConformanceCheck {
  readonly name: string
  readonly run: Effect.Effect<void, ConformanceFailure | RenderError>
}

/** A fresh surface implementation and its store for each check, built over the given admission. */
export interface SurfaceSubject {
  readonly make: (admission: typeof UiOutputAdmission.Service) => Effect.Effect<{
    readonly render: typeof Render.Service
    readonly store: typeof RenderStore.Service
  }, RenderError>
}

const release = (component: string) => ({
  component, version: "1", definitionHash: "a".repeat(64), rendererRelease: "1", tokensHash: "b".repeat(64), layoutVersion: "1",
})
const node = (nodeId: string, component = "card"): RenderNode => ({ nodeId, release: release(component), props: { title: nodeId }, evidence: [`${nodeId}-fact`] })
const snapshot = (nodes: ReadonlyArray<RenderNode>, phase: "partial" | "complete" = "partial", placeholders: ReadonlyArray<string> = []): RenderSnapshotInput => ({
  phase, spec: { layout: "stack", order: nodes.map((entry) => entry.nodeId) }, nodes, placeholders,
})
const scopeOf = (messageId = "message-1"): SurfaceScope => ({
  threadId: "thread", runId: `run-${messageId}`, messageId, principalId: "guest", fence: 1, surfaceId: "page", baseVersion: Option.none(),
})
const detached: RenderOpenOptions = { fork: (_tag, work) => Effect.forkDetach(work).pipe(Effect.asVoid) }
const allow: typeof UiOutputAdmission.Service = { validate: () => Effect.void }

const holds = (check: string) => (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ConformanceFailure({ check, message }))

/** The effect must fail; its error is returned for inspection. */
const failureOf = (check: string) => <A, E>(effect: Effect.Effect<A, E>) => Effect.matchEffect(effect, {
  onFailure: (error) => Effect.succeed(error),
  onSuccess: () => Effect.fail(new ConformanceFailure({ check, message: "expected a failure" })),
})

const isPlanned = Schema.is(SurfacePlanned)
const isCommitted = Schema.is(SurfaceCommitted)
const isCompleted = Schema.is(SurfaceCompleted)
const planned = (records: ReadonlyArray<SurfaceRecord>) => records.filter(isPlanned)

/** The contract every Render/RenderStore pair must keep, run against any implementation. */
export const renderSurfaceConformance = (subject: SurfaceSubject): ReadonlyArray<ConformanceCheck> => [
  {
    name: "identical content opens no new generation",
    run: Effect.gen(function* () {
      const expect = holds("identical content opens no new generation")
      const { render } = yield* subject.make(allow)
      const surface = yield* render.open(scopeOf(), detached)
      const first = yield* surface.publish(snapshot([node("a")]))
      const second = yield* surface.publish(snapshot([node("a")]))
      yield* expect(first.changed && Option.contains(first.version, "message-1:v1"), "the first publish opens message-1:v1")
      yield* expect(!second.changed && second.generation === 1, "the same content keeps generation 1")
    }),
  },
  {
    name: "changed content opens the next generation with its own operation ids",
    run: Effect.gen(function* () {
      const expect = holds("changed content opens the next generation with its own operation ids")
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const { render } = yield* subject.make({ validate: (_scope, proposal: UiOutputProposal) => Ref.update(operations, (all) => [...all, proposal.operationId]) })
      const surface = yield* render.open(scopeOf(), detached)
      yield* surface.publish(snapshot([node("a")]))
      const second = yield* surface.publish(snapshot([node("a"), node("b")]))
      yield* expect(Option.contains(second.version, "message-1:v2") && second.generation === 2, "the changed content opens message-1:v2")
      const ids = yield* Ref.get(operations)
      yield* expect(canonicalJson(ids) === canonicalJson(["run-message-1:render:1:a", "run-message-1:render:2:a", "run-message-1:render:2:b"]),
        `operation ids are per generation and node, got ${canonicalJson(ids)}`)
    }),
  },
  {
    name: "completion is recorded once per version",
    run: Effect.gen(function* () {
      const expect = holds("completion is recorded once per version")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      yield* surface.publish(snapshot([node("a")], "partial"))
      const done = yield* surface.publish(snapshot([node("a")], "complete"))
      yield* surface.publish(snapshot([node("a")], "complete"))
      const records = yield* store.hydrate(scope)
      yield* expect(!done.changed, "completing the same content opens no generation")
      yield* expect(records.filter((record) => isCompleted(record) && !record.frozen).length === 1, "one completion for the version")
      yield* expect((yield* surface.state).completed, "the state reports completion")
    }),
  },
  {
    name: "a surface frozen elsewhere records a frozen partial completion instead of failing",
    run: Effect.gen(function* () {
      const expect = holds("a surface frozen elsewhere records a frozen partial completion instead of failing")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      yield* surface.publish(snapshot([node("a")]))
      yield* store.freeze(scope, SurfaceFrozen.make({ surfaceId: "page", messageId: "message-1", versionId: "message-1:v1", reason: "interaction" }))
      const late = yield* surface.publish(snapshot([node("b")]))
      yield* surface.publish(snapshot([node("c")]))
      const records = yield* store.hydrate(scope)
      yield* expect(late.frozen && !late.changed && Option.contains(late.version, "message-1:v1"), "the publish reports the frozen version")
      yield* expect(planned(records).length === 1, "no generation is planned after the freeze")
      yield* expect(records.filter((record) => isCompleted(record) && record.frozen && record.phase === "partial").length === 1, "one frozen, partial completion")
    }),
  },
  {
    name: "fill commits into a declared placeholder after freezing",
    run: Effect.gen(function* () {
      const expect = holds("fill commits into a declared placeholder after freezing")
      const { render } = yield* subject.make(allow)
      const surface = yield* render.open(scopeOf(), detached)
      yield* surface.publish(snapshot([node("a")], "complete", ["media"]))
      yield* surface.freeze("completion")
      const receipt = yield* surface.fill("media", node("media", "image"))
      const unknown = yield* failureOf("fill")(surface.fill("other", node("other", "image")))
      yield* expect(receipt.nodeId === "media", "the fill commits the placeholder node")
      yield* expect(unknown.code === "invalid", "an undeclared placeholder is rejected")
      yield* expect((yield* surface.state).components.includes("image"), "the filled component is part of the state")
    }),
  },
  {
    name: "preparations run one at a time and settled waits for them",
    run: Effect.gen(function* () {
      const expect = holds("preparations run one at a time and settled waits for them")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      const slowly = (snapshots: ReadonlyArray<RenderSnapshotInput>) => Stream.fromIterable(snapshots).pipe(Stream.tap(() => Effect.sleep("5 millis")))
      yield* surface.prepare(slowly([snapshot([node("first")]), snapshot([node("first"), node("second")])]), () => Effect.void)
      yield* surface.prepare(slowly([snapshot([node("third")], "complete")]), () => Effect.void)
      const during = yield* surface.state
      yield* surface.settled
      const after = yield* surface.state
      const order = planned(yield* store.hydrate(scope)).map((record) => record.nodes.join("+"))
      yield* expect(during.pending && !after.pending, "pending while preparing, not after settled")
      yield* expect(canonicalJson(order) === canonicalJson(["first", "first+second", "third"]), `preparations did not interleave, got ${canonicalJson(order)}`)
      yield* expect(after.completed && after.generation === 3, "the last preparation completed generation 3")
    }),
  },
  {
    name: "a failed preparation is recovered and settles",
    run: Effect.gen(function* () {
      const expect = holds("a failed preparation is recovered and settles")
      const { render } = yield* subject.make(allow)
      const surface = yield* render.open(scopeOf(), detached)
      const recovered = yield* Ref.make(false)
      yield* surface.prepare(Stream.fail("composer unavailable"), () => Ref.set(recovered, true))
      yield* surface.settled
      yield* expect(yield* Ref.get(recovered), "recover runs with the failure")
      yield* expect(!(yield* surface.state).pending, "nothing is pending afterwards")
    }),
  },
  {
    name: "reopening resumes the generation and deduplication",
    run: Effect.gen(function* () {
      const expect = holds("reopening resumes the generation and deduplication")
      const { render } = yield* subject.make(allow)
      const first = yield* render.open(scopeOf(), detached)
      yield* first.publish(snapshot([node("a")]))
      const again = yield* render.open(scopeOf(), detached)
      const state = yield* again.state
      const repeat = yield* again.publish(snapshot([node("a")]))
      yield* expect(state.generation === 1 && Option.contains(state.version, "message-1:v1"), "the reopened surface is at message-1:v1")
      yield* expect(!repeat.changed, "republishing the same content is deduplicated after reopening")
      yield* expect(again.records.length > 0, "the hydrated records are exposed")
    }),
  },
  {
    name: "a rejected component is never committed",
    run: Effect.gen(function* () {
      const expect = holds("a rejected component is never committed")
      const { render, store } = yield* subject.make({ validate: () => Effect.fail(new UiOutputError({ code: "forbidden", message: "Release revoked" })) })
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      const failure = yield* failureOf("rejected")(surface.publish(snapshot([node("a")])))
      yield* expect(failure.code === "forbidden", "admission failures keep their code")
      yield* expect(!(yield* store.hydrate(scope)).some(isCommitted), "nothing was committed")
    }),
  },
  {
    name: "the store commits idempotently and conflicts on different content",
    run: Effect.gen(function* () {
      const expect = holds("the store commits idempotently and conflicts on different content")
      const { store } = yield* subject.make(allow)
      const scope = scopeOf()
      const proposal = { operationId: "op-1", nodeId: "a", release: release("card"), props: { title: "a" }, evidence: ["a-fact"] }
      const first = yield* store.commit(scope, { versionId: "message-1:v1", proposal })
      const retry = yield* store.commit(scope, { versionId: "message-1:v1", proposal })
      const conflict = yield* failureOf("conflict")(store.commit(scope, { versionId: "message-1:v1", proposal: { ...proposal, props: { title: "b" } } }))
      yield* expect(canonicalJson(first) === canonicalJson(retry), "a retried commit returns the same receipt")
      yield* expect(conflict.code === "conflict", "a different proposal under the same operation id conflicts")
    }),
  },
  {
    name: "the store refuses to plan a frozen surface",
    run: Effect.gen(function* () {
      const expect = holds("the store refuses to plan a frozen surface")
      const { store } = yield* subject.make(allow)
      const scope = scopeOf()
      yield* store.freeze(scope, SurfaceFrozen.make({ surfaceId: "page", messageId: "message-1", versionId: "message-1:v1", reason: "interaction" }))
      const failure = yield* failureOf("frozen plan")(store.plan(scope, SurfacePlanned.make({
        surfaceId: "page", messageId: "message-1", versionId: "message-1:v2", generation: 2, baseVersionId: Option.none(),
        phase: "partial", spec: {}, nodes: [], placeholders: [], signature: "x",
      })))
      yield* expect(failure.code === "frozen", "planning a frozen surface fails with frozen")
      const other = yield* store.plan(scopeOf("message-2"), SurfacePlanned.make({
        surfaceId: "page", messageId: "message-2", versionId: "message-2:v1", generation: 1, baseVersionId: Option.none(),
        phase: "partial", spec: {}, nodes: [], placeholders: [], signature: "y",
      })).pipe(Effect.result)
      yield* expect(other._tag === "Success", "a freeze only binds its own message")
    }),
  },
]
