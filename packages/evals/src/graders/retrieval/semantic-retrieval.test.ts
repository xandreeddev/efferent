import { GraderAssessment } from "../../index.js"
import { expect, test } from "bun:test"
import { Effect, Schema, Ref } from "effect"
import {
  EvalId,
  gradingContext,
  RetrievalDocumentId,
  retrievalItems,
  semanticRetrievalGraders,
  RetrievalContext
} from "../../index.js"
import type { RetrievalItem } from "../../index.js"
import { spanRecorder } from "../../testing/fixture.testing.js"
const input: RetrievalContext = {
  query: "When does it start?",
  documents: [
    {
      id: RetrievalDocumentId.make("a"),
      text: "Starts at eight. Bring water.",
      statements: ["Starts at eight.", "Bring water."]
    },
    { id: RetrievalDocumentId.make("b"), text: "Starts at nine.", statements: ["Starts at nine."] }
  ],
  expectedClaims: ["Starts at eight."]
}
const context = () =>
  gradingContext({
    projection: "retrieval",
    version: "1",
    input,
    schema: RetrievalContext,
    budget: { maxBytes: 5000, reservedBytes: 100 },
    references: [],
    omissions: []
  })
const candidate = {
  id: EvalId.make("retriever"),
  configuration: {},
  fingerprints: {}
}
test("semantic retrieval validates statement coverage and keeps precision order", async () => {
  const graders = semanticRetrievalGraders((measure, projected) =>
    Effect.succeed({
      verdicts: (measure === "contextual-relevancy"
        ? ["a/statement:0", "a/statement:1", "b/statement:0"]
        : measure === "contextual-recall"
          ? ["claim:0"]
          : ["a", "b"]
      ).map((id, index) => ({ id, relevant: index === 0, reason: "fixture" }))
    })
  )
  const projected = await Effect.runPromise(context())
  const grades = await Effect.runPromise(
    Effect.forEach(graders, (grader) =>
      Effect.gen(function* () {
        const port = yield* GraderAssessment
        return yield* port.assess(projected, candidate)
      }).pipe(Effect.provide(grader.layer), Effect.scoped)
    )
  )
  expect(grades.map((grade) => grade.metrics[0]?.value)).toEqual([1, 1, 1 / 3])
})
test("each retrieval grade is one eval.retrieval.assess span naming its measure, the judge called under it", async () => {
  const { tracer, named, parentOf } = spanRecorder()
  const graders = semanticRetrievalGraders((measure) =>
    Effect.succeed({
      verdicts: retrievalItems(measure, input).map((item) => ({ id: item.id, relevant: true, reason: "fixture" }))
    }).pipe(Effect.withSpan("judge"))
  )
  const projected = await Effect.runPromise(context())
  await Effect.runPromise(
    Effect.forEach(graders, (grader) =>
      GraderAssessment.use((port) => port.assess(projected, candidate)).pipe(Effect.provide(grader.layer)),
      { concurrency: 1 }
    ).pipe(Effect.withTracer(tracer))
  )
  expect(named("eval.retrieval.assess").map((span) => span.attributes.get("eval.retrieval.measure")))
    .toEqual(["contextual-precision", "contextual-recall", "contextual-relevancy"])
  expect(named("judge").map(parentOf)).toEqual(["eval.retrieval.assess", "eval.retrieval.assess", "eval.retrieval.assess"])
})
test("a judge omitting verdicts is an error rather than a low score", async () => {
  const grader = semanticRetrievalGraders(() =>
    Effect.succeed({ verdicts: [] })
  )[0]!
  expect(
    await Effect.runPromise(
      context().pipe(
        Effect.flatMap((projected) =>
          Effect.gen(function* () {
            const port = yield* GraderAssessment
            return yield* port.assess(projected, candidate)
          }).pipe(Effect.provide(grader.layer), Effect.scoped)
        ),
        Effect.isFailure
      )
    )
  ).toBe(true)
})
test("empty evidence and ambiguous document identities abstain before spending on a judge", async () => {
  const called = await Effect.runPromise(Ref.make(0))
  const graders = semanticRetrievalGraders(() => Ref.update(called, (value) => value + 1).pipe(Effect.as({ verdicts: [] })))
  const missing = [
    { ...input, documents: [] },
    { ...input, expectedClaims: [] },
    { ...input, documents: input.documents.map((document) => ({ ...document, statements: [] })) },
    { ...input, documents: [input.documents[0]!, input.documents[0]!] },
  ]
  const targets = [graders[0]!, graders[1]!, graders[2]!, graders[0]!]
  await Effect.runPromise(Effect.forEach(missing, (value, index) => gradingContext({
    projection: "retrieval", version: "1", schema: RetrievalContext, input: value,
    budget: { maxBytes: 5000, reservedBytes: 100 }, references: [], omissions: [],
  }).pipe(Effect.flatMap((projected) => Effect.flatMap(GraderAssessment, (port) => port.assess(projected, candidate)).pipe(
    Effect.provide(targets[index]!.layer), Effect.result,
  )), Effect.tap((result) => Effect.sync(() => {
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("unavailable")
  })))))
  expect(await Effect.runPromise(Ref.get(called))).toBe(0)
})
test("relevancy hides answer labels and explicit negative verdicts measure zero", async () => {
  const grader = semanticRetrievalGraders((measure, value) => Effect.sync(() => {
    expect(measure).toBe("contextual-relevancy")
    expect(value.expectedClaims).toEqual([])
    return { verdicts: value.documents.flatMap((document) => document.statements.map((_, index) => ({
      id: `${document.id}/statement:${index}`, relevant: false, reason: "Unrelated statement",
    }))) }
  }))[2]!
  const assessed = await Effect.runPromise(context().pipe(Effect.flatMap((projected) =>
    Effect.flatMap(GraderAssessment, (port) => port.assess(projected, candidate)).pipe(Effect.provide(grader.layer)))))
  expect(assessed.status).toBe("scored")
  expect(assessed.metrics[0]?.value).toBe(0)
})
test("duplicate judge verdicts cannot substitute for a missing document", async () => {
  const grader = semanticRetrievalGraders(() => Effect.succeed({ verdicts: [
    { id: "a", relevant: true, reason: "First" }, { id: "a", relevant: true, reason: "Duplicate" },
  ] }))[0]!
  const result = await Effect.runPromise(context().pipe(Effect.flatMap((projected) =>
    Effect.flatMap(GraderAssessment, (port) => port.assess(projected, candidate)).pipe(Effect.provide(grader.layer))), Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("invalid")
})
test("the judge is given the ids its verdicts must carry, with their text, and can answer from them alone", async () => {
  const seen: Array<readonly [string, ReadonlyArray<RetrievalItem>]> = []
  const graders = semanticRetrievalGraders((measure, _projected, items) => Effect.sync(() => {
    seen.push([measure, items])
    return { verdicts: items.map((item, index) => ({ id: item.id, relevant: index === 0, reason: item.text })) }
  }))
  const projected = await Effect.runPromise(context())
  const grades = await Effect.runPromise(Effect.forEach(graders, (grader) =>
    Effect.flatMap(GraderAssessment, (port) => port.assess(projected, candidate)).pipe(Effect.provide(grader.layer))))
  expect(grades.map((grade) => grade.metrics[0]?.value)).toEqual([1, 1, 1 / 3])
  expect<unknown>(seen).toEqual([
    ["contextual-precision", [{ id: "a", text: "Starts at eight. Bring water." }, { id: "b", text: "Starts at nine." }]],
    ["contextual-recall", [{ id: "claim:0", text: "Starts at eight." }]],
    ["contextual-relevancy", [{ id: "a/statement:0", text: "Starts at eight." }, { id: "a/statement:1", text: "Bring water." }, { id: "b/statement:0", text: "Starts at nine." }]],
  ])
  expect<unknown>(retrievalItems("contextual-recall", input)).toEqual([{ id: "claim:0", text: "Starts at eight." }])
})
test("the rubric fingerprint follows the rubric the judge works from", () => {
  const judge = () => Effect.succeed({ verdicts: [] })
  const rubricOf = (options?: Parameters<typeof semanticRetrievalGraders>[1]) =>
    semanticRetrievalGraders(judge, options).map((grader) => grader.definition.fingerprints["rubric"])
  const first = rubricOf({ rubric: { "contextual-precision": "Is the passage useful? v1", "contextual-recall": "Is the claim supported? v1" } })
  const second = rubricOf({ rubric: { "contextual-precision": "Is the passage useful? v2", "contextual-recall": "Is the claim supported? v1" } })
  expect(first[0]).not.toBe(second[0])
  expect(first[1]).toBe(second[1])
  expect(first[0]).not.toBe(first[1])
  expect(first[0]?.startsWith("retrieval-contextual-precision:1:")).toBe(true)
  expect(rubricOf({ rubric: { "contextual-precision": "Is the passage useful? v1" } })[0]).toBe(first[0])
  expect(rubricOf()).toEqual(["retrieval-contextual-precision:1", "retrieval-contextual-recall:1", "retrieval-contextual-relevancy:1"])
  expect(first[2]).toBe("retrieval-contextual-relevancy:1")
})
