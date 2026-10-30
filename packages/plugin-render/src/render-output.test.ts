import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Stream, Tracer } from "effect"
import { RunId } from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import { UiOutput, UiOutputAdmission, UiOutputContext, UiOutputJournal } from "./ports/render-output.port.js"
import { NodeId, OperationId, PrincipalId, RenderMessageId, RevisionId, ThreadId, UiOutputError } from "./domain/render-output.entity.js"
import { UiOutputHandlersLive, UiOutputLive } from "./render-output.adapter.js"
import { RenderComponent, uiOutputToolkit } from "./render-output.tools.js"

const scope = { threadId: ThreadId.make("thread"), runId: RunId.make("run"), messageId: RenderMessageId.make("answer"), principalId: PrincipalId.make("guest"), fence: 1 }
const proposal = { operationId: OperationId.make("op"), nodeId: NodeId.make("map"), release: { component: "map", version: "1", definitionHash: "a".repeat(64), rendererRelease: "1", tokensHash: "b".repeat(64), layoutVersion: "1" }, props: { factId: "course" }, evidence: ["course"] }
const receipt = { threadId: scope.threadId, messageId: scope.messageId, revisionId: RevisionId.make("revision"), sequence: 3, nodeId: proposal.nodeId }
const provide = (validate: ContextService["validate"], commit: JournalService["commit"], maxBytes?: number) => UiOutputLive(maxBytes).pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(UiOutputContext, scope), Layer.succeed(UiOutputAdmission, { validate }), Layer.succeed(UiOutputJournal, { commit }),
)))
type ContextService = typeof UiOutputAdmission.Service
type JournalService = typeof UiOutputJournal.Service

/** `render_component` called as a model calls it, through the toolkit: whether each result is a failure, and the result the model reads. */
const called = (validate: ContextService["validate"], commit: JournalService["commit"], maxBytes?: number) => Effect.runPromise(Effect.gen(function* () {
  const kit = yield* uiOutputToolkit
  const results = yield* Stream.runCollect(yield* kit.handle("render_component", proposal))
  return results.map((result) => [result.isFailure, result.encodedResult])
}).pipe(Effect.provide(UiOutputHandlersLive), Effect.provide(provide(validate, commit, maxBytes))))

/** A trimmed, non-empty string, as its JSON Schema says it. */
const trimmed = { type: "string", pattern: "^\\S[\\s\\S]*\\S$|^\\S$|^$", minLength: 1 }

test("render_component's description and parameters, as the model reads them", () => {
  expect(RenderComponent.description).toBe("Publish one complete, evidence-backed component using an exact approved release. Returns its durable canvas revision and chat anchor. Use only catalog props and evidence IDs returned by domain tools. Never emit code, HTML or guessed facts. Reuse operationId only to retry the identical call. Plain answers need no component.")
  expect(toolParametersSchema(RenderComponent)).toEqual({
    type: "object",
    properties: {
      operationId: trimmed,
      nodeId: trimmed,
      release: {
        type: "object",
        properties: {
          component: trimmed, version: trimmed, definitionHash: { type: "string" }, rendererRelease: trimmed, tokensHash: { type: "string" }, layoutVersion: trimmed,
        },
        required: ["component", "version", "definitionHash", "rendererRelease", "tokensHash", "layoutVersion"],
        additionalProperties: false,
      },
      props: { type: "object" },
      evidence: { type: "array", items: trimmed },
    },
    required: ["operationId", "nodeId", "release", "props", "evidence"],
    additionalProperties: false,
  })
})

test("a refusal reaches the model as { error: code, message }: the host's admission and journal messages, and the size limit", async () => {
  const refused = (code: "unavailable" | "storage", message: string) => Effect.fail(new UiOutputError({ code, message }))
  expect(await called(() => refused("unavailable", "Release revoked"), () => Effect.succeed(receipt))).toEqual([[true, { error: "unavailable", message: "Release revoked" }]])
  expect(await called(() => Effect.void, () => refused("storage", "Unavailable"))).toEqual([[true, { error: "storage", message: "Unavailable" }]])
  expect(await called(() => Effect.void, () => Effect.succeed(receipt), 64)).toEqual([[true, { error: "invalid", message: "Component exceeds the configured size limit" }]])
})

test("emit refuses a proposal that does not decode as invalid", async () => {
  const refused = await Effect.runPromise(Effect.gen(function* () {
    return yield* Effect.flip((yield* UiOutput).emit({ ...proposal, script: "alert(1)" } as typeof proposal))
  }).pipe(Effect.provide(provide(() => Effect.void, () => Effect.succeed(receipt)))))
  expect([refused.code, refused.message]).toEqual(["invalid", "Invalid component proposal"])
})

test("render output cannot be observed before admission and durable commit", async () => {
  const calls: string[] = []
  const value = await Effect.runPromise(Effect.gen(function* () {
    return yield* (yield* UiOutput).emit(proposal)
  }).pipe(Effect.provide(provide(
    (actualScope, actualProposal) => Effect.sync(() => { expect(actualScope).toEqual(scope); expect(actualProposal.release).toEqual(proposal.release); calls.push("admitted") }),
    () => Effect.sync(() => { calls.push("persisted"); return receipt }),
  ))))
  expect(value).toEqual(receipt)
  expect(calls).toEqual(["admitted", "persisted"])
})

test("failed exact-release admission never persists a substitute", async () => {
  const writes: unknown[] = []
  const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* UiOutput).emit(proposal) }).pipe(
    Effect.provide(provide(() => Effect.fail(new UiOutputError({ code: "unavailable", message: "Release revoked" })), () => Effect.sync(() => { writes.push(proposal); return receipt }))), Effect.result,
  ))
  expect(result._tag).toBe("Failure")
  expect(writes).toEqual([])
})

test("interruption during admission prevents a component commit", async () => {
  const writes: unknown[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild((yield* UiOutput).emit(proposal))
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(provide(() => Effect.never, () => Effect.sync(() => { writes.push(proposal); return receipt })))))
  expect(writes).toEqual([])
})

test("storage failure cannot produce a successful tool receipt", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* UiOutput).emit(proposal) }).pipe(
    Effect.provide(provide(() => Effect.void, () => Effect.fail(new UiOutputError({ code: "storage", message: "Unavailable" })))), Effect.result,
  ))
  expect(result._tag).toBe("Failure")
})

test("each emit is one render.emit span, ended with the refusal", async () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  await Effect.runPromise(Effect.gen(function* () {
    const output = yield* UiOutput
    yield* output.emit(proposal)
    yield* Effect.result(output.emit({ ...proposal, operationId: OperationId.make("refused") }))
  }).pipe(Effect.provide(provide(
    (_, actual) => actual.operationId === "refused" ? Effect.fail(new UiOutputError({ code: "unavailable", message: "Release revoked" })) : Effect.void,
    () => Effect.succeed(receipt),
  )), Effect.withTracer(tracer)))
  expect(spans.map((span) => span.name)).toEqual(["render.emit", "render.emit"])
  expect(spans.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))).toEqual([false, true])
})
