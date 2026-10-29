import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { RenderSnapshot, SurfaceFrozen, SurfacePlanned, SurfaceRecord } from "./domain/render-surface.entity.js"
import { fillOperationIdOf, operationIdOf, signatureOf } from "./domain/render-surface.entity.functions.js"
import { UiOutputAdmission } from "./ports/render-output.port.js"
import { Render, RenderStore } from "./ports/render.port.js"
import { renderSurfacePlugin } from "./plugin.adapter.js"
import { RenderLive } from "./render-surface.adapter.js"
import { makeMemoryRenderStore } from "./render-store.memory.adapter.js"
import { renderSurfaceConformance } from "./render-surface.conformance.js"

const subject = {
  make: (admission: typeof UiOutputAdmission.Service) => makeMemoryRenderStore.pipe(Effect.flatMap(({ store }) =>
    Effect.map(Render, (render) => ({ render, store })).pipe(
      Effect.provide(RenderLive().pipe(Layer.provide(Layer.mergeAll(Layer.succeed(RenderStore, store), Layer.succeed(UiOutputAdmission, admission))))),
    ))),
}

renderSurfaceConformance(subject).forEach((check) => {
  test(`surface conformance: ${check.name}`, async () => {
    await Effect.runPromise(check.run)
  })
})

const scope = { threadId: "thread", runId: "run", messageId: "answer", principalId: "guest", fence: 1, surfaceId: "page", baseVersion: Option.none<string>() }
const release = { component: "card", version: "1", definitionHash: "a".repeat(64), rendererRelease: "1", tokensHash: "b".repeat(64), layoutVersion: "1" }

test("a failed preparation is annotated with its message", async () => {
  const annotations = await Effect.runPromise(Effect.gen(function* () {
    const memory = yield* makeMemoryRenderStore
    const render = yield* Render.pipe(Effect.provide(RenderLive().pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(RenderStore, memory.store), Layer.succeed(UiOutputAdmission, { validate: () => Effect.void }),
    )))))
    const surface = yield* render.open(scope, { fork: (_tag, work) => Effect.forkDetach(work).pipe(Effect.asVoid) })
    yield* surface.prepare(Stream.fail(new Error("composer unavailable")), () => Effect.void)
    yield* surface.settled
    return yield* memory.annotations
  }))
  expect(annotations).toEqual([{ surfaceId: "page", kind: "render.preparation-failed", data: { message: "composer unavailable" } }])
})

test("the host fork receives every preparation with the surface tag", async () => {
  const tags = await Effect.runPromise(Effect.gen(function* () {
    const memory = yield* makeMemoryRenderStore
    const render = yield* Render.pipe(Effect.provide(RenderLive().pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(RenderStore, memory.store), Layer.succeed(UiOutputAdmission, { validate: () => Effect.void }),
    )))))
    const seen: Array<string> = []
    const surface = yield* render.open(scope, { fork: (tag, work) => Effect.sync(() => seen.push(tag)).pipe(Effect.andThen(Effect.forkDetach(work)), Effect.asVoid) })
    const snapshot = { phase: "complete" as const, spec: { layout: "single" }, nodes: [{ nodeId: "a", release, props: {}, evidence: ["a"] }] }
    yield* surface.prepare(Stream.make(snapshot), () => Effect.void)
    yield* surface.settled
    return seen
  }))
  expect(tags).toEqual(["render:page"])
})

test("an oversized component is rejected before admission and storage", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const memory = yield* makeMemoryRenderStore
    const render = yield* Render.pipe(Effect.provide(RenderLive(1024).pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(RenderStore, memory.store), Layer.succeed(UiOutputAdmission, { validate: () => Effect.die("admission must not run") }),
    )))))
    const surface = yield* render.open(scope, { fork: (_tag, work) => Effect.forkDetach(work).pipe(Effect.asVoid) })
    const big = { phase: "partial" as const, spec: {}, nodes: [{ nodeId: "a", release, props: { text: "x".repeat(4096) }, evidence: ["a"] }] }
    return yield* surface.publish(big).pipe(Effect.flip)
  }))
  expect(result.code).toBe("invalid")
})

test("a freeze stored before versions were optional still reads, and one with no version encodes as null", () => {
  const identity = { surfaceId: "page", messageId: "answer", reason: "interaction" } as const
  const stored = { _tag: "SurfaceFrozen", ...identity, versionId: "answer:v1" }
  expect(Schema.decodeUnknownSync(SurfaceRecord)(stored)).toEqual(SurfaceFrozen.make({ ...identity, versionId: Option.some("answer:v1") }))
  expect(Schema.encodeSync(SurfaceFrozen)(SurfaceFrozen.make({ ...identity, versionId: Option.none() })).versionId).toBeNull()
})

test("operation ids name the surface and generation, and a colon inside a part cannot make two ids meet", () => {
  expect(operationIdOf("run", "page", 2, "a")).toBe("run:render:page:2:a")
  expect(fillOperationIdOf("run", "page", 2, "media")).toBe("run:render:page:2:fill:media")
  expect(operationIdOf("run", "a:1", 2, "x")).not.toBe(operationIdOf("run", "a", 1, "2:x"))
  expect(operationIdOf("run", "page", 2, "fill:media")).not.toBe(fillOperationIdOf("run", "page", 2, "media"))
})

test("a version partly committed under an earlier operation id format completes with only its missing node", async () => {
  const content = { phase: "complete" as const, spec: { layout: "stack" }, nodes: [
    { nodeId: "a", release, props: {}, evidence: ["a"] }, { nodeId: "b", release, props: {}, evidence: ["b"] },
  ] }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const memory = yield* makeMemoryRenderStore
    const admitted = yield* Ref.make<ReadonlyArray<string>>([])
    yield* memory.store.plan(scope, SurfacePlanned.make({
      surfaceId: "page", messageId: "answer", versionId: "answer:v1", generation: 1, baseVersionId: Option.none(), phase: "complete",
      spec: content.spec, nodes: ["a", "b"], placeholders: [], signature: signatureOf(Schema.decodeSync(RenderSnapshot)(content)),
    }))
    yield* memory.store.commit(scope, { versionId: "answer:v1", proposal: { operationId: "run:render:1:a", nodeId: "a", release, props: {}, evidence: ["a"] } })
    const render = yield* Render.pipe(Effect.provide(RenderLive().pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(RenderStore, memory.store),
      Layer.succeed(UiOutputAdmission, { validate: (_scope, proposal) => Ref.update(admitted, (all) => [...all, proposal.operationId]) }),
    )))))
    const surface = yield* render.open(scope, { fork: (_tag, work) => Effect.forkDetach(work).pipe(Effect.asVoid) })
    const published = yield* surface.publish(content)
    return { published, admitted: yield* Ref.get(admitted), state: yield* surface.state }
  }))
  expect(result.admitted).toEqual(["run:render:page:1:b"])
  expect([result.published.changed, result.published.generation, result.state.completed]).toEqual([true, 1, true])
})

test("the surface plugin declares a runtime-scoped Render over a store and admission", () => {
  expect(renderSurfacePlugin.scope).toBe("runtime")
  expect(renderSurfacePlugin.requires).toEqual([RenderStore.key, UiOutputAdmission.key])
  expect(renderSurfacePlugin.provides).toEqual([Render.key])
})
