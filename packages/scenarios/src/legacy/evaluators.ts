import { Effect } from "effect"
import { AssessmentError } from "@xandreed/evals"
import type { Evaluator } from "@xandreed/evals"
import type { Check, Judge } from "./model.js"

export const checkEvaluator = <W>(check: Check<W>, version = "legacy-v1"): Evaluator<W> => ({
  id: check.name, version, metrics: ["passed"],
  run: (world) => check.run(world).pipe(Effect.map((value) => ({ metrics: [{ kind: "boolean", name: "passed", value: value.pass }], reason: value.detail ?? check.name }))),
})
export const judgeEvaluator = <W>(judge: Judge<W>, version = "legacy-v1"): Evaluator<W> => ({
  id: judge.name, version, metrics: ["score"],
  run: (world) => judge.run(world).pipe(
    Effect.map((value) => ({ metrics: [{ kind: "score" as const, name: "score", value: value.score, min: 0, max: 1 }], reason: value.reason })),
    Effect.mapError((error) => new AssessmentError({ code: "provider", message: String(error) })),
  ),
})
