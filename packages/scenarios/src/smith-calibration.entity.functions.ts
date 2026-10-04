import { Effect, Option, Schema } from "effect"
import type { Layer, Scope } from "effect"
import { SessionLogEvent } from "@xandreed/core"
import { defineCalibration, evaluationFingerprint, evaluatorRegistry } from "@xandreed/evals"
import type { AssessmentError, AssessmentInput, Dataset, Evaluator } from "@xandreed/evals"
import { SMITH_CONTROLLER_PROMPT_VERSION, SMITH_EDITOR_PROMPT_VERSION, SMITH_EDIT_SCHEMA_VERSION } from "@xandreed/smith"
import { SmithCodingTask, smithCodingCases, SMITH_CODING_DATASET_VERSION } from "./smith-coding-cases.entity.js"
import { SmithCodingEvidence } from "./smith-coding-trial.entity.js"
import { SmithInteractionCase, SmithInteractionEvidence, smithInteractionCases } from "./smith-interaction.entity.js"
import { SmithCalibrationCandidate, SmithCodingReference, SmithInteractionReference, smithScriptedCandidate, smithInteractionCandidate } from "./smith-calibration.entity.js"
import type { SmithCalibrationRuntime } from "./smith-calibration-runtime.port.js"

export const smithCodingDataset: Dataset<SmithCodingTask, SmithCodingReference> = {
  id: "smith-coding", version: SMITH_CODING_DATASET_VERSION, input: SmithCodingTask, reference: SmithCodingReference,
  cases: smithCodingCases.map((entry, index) => ({ id: entry.id, family: entry.id, split: index < 2 ? "calibration" : "validation", review: "known", provenance: `Effect4 executable fixture ${entry.id}@${SMITH_CODING_DATASET_VERSION}; fixed mechanical split, not unseen model-quality evidence`, input: { id: entry.id, task: entry.task, seed: entry.seed, paths: Object.keys(entry.solution) }, reference: { completed: true, editorRequired: true, requiredChecks: ["tests", "effect-check", "immutable-fixture", "requested-paths", "production-verification"] } })),
}
export const smithInteractionDataset: Dataset<SmithInteractionCase, SmithInteractionReference> = {
  id: "smith-interaction", version: "1", input: SmithInteractionCase, reference: SmithInteractionReference,
  cases: smithInteractionCases.map((entry) => ({ id: entry.id, family: entry.id === "read-recovery" ? "recovery" : "greeting", split: entry.id === "read-recovery" ? "validation" : "calibration", review: "known", provenance: `Native conversation contract ${entry.id}@1; fixed mechanical split, not unseen model-quality evidence`, input: entry, reference: { completed: true, modelRequests: entry.id === "read-recovery" ? 3 : 1, toolCalls: entry.id === "read-recovery" ? 2 : 0, recovery: entry.id === "read-recovery" } })),
}

type CodingAssessment = AssessmentInput<SmithCodingTask, SmithCodingEvidence, SmithCodingEvidence, SmithCodingReference>
type InteractionAssessment = AssessmentInput<SmithInteractionCase, SmithInteractionEvidence, SmithInteractionEvidence, SmithInteractionReference>
const eventsDecode = Schema.decodeUnknownOption(Schema.Array(SessionLogEvent))
const planned = (events: ReadonlyArray<unknown>, requests: ReadonlyArray<unknown>) => requests.filter((request) => JSON.stringify(request).includes('"protocol":"evaluation-model-v4"')).length === 1 && events.some((event) => JSON.stringify(event).includes('"kind":"smith.planning"') && JSON.stringify(event).includes('"outcome":"selected"'))
const metric = (name: string, value: boolean) => ({ kind: "boolean" as const, name, value })
export const smithCodingEvaluator: Evaluator<CodingAssessment> = {
  id: "smith.coding.contract", version: "1", metrics: ["acceptance", "native-replay", "planning", "role-usage"],
  run: ({ output, reference }) => Effect.succeed({ reason: "Executable acceptance, actual verification, durable replay and production transports", metrics: [
    metric("acceptance", output.outcome === "completed" && reference.completed && output.error === null && output.checks.every((check) => check.pass) && reference.requiredChecks.every((name) => output.checks.some((check) => check.name === name && check.pass))),
    metric("native-replay", output.outerGraphFingerprint.length === 64 && Option.isSome(eventsDecode(output.parentEvents)) && Option.isSome(eventsDecode(output.editorEvents)) && JSON.stringify(output.parentEvents).includes('"kind":"smith.proposal"') && (!reference.editorRequired || JSON.stringify(output.editorEvents).includes('"kind":"memory.message"'))),
    metric("planning", planned(output.parentEvents, output.transportRequests)),
    metric("role-usage", Object.values(output.roleUsage.controller).some((usage) => usage.totalTokens > 0) && Object.values(output.roleUsage.editor).some((usage) => usage.totalTokens > 0) && output.resolvedConfig !== null),
  ] }),
}
export const smithInteractionEvaluator: Evaluator<InteractionAssessment> = {
  id: "smith.interaction.contract", version: "1", metrics: ["conversation", "native-recovery", "planning"],
  run: ({ output, reference }) => Effect.succeed({ reason: "Native bounded conversation, failure repair and exact production dispatch counts", metrics: [
    metric("conversation", reference.completed && output.outcome === "completed" && output.error === null && output.immutableWorkspace && output.checks.every((check) => check.pass)),
    metric("native-recovery", Option.isSome(eventsDecode(output.parentEvents)) && output.outerGraphFingerprint.length === 64 && output.requests.filter((request) => JSON.stringify(request).includes('"protocol":"chat-completions"')).length === reference.modelRequests && output.parentEvents.filter((event) => JSON.stringify(event).includes('"kind":"tool.completed"')).length === reference.toolCalls && (!reference.recovery || output.parentEvents.some((event) => JSON.stringify(event).includes('"kind":"tool.completed"') && JSON.stringify(event).includes('"ok":false')))),
    metric("planning", planned(output.parentEvents, output.requests)),
  ] }),
}

