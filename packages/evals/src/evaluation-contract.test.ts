import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { assessCompleteness } from "./completeness.entity.functions.js"
import { ActionId, ToolInvocationId, TraceStepId } from "./completeness.entity.js"
import { projectEvaluatorInput } from "./assessment.usecase.functions.js"
import type { Evaluator } from "./assessment.usecase.js"

const tool = { name: "read", invocationId: ToolInvocationId.make("call-1"), stepId: TraceStepId.make("step-1") }
const evidence = { required: ["a", "b", "c", "d"].map((id) => ({ id: ActionId.make(id), description: id })), tools: [tool], evidenceRefs: ["answer"] }
const actions = ["matched", "matched", "partial", "missing"].map((status, index) => ({ actionId: ActionId.make(["a", "b", "c", "d"][index]!), status: status as "matched" | "partial" | "missing", tools: index < 3 ? [tool] : [], evidenceRefs: ["answer"], reason: "Observed answer" }))

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
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, actions.map((action) => ({ ...action, tools: [{ ...tool, invocationId: ToolInvocationId.make("invented") }] })))))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness(evidence, actions.map((action) => ({ ...action, reason: "" })))))).toBe(true)
    expect(await Effect.runPromise(Effect.isFailure(assessCompleteness({ ...evidence, required: [] }, [])))).toBe(true)
  })
  it("projects only the declared evaluator input", async () => {
    const evaluator: Evaluator<{ answer: string }> = { id: "help", version: "1", metrics: ["help"], run: (input) => Effect.succeed({ metrics: [{ kind: "boolean", name: "help", value: Object.keys(input).join() === "answer" }], reason: input.answer }) }
    const projected = projectEvaluatorInput(evaluator, (input: { answer: string; secret: string }) => Effect.succeed({ answer: input.answer }))
    expect((await Effect.runPromise(projected.run({ answer: "ok", secret: "hidden" }))).metrics[0]?.value).toBe(true)
  })
})
