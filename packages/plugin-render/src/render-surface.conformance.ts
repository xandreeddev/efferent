import { Effect, Option, Ref, Schema, Stream } from "effect"
import { canonicalJson, RunId } from "@xandreed/core"
import { ConformanceFailure } from "@xandreed/core/conformance"
import { NodeId, OperationId, PrincipalId, RenderMessageId, ThreadId, UiOutputError } from "./domain/render-output.entity.js"
import type { UiOutputProposal } from "./domain/render-output.entity.js"
import { SurfaceCommitted, SurfaceCompleted, SurfaceFrozen, SurfaceId, SurfacePlanned, VersionId } from "./domain/render-surface.entity.js"
import type { RenderError, RenderNode, RenderSnapshotInput, SurfaceRecord, SurfaceScope } from "./domain/render-surface.entity.js"
import type { UiOutputAdmission } from "./ports/render-output.port.js"
import type { Render, RenderOpenOptions, RenderStore } from "./ports/render.port.js"

/** @public */
export interface ConformanceCheck {
  readonly name: string
  readonly run: Effect.Effect<void, ConformanceFailure | RenderError>
}

/**
 * A fresh surface implementation and its store for each check, built over the given admission.
 *
 * @public
 */
export interface SurfaceSubject {
  readonly make: (admission: typeof UiOutputAdmission.Service) => Effect.Effect<{
    readonly render: typeof Render.Service
    readonly store: typeof RenderStore.Service
  }, RenderError>
}