/** Resolve the actual versioned evaluator through the host registry on assessment. */
const registered = <I>(evaluator: Evaluator<I>): Evaluator<I> => ({ ...evaluator, run: (input) => evaluatorRegistry([{ id: evaluator.id, version: evaluator.version, projectionVersion: "1", promptHash: evaluationFingerprint({ id: evaluator.id, version: evaluator.version, metrics: evaluator.metrics }), settings: { deterministic: true }, evaluator }]).pipe(Effect.flatMap((registry) => registry.resolve(evaluator.id, evaluator.version)), Effect.flatMap((entry) => entry.evaluator.run(input))) })
const gates = <I>(evaluator: Evaluator<I>) => evaluator.metrics.map((name) => ({ evaluator: evaluator.id, metric: name, aggregate: "passRate" as const, minimum: 1, mode: "blocking" as const, requiresReviewedReference: true }))
type SmithSubject<I, E> = {
  readonly task: (input: I) => Effect.Effect<{ readonly output: E; readonly evidence: E }, AssessmentError, SmithCalibrationRuntime | Scope.Scope>
  readonly services: (candidate: SmithCalibrationCandidate) => Layer.Layer<SmithCalibrationRuntime>
}
export const makeSmithCodingCalibration = (subject: SmithSubject<SmithCodingTask, SmithCodingEvidence>, candidates: ReadonlyArray<SmithCalibrationCandidate> = [smithScriptedCandidate]) => defineCalibration({
  id: "smith-coding", version: "1", dataset: smithCodingDataset, candidate: SmithCalibrationCandidate, candidates,
  subject: {
    ...subject,
    fingerprints: { controllerPrompt: SMITH_CONTROLLER_PROMPT_VERSION, editorPrompt: SMITH_EDITOR_PROMPT_VERSION, editSchema: SMITH_EDIT_SCHEMA_VERSION, planningPrompt: "1", effect: "4.0.0-rc.118", providerProtocol: "native-production-adapters", evaluationProtocol: "4" },
  },
  output: SmithCodingEvidence, evidence: SmithCodingEvidence, evaluators: [{ evaluator: registered(smithCodingEvaluator), select: smithCodingEvaluator.metrics }], gates: gates(smithCodingEvaluator),
  select: () => [], run: { repetitions: 1, concurrency: 1, timeoutMs: 420_000 },
})
export const makeSmithInteractionCalibration = (subject: SmithSubject<SmithInteractionCase, SmithInteractionEvidence>) => defineCalibration({
  id: "smith-interaction", version: "1", dataset: smithInteractionDataset, candidate: SmithCalibrationCandidate, candidates: [smithInteractionCandidate],
  subject: {
    ...subject,
    fingerprints: { controllerPrompt: SMITH_CONTROLLER_PROMPT_VERSION, planningPrompt: "1", providerProtocol: "chat-completions-thinking", evaluationProtocol: "4" },
  },
  output: SmithInteractionEvidence, evidence: SmithInteractionEvidence, evaluators: [{ evaluator: registered(smithInteractionEvaluator), select: smithInteractionEvaluator.metrics }], gates: gates(smithInteractionEvaluator),
  select: () => [], run: { repetitions: 1, concurrency: 1, timeoutMs: 30_000 },
})
