import { expect, test } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
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

test("the surface plugin declares a runtime-scoped Render over a store and admission", () => {
  expect(renderSurfacePlugin.scope).toBe("runtime")
  expect(renderSurfacePlugin.requires).toEqual([RenderStore.key, UiOutputAdmission.key])
  expect(renderSurfacePlugin.provides).toEqual([Render.key])
})
