import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { UiOutput, UiOutputAdmission, UiOutputContext, UiOutputJournal } from "./ports/ui-output.port.js"
import { UiOutputError } from "./domain/ui-output.entity.js"
import { UiOutputLive } from "./ui-output.adapter.js"

const scope = { threadId: "thread", runId: "run", messageId: "answer", principalId: "guest", fence: 1 }
const proposal = { operationId: "op", nodeId: "map", release: { component: "map", version: "1", definitionHash: "a".repeat(64), rendererRelease: "1", tokensHash: "b".repeat(64), layoutVersion: "1" }, props: { factId: "course" }, evidence: ["course"] }
const receipt = { threadId: "thread", messageId: "answer", revisionId: "revision", sequence: 3, nodeId: "map" }
const provide = (validate: ContextService["validate"], commit: JournalService["commit"]) => UiOutputLive().pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(UiOutputContext, scope), Layer.succeed(UiOutputAdmission, { validate }), Layer.succeed(UiOutputJournal, { commit }),
)))
type ContextService = typeof UiOutputAdmission.Service
type JournalService = typeof UiOutputJournal.Service

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
    Effect.provide(provide(() => Effect.fail(new UiOutputError({ code: "unavailable", message: "Release revoked" })), () => Effect.sync(() => { writes.push(proposal); return receipt }))), Effect.either,
  ))
  expect(result._tag).toBe("Left")
  expect(writes).toEqual([])
})

test("interruption during admission prevents a component commit", async () => {
  const writes: unknown[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork((yield* UiOutput).emit(proposal))
    yield* Effect.yieldNow()
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(provide(() => Effect.never, () => Effect.sync(() => { writes.push(proposal); return receipt })))))
  expect(writes).toEqual([])
})

test("storage failure cannot produce a successful tool receipt", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* UiOutput).emit(proposal) }).pipe(
    Effect.provide(provide(() => Effect.void, () => Effect.fail(new UiOutputError({ code: "storage", message: "Unavailable" })))), Effect.either,
  ))
  expect(result._tag).toBe("Left")
})
