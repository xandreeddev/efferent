import { describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { assessCompleteness } from "./completeness.entity.functions.js"
import { evaluationScores } from "./evaluation-score.entity.functions.js"
import { projectEvaluatorInput, evaluatorRegistry } from "./evaluator-registry.usecase.functions.js"
import type { Evaluator } from "./assessment.usecase.js"

const tool = { name: "read", invocationId: "call-1", stepId: "step-1" }
const evidence = { required: ["a", "b", "c", "d"].map((id) => ({ id, description: id })), tools: [tool], evidenceRefs: ["answer"] }
const actions = ["matched", "matched", "partial", "missing"].map((status, index) => ({ actionId: ["a", "b", "c", "d"][index]!, status: status as "matched" | "partial" | "missing", tools: index < 3 ? [tool] : [], evidenceRefs: ["answer"], reason: "Observed answer" }))

describe("evaluation contracts", () => {
  it("calculates completeness and lists every action", async () => {
    const result = await Effect.runPromise(assessCompleteness(evidence, actions))
    expect(result.metrics[0]?.value).toBe(0.625)
    expect(result.reason.split("\n")).toHaveLength(4)
    expect(result.reason).toContain("read [call-1, step-1]")
    expect(result.reason).toContain("d: missing; tools: none")
  })
  it("rejects missing, duplicate and invented attribution", async () => {
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, actions.slice(1))))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, [actions[0]!, actions[0]!, ...actions.slice(2)])))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, actions.map((action) => ({ ...action, tools: [{ ...tool, invocationId: "invented" }] })))))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, actions.map((action) => ({ ...action, reason: "" })))))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness({ ...evidence, required: [] }, [])))).toBe(true)
  })
  it("projects only the declared evaluator input", async () => {
    const evaluator: Evaluator<{ answer: string }> = { id: "help", version: "1", metrics: ["help"], run: (input) => Effect.succeed({ metrics: [{ kind: "boolean", name: "help", value: Object.keys(input).join() === "answer" }], reason: input.answer }) }
    const projected = projectEvaluatorInput(evaluator, (input: { answer: string; secret: string }) => Effect.succeed({ answer: input.answer }))
    expect((await Effect.runPromise(projected.run({ answer: "ok", secret: "hidden" }))).metrics[0]?.value).toBe(true)
    const entry = { id: "help", version: "1", projectionVersion: "1", promptHash: "hash", settings: {}, evaluator }
    const registry = await Effect.runPromise(evaluatorRegistry([entry]))
    expect((await Effect.runPromise(registry.resolve("help", "1"))).evaluator).toBe(evaluator)
    expect(await Effect.runPromise(Effect.isFailure(evaluatorRegistry([entry, entry])))).toBe(true)
  })
  it("exposes comments without manufacturing unavailable scores", () => {
    const result = { version: 2 as const, evaluator: "x", evaluatorVersion: "1", status: "scored" as const, metrics: [{ kind: "boolean" as const, name: "x", value: true, comment: "specific" }], reason: Option.some("shared"), references: [], startedAt: 0, endedAt: 1, usage: { inputTokens: Option.none<number>(), outputTokens: Option.none<number>(), costUsd: Option.none<number>() }, metadata: {} }
    expect(evaluationScores(result)).toEqual([{ key: "x", score: true, comment: "specific" }])
    expect(evaluationScores({ ...result, status: "unavailable" })).toEqual([])
  })
})
