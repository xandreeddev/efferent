import { describe, expect, it } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { assessCompleteness } from "./completeness.entity.functions.js"
import { evaluationScores } from "./evaluation-score.entity.functions.js"
import { projectEvaluatorInput, evaluatorRegistry, promptFamilyBenchmark } from "./evaluator-registry.usecase.functions.js"
import { selectJourneys } from "./journey-selection.entity.functions.js"
import { scoreJourneyTurn } from "./journey.entity.functions.js"
import type { Journey, JourneyExpectation } from "./journey.entity.js"
import type { Evaluator } from "./assessment.usecase.js"

const expected: JourneyExpectation = { requiredTools: ["read"], forbiddenTools: ["write"], recipes: ["lookup"], components: [], outcome: "answered", requiredText: [], forbiddenText: [], maxAgentSteps: 3 }
const journey: Journey = { id: "read", tier: 0, tierReason: "critical", persona: { id: "guest", category: "anonymous", authenticated: false }, expectedLocale: "en", description: "read", fixture: "v1", turns: [{ action: { type: "message", text: "read" }, expected }] }
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
  it("selects declared coverage with AND between selector kinds", async () => {
    expect(await Effect.runPromise(selectJourneys([journey], { tiers: [0], tools: ["write"], recipes: ["lookup"], ids: [] }))).toHaveLength(1)
    expect(await Effect.runPromise(Effect.isFailure(selectJourneys([journey], { tiers: [1], tools: [], recipes: [], ids: [] })))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(selectJourneys([journey], { tiers: [], tools: ["unknown"], recipes: [], ids: [] })))).toBe(true)
  })
  it("fails missing step measurements and wrong arguments", () => {
    const observed = { text: "ok", locale: "en", tools: ["read"], recipes: ["lookup"], components: [], outcome: "answered", evidence: ["file"], costUsd: 0, latencyMs: 1 }
    expect(scoreJourneyTurn(expected, observed, "en").passed).toBe(false)
    expect(scoreJourneyTurn(expected, { ...observed, agentSteps: 3 }, "en").passed).toBe(true)
    expect(scoreJourneyTurn({ ...expected, requiredToolArguments: [{ name: "read", arguments: { id: "a" } }] }, { ...observed, agentSteps: 1, toolCalls: [{ name: "read", arguments: { id: "b" } }] }, "en").passed).toBe(false)
  })
  it("exposes comments without manufacturing unavailable scores", () => {
    const result = { version: 2 as const, evaluator: "x", evaluatorVersion: "1", status: "scored" as const, metrics: [{ kind: "boolean" as const, name: "x", value: true, comment: "specific" }], reason: Option.some("shared"), references: [], startedAt: 0, endedAt: 1, usage: { inputTokens: Option.none<number>(), outputTokens: Option.none<number>(), costUsd: Option.none<number>() }, metadata: {} }
    expect(evaluationScores(result)).toEqual([{ key: "x", score: true, comment: "specific" }])
    expect(evaluationScores({ ...result, status: "unavailable" })).toEqual([])
  })
  it("runs the subject without giving it reference labels", async () => {
    const benchmark = promptFamilyBenchmark({ id: "one", version: "1", output: Schema.String, dataset: { id: "d", version: "1", input: Schema.String, reference: Schema.String, cases: [] }, evaluate: (input: string) => Effect.succeed(input), comparator: [] })
    expect(await Effect.runPromise(Effect.scoped(benchmark.task("input only")))).toEqual({ output: "input only", evidence: "input only" })
  })
})