const release = (component: string) => ({
  component, version: "1", definitionHash: "a".repeat(64), rendererRelease: "1", tokensHash: "b".repeat(64), layoutVersion: "1",
})
const node = (nodeId: string, component = "card"): RenderNode => ({ nodeId: NodeId.make(nodeId), release: release(component), props: { title: nodeId }, evidence: [`${nodeId}-fact`] })
const snapshot = (nodes: ReadonlyArray<RenderNode>, phase: "partial" | "complete" = "partial", placeholders: ReadonlyArray<string> = []): RenderSnapshotInput => ({
  phase, spec: { layout: "stack", order: nodes.map((entry) => entry.nodeId) }, nodes, placeholders,
})
/** The run id follows the message only: two threads or surfaces of one message share it, as unrelated hosts' runs may. */
const scopeOf = (messageId = "message-1", threadId = "thread", surfaceId = "page"): SurfaceScope => ({
  threadId: ThreadId.make(threadId), runId: RunId.make(`run-${messageId}`), messageId: RenderMessageId.make(messageId), principalId: PrincipalId.make("guest"),
  fence: 1, surfaceId: SurfaceId.make(surfaceId), baseVersion: Option.none(),
})
const version = (versionId: string) => VersionId.make(versionId)
/** The plan of a generation as a writer that is up to date makes it (`<messageId>:v<generation>`), for the store checks. */
const plannedAt = (generation: number, messageId = "message-1", surfaceId = "page") => SurfacePlanned.make({
  surfaceId: SurfaceId.make(surfaceId), messageId: RenderMessageId.make(messageId), versionId: version(`${messageId}:v${generation}`), generation,
  baseVersionId: Option.none(), phase: "partial", spec: {}, nodes: [], placeholders: [], signature: `${messageId}-${generation}`,
})
const frozenAt = (versionId: Option.Option<string>, messageId = "message-1") => SurfaceFrozen.make({
  surfaceId: SurfaceId.make("page"), messageId: RenderMessageId.make(messageId), versionId: Option.map(versionId, version), reason: "interaction",
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
const isFrozen = Schema.is(SurfaceFrozen)
const planned = (records: ReadonlyArray<SurfaceRecord>) => records.filter(isPlanned)
const committedIn = (records: ReadonlyArray<SurfaceRecord>, versionId: string): ReadonlyArray<string> =>
  records.flatMap((record) => isCommitted(record) && record.versionId === versionId ? [record.nodeId] : [])

/** Admission that refuses node `b` once, as a restarting dependency would, and admits it afterwards. */
const refusingBOnce = Effect.gen(function* () {
  const refused = yield* Ref.make(false)
  const admission: typeof UiOutputAdmission.Service = {
    validate: (_scope, proposal) => proposal.nodeId !== "b" ? Effect.void : Ref.getAndSet(refused, true).pipe(Effect.flatMap((before) => before
      ? Effect.void
      : Effect.fail(new UiOutputError({ code: "unavailable", message: "Admission is restarting" })))),
  }
  return admission
})

/**
 * The contract every Render/RenderStore pair must keep, run against any implementation.
 *
 * @public
 */
export const renderSurfaceConformance = (subject: SurfaceSubject): ReadonlyArray<ConformanceCheck> => [
  {
    name: "identical content opens no new generation",
    run: Effect.gen(function* () {
      const expect = holds("identical content opens no new generation")
      const { render } = yield* subject.make(allow)
      const surface = yield* render.open(scopeOf(), detached)
      const first = yield* surface.publish(snapshot([node("a")]))
      const second = yield* surface.publish(snapshot([node("a")]))
      yield* expect(first.changed && Option.contains(first.version, version("message-1:v1")), "the first publish opens message-1:v1")
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
      yield* expect(Option.contains(second.version, version("message-1:v2")) && second.generation === 2, "the changed content opens message-1:v2")
      const ids = yield* Ref.get(operations)
      yield* expect(canonicalJson(ids) === canonicalJson(["run-message-1:render:page:1:a", "run-message-1:render:page:2:a", "run-message-1:render:page:2:b"]),
        `operation ids are per surface, generation and node, got ${canonicalJson(ids)}`)
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
      yield* store.freeze(scope, frozenAt(Option.some("message-1:v1")))
      const late = yield* surface.publish(snapshot([node("b")]))
      yield* surface.publish(snapshot([node("c")]))
      const records = yield* store.hydrate(scope)
      yield* expect(late.frozen && !late.changed && Option.contains(late.version, version("message-1:v1")), "the publish reports the frozen version")
      yield* expect(planned(records).length === 1, "no generation is planned after the freeze")
      yield* expect(records.filter((record) => isCompleted(record) && record.frozen && record.phase === "partial").length === 1, "one frozen, partial completion")
    }),
  },
  {
    name: "a freeze before the first publish holds",
    run: Effect.gen(function* () {
      const expect = holds("a freeze before the first publish holds")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      yield* surface.freeze("interaction")
      const late = yield* surface.publish(snapshot([node("a")]))
      const reopened = yield* render.open(scope, detached)
      const again = yield* reopened.publish(snapshot([node("b")]))
      const records = yield* store.hydrate(scope)
      yield* expect(late.frozen && !late.changed && Option.isNone(late.version), "the publish reports a frozen surface with no version")
      yield* expect(again.frozen && (yield* reopened.state).frozen, "a reopened surface is frozen too")
      yield* expect(planned(records).length === 0 && !records.some(isCommitted), "nothing is planned or committed")
      yield* expect(records.some((record) => isFrozen(record) && Option.isNone(record.versionId)), "the freeze is recorded without a version")
    }),
  },
  {
    name: "a frozen republish of a completed version records no partial completion",
    run: Effect.gen(function* () {
      const expect = holds("a frozen republish of a completed version records no partial completion")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      yield* surface.publish(snapshot([node("a")], "complete"))
      yield* surface.freeze("completion")
      const again = yield* surface.publish(snapshot([node("a")], "complete"))
      const completions = (yield* store.hydrate(scope)).filter(isCompleted)
      yield* expect(again.frozen && !again.changed, "the republish reports the frozen surface")
      yield* expect(completions.length === 1 && completions.every((record) => record.phase === "complete" && !record.frozen),
        `one, complete completion, got ${canonicalJson(completions)}`)
    }),
  },
  {
    name: "two surfaces of one message keep their own operation ids and freezes",
    run: Effect.gen(function* () {
      const expect = holds("two surfaces of one message keep their own operation ids and freezes")
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const { render } = yield* subject.make({ validate: (_scope, proposal: UiOutputProposal) => Ref.update(operations, (all) => [...all, proposal.operationId]) })
      const page = yield* render.open(scopeOf("message-1", "thread", "page"), detached)
      const panel = yield* render.open(scopeOf("message-1", "thread", "panel"), detached)
      yield* page.publish(snapshot([node("a")]))
      yield* panel.publish(snapshot([node("a", "chart")]))
      yield* page.freeze("interaction")
      const unfrozen = yield* panel.publish(snapshot([node("a", "chart")]))
      yield* panel.freeze("interaction")
      const pageAgain = yield* (yield* render.open(scopeOf("message-1", "thread", "page"), detached)).state
      const panelAgain = yield* (yield* render.open(scopeOf("message-1", "thread", "panel"), detached)).state
      const ids = yield* Ref.get(operations)
      yield* expect(canonicalJson(ids) === canonicalJson(["run-message-1:render:page:1:a", "run-message-1:render:panel:1:a"]),
        `each surface has its own operation ids, got ${canonicalJson(ids)}`)
      yield* expect(!unfrozen.frozen, "freezing one surface leaves the other open")
      yield* expect(pageAgain.frozen && panelAgain.frozen, "each surface's freeze is recorded")
      yield* expect(canonicalJson(panelAgain.components) === canonicalJson(["chart"]), `the panel keeps its own component, got ${canonicalJson(panelAgain.components)}`)
    }),
  },
  {
    name: "two threads with the same surface and message see only their own records",
    run: Effect.gen(function* () {
      const expect = holds("two threads with the same surface and message see only their own records")
      const { render, store } = yield* subject.make(allow)
      const mine = scopeOf("answer", "thread-a")
      const theirs = scopeOf("answer", "thread-b")
      const first = yield* render.open(mine, detached)
      yield* first.publish(snapshot([node("a")], "complete"))
      yield* first.freeze("completion")
      const before = canonicalJson(yield* store.hydrate(mine))
      const second = yield* render.open(theirs, detached)
      const fresh = yield* second.state
      const published = yield* second.publish(snapshot([node("a")], "complete"))
      const receipts = (yield* store.hydrate(theirs)).flatMap((record) => isCommitted(record) ? [record.receipt.threadId] : [])
      yield* expect(second.records.length === 0 && fresh.generation === 0 && !fresh.frozen, "another thread's records are not hydrated")
      yield* expect(published.changed && !published.frozen && Option.contains(published.version, version("answer:v1")), "the second thread opens its own answer:v1")
      yield* expect(canonicalJson(receipts) === canonicalJson(["thread-b"]), `the second thread's commit is its own, got ${canonicalJson(receipts)}`)
      yield* expect(canonicalJson(yield* store.hydrate(mine)) === before, "the first thread's records are unchanged")
    }),
  },
  {
    name: "a publish retried after a failed commit commits the missing nodes, then completes",
    run: Effect.gen(function* () {
      const expect = holds("a publish retried after a failed commit commits the missing nodes, then completes")
      const { render, store } = yield* subject.make(yield* refusingBOnce)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      const content = snapshot([node("a"), node("b", "chart")], "complete")
      const failure = yield* failureOf("retry")(surface.publish(content))
      const retry = yield* surface.publish(content)
      const records = yield* store.hydrate(scope)
      const state = yield* surface.state
      yield* expect(failure.code === "unavailable", "the first attempt fails on b")
      yield* expect(retry.changed && Option.contains(retry.version, version("message-1:v1")), "the retry commits into message-1:v1")
      yield* expect(canonicalJson(committedIn(records, "message-1:v1")) === canonicalJson(["a", "b"]),
        `every node is committed, got ${canonicalJson(committedIn(records, "message-1:v1"))}`)
      yield* expect(planned(records).length === 1 && records.filter(isCompleted).length === 1, "one generation, completed once")
      yield* expect(state.completed && canonicalJson(state.components) === canonicalJson(["card", "chart"]), "the state reports both components, completed")
    }),
  },
  {
    name: "a publish retried after reopening commits the missing nodes, then completes",
    run: Effect.gen(function* () {
      const expect = holds("a publish retried after reopening commits the missing nodes, then completes")
      const { render, store } = yield* subject.make(yield* refusingBOnce)
      const scope = scopeOf()
      const content = snapshot([node("a"), node("b", "chart")], "complete")
      yield* failureOf("retry after reopening")((yield* render.open(scope, detached)).publish(content))
      const reopened = yield* render.open(scope, detached)
      const retry = yield* reopened.publish(content)
      const records = yield* store.hydrate(scope)
      yield* expect(retry.changed && retry.generation === 1, "the retry commits into generation 1")
      yield* expect(canonicalJson(committedIn(records, "message-1:v1")) === canonicalJson(["a", "b"]),
        `every node is committed, got ${canonicalJson(committedIn(records, "message-1:v1"))}`)
      yield* expect((yield* reopened.state).completed && records.filter(isCompleted).length === 1, "the version completes once")
    }),
  },
  {
    name: "a placeholder filled again in a later version commits into that version",
    run: Effect.gen(function* () {
      const expect = holds("a placeholder filled again in a later version commits into that version")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const surface = yield* render.open(scope, detached)
      yield* surface.publish(snapshot([node("a")], "partial", ["media"]))
      yield* surface.fill("media", node("media", "image"))
      yield* surface.publish(snapshot([node("a"), node("b")], "partial", ["media"]))
      const receipt = yield* surface.fill("media", node("media", "video"))
      const records = yield* store.hydrate(scope)
      yield* expect(receipt.nodeId === "media" && committedIn(records, "message-1:v2").includes("media"), "the second fill is committed into message-1:v2")
      yield* expect((yield* surface.state).components.includes("video"), "the version shows the new fill")
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
      yield* expect(state.generation === 1 && Option.contains(state.version, version("message-1:v1")), "the reopened surface is at message-1:v1")
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
      const proposal = { ...node("a"), operationId: OperationId.make("op-1") }
      const first = yield* store.commit(scope, { versionId: version("message-1:v1"), proposal })
      const retry = yield* store.commit(scope, { versionId: version("message-1:v1"), proposal })
      const conflict = yield* failureOf("conflict")(store.commit(scope, { versionId: version("message-1:v1"), proposal: { ...proposal, props: { title: "b" } } }))
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
      yield* store.freeze(scope, frozenAt(Option.none()))
      const failure = yield* failureOf("frozen plan")(store.plan(scope, plannedAt(1)))
      yield* expect(failure.code === "frozen", "planning a frozen surface fails with frozen")
      const other = yield* store.plan(scopeOf("message-2"), plannedAt(1, "message-2")).pipe(Effect.result)
      yield* expect(other._tag === "Success", "a freeze only binds its own message")
    }),
  },
  {
    name: "two writers of one message never plan the same version",
    run: Effect.gen(function* () {
      const expect = holds("two writers of one message never plan the same version")
      const { render, store } = yield* subject.make(allow)
      const scope = scopeOf()
      const retried = { ...scope, runId: RunId.make("run-message-1-retry") }
      const first = yield* render.open(scope, detached)
      const second = yield* render.open(retried, detached)
      const third = yield* render.open(retried, detached)
      yield* first.publish(snapshot([node("a")]))
      const other = yield* second.publish(snapshot([node("b")]))
      const same = yield* third.publish(snapshot([node("b")]))
      const versions = planned(yield* store.hydrate(scope)).map((record) => record.versionId)
      yield* expect(other.changed && Option.contains(other.version, version("message-1:v2")), "a writer opened before the first publish plans message-1:v2")
      yield* expect(!same.changed && Option.contains(same.version, version("message-1:v2")), "a writer with the same content resumes message-1:v2")
      yield* expect(canonicalJson(versions) === canonicalJson(["message-1:v1", "message-1:v2"]), `each version is planned once, got ${canonicalJson(versions)}`)
      yield* expect((yield* third.state).generation === 2, "the writer's state follows the store")
    }),
  },
  {
    name: "a lower fence is forbidden on all four writes",
    run: Effect.gen(function* () {
      const expect = holds("a lower fence is forbidden on all four writes")
      const { render, store } = yield* subject.make(allow)
      const stale = scopeOf()
      const current = { ...stale, runId: RunId.make("run-message-1-next"), fence: 2 }
      yield* (yield* render.open(current, detached)).publish(snapshot([node("a")]))
      const before = canonicalJson(yield* store.hydrate(current))
      const refusals = yield* Effect.forEach([
        store.plan(stale, plannedAt(2)),
        store.commit(stale, { versionId: version("message-1:v1"), proposal: { ...node("b"), operationId: OperationId.make("op-stale") } }),
        store.complete(stale, SurfaceCompleted.make({
          surfaceId: stale.surfaceId, messageId: stale.messageId, versionId: version("message-1:v1"), generation: 1, phase: "complete", frozen: false,
        })),
        store.freeze(stale, frozenAt(Option.some("message-1:v1"))),
      ], (write) => failureOf("lower fence")(write), { concurrency: 1 })
      const published = yield* failureOf("lower fence publish")((yield* render.open(stale, detached)).publish(snapshot([node("b")])))
      const after = canonicalJson(yield* store.hydrate(current))
      const elsewhere = yield* Effect.forEach([
        store.plan(scopeOf("message-2"), plannedAt(1, "message-2")),
        store.plan(scopeOf("message-1", "thread", "panel"), plannedAt(1, "message-1", "panel")),
      ], (write) => Effect.result(write), { concurrency: 1 })
      const codes = refusals.map((error) => error.code)
      yield* expect(canonicalJson(codes) === canonicalJson(["forbidden", "forbidden", "forbidden", "forbidden"]),
        `plan, commit, complete and freeze are forbidden, got ${canonicalJson(codes)}`)
      yield* expect(published.code === "forbidden", `a surface under the lower fence fails its publish, got ${published.code}`)
      yield* expect(after === before, "nothing is stored under the lower fence")
      yield* expect(elsewhere.every((result) => result._tag === "Success"), "a fence binds only its own surface and message")
    }),
  },
  {
    name: "the store refuses a plan that skips or repeats a generation",
    run: Effect.gen(function* () {
      const expect = holds("the store refuses a plan that skips or repeats a generation")
      const { store } = yield* subject.make(allow)
      const scope = scopeOf()
      const skippedFirst = yield* failureOf("skipped generation")(store.plan(scope, plannedAt(2)))
      yield* store.plan(scope, plannedAt(1))
      const repeated = yield* failureOf("repeated generation")(store.plan(scope, plannedAt(1)))
      const skipped = yield* failureOf("skipped generation")(store.plan(scope, plannedAt(3)))
      yield* store.plan(scope, plannedAt(2))
      const generations = planned(yield* store.hydrate(scope)).map((record) => record.generation)
      const elsewhere = yield* Effect.forEach([
        store.plan(scopeOf("message-2"), plannedAt(1, "message-2")),
        store.plan(scopeOf("message-1", "thread", "panel"), plannedAt(1, "message-1", "panel")),
        store.plan(scopeOf("message-1", "thread-b"), plannedAt(1)),
      ], (write) => Effect.result(write), { concurrency: 1 })
      const codes = [skippedFirst, repeated, skipped].map((error) => error.code)
      yield* expect(canonicalJson(codes) === canonicalJson(["conflict", "conflict", "conflict"]),
        `a skipped or repeated generation conflicts, got ${canonicalJson(codes)}`)
      yield* expect(canonicalJson(generations) === canonicalJson([1, 2]), `generations 1 and 2 are planned once each, got ${canonicalJson(generations)}`)
      yield* expect(elsewhere.every((result) => result._tag === "Success"), "generations count per surface, message and thread")
    }),
  },
]
