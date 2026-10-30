export { AppViolation, EvalId, EvalPath, EvaluationError, Fingerprints, Version } from "./domain/identity.entity.js"
export { reasonOf } from "./domain/identity.entity.functions.js"
export { GraderBinding, Task } from "./domain/task.entity.js"
export { Journey } from "./domain/journey.entity.js"
export { Runnable } from "./domain/runnable.entity.js"
export { Candidate } from "./domain/candidate.entity.js"
export { Transcript, TranscriptEvent } from "./domain/transcript.entity.js"
export { Outcome } from "./domain/outcome.entity.js"
export { ContextBudget, GradingContext } from "./domain/grading-context.entity.js"
export { Grade, Grader } from "./domain/grader.entity.js"
export { Trial } from "./domain/trial.entity.js"
export { Gate, Suite } from "./domain/suite.entity.js"
export { Calibration } from "./domain/calibration.entity.js"
export { EvaluationRun, GateFinding } from "./domain/evaluation-run.entity.js"
export { tasksFromDataset } from "./domain/task.entity.functions.js"
export { fingerprint, gradingContext } from "./domain/grading-context.entity.functions.js"
export { comparisonIssues, runGates } from "./domain/evaluation-run.entity.functions.js"
export {
  type EnvironmentRegistration,
  type EvaluationApp,
  type EvaluationSelection,
  type ExporterRegistration,
  type GraderRegistration,
  type GradingSelection,
  type ProjectionRegistration,
  type RunnableRegistration,
} from "./contracts/evaluation-app.contract.js"
export {
  defineEvaluationApp,
  evaluationAppViolations,
  parseEvaluationApp,
  validateEvaluationApp,
} from "./contracts/evaluation-app.contract.functions.js"
export { defineRunnable } from "./adapters/runnable.adapter.js"
export { defineGraderCalibration } from "./adapters/grader-calibration.adapter.js"
export { CalibrationObservation, CalibrationReference } from "./domain/grader-calibration.entity.js"
export { calibrationAgreement } from "./domain/grader-calibration.entity.functions.js"
export { EvaluationRunStore } from "./ports/evaluation-store.port.js"
export { EvaluationExport, ExportReceipt } from "./ports/evaluation-export.port.js"
export {
  calibrateGrader,
  executionFingerprint,
  gradeEvaluation,
  gradeTrial,
  runEvaluation,
} from "./usecases/run-evaluation.usecase.functions.js"
export {
  Metric,
  EvaluationUsage,
  AssessmentError
} from "./assessment.entity.js"
export {
  assess,
  assessAll,
  unknownEvaluationUsage
} from "./assessment.usecase.functions.js"
export type {
  Evaluator,
  EvaluatorBinding,
  Assessment,
  AssessmentInput,
  Dataset,
  DatasetCase
} from "./assessment.usecase.js"
export { mean, percentile, standardDeviation, wilsonInterval } from "./stats.js"
export { rankingMetrics } from "./graders/retrieval/ranking.functions.js"
export { contextualPrecision } from "./graders/retrieval/contextual-precision.functions.js"
export { contextualRecall } from "./graders/retrieval/contextual-recall.functions.js"
export { contextualRelevancy } from "./graders/retrieval/contextual-relevancy.functions.js"
export { ReviewBundle, ReviewItem } from "./domain/review.entity.js"
export { approveReviews, reviewBundle } from "./domain/review.entity.functions.js"
export {
  RetrievalContext,
  RetrievalDocumentId,
  RetrievalItem,
  RetrievalItemId,
  RetrievalJudgement,
  RetrievalMeasure,
} from "./graders/retrieval/semantic-retrieval.entity.js"
export { retrievalItems } from "./graders/retrieval/semantic-retrieval.entity.functions.js"
export {
  type RetrievalJudge,
  semanticRetrievalGraders,
  type SemanticRetrievalOptions,
} from "./graders/retrieval/semantic-grader.adapter.js"

export {
  EvaluationResult,
  EvaluationSplit,
  LabelReview
} from "./assessment.entity.js"
export {
  assessmentOfAiError,
  validateDataset,
  validateMetrics,
  numericMetric,
  summarizeAssessments
} from "./assessment.entity.functions.js"
export { fingerprint as evaluationFingerprint } from "./domain/grading-context.entity.functions.js"
export { isolatedServices } from "./adapters/isolated-services.adapter.js"
export { argValue, csv, hasFlag, positiveInt } from "./cli.functions.js"
export { compareCalibrationMetric, summarizeCalibration } from "./evaluator-calibration.entity.functions.js"
export { type EvaluatorRegistration } from "./evaluator-registry.usecase.js"
export { evaluatorRegistry, projectEvaluatorInput } from "./evaluator-registry.usecase.functions.js"
export {
  SemanticAnswer,
  SemanticAnswers,
  SemanticInput,
  SemanticQuestion,
  SemanticQuestions,
  SemanticResult,
} from "./semantic.entity.js"
export { semanticResponseSchema, validateSemanticAnswers, validateSemanticInput } from "./semantic.entity.functions.js"
export { SemanticJudge } from "./ports/semantic-judge.port.js"
export { semanticEvaluator } from "./evaluators/semantic.js"
export { makeSemanticLlmJudge, SemanticLlmLive, type SemanticLlmOptions } from "./adapters/semantic-llm.adapter.js"
export { makeSemanticJevJudge, SemanticJevLive, type SemanticJevOptions } from "./adapters/semantic-jev.adapter.js"
export { EvaluationScore } from "./evaluation-score.entity.js"
export { evaluationScores } from "./evaluation-score.entity.functions.js"
export {
  ActionAssessment,
  ActionId,
  ActionToolReference,
  CompletenessEvidence,
  RequiredAction,
  ToolInvocationId,
  TraceStepId,
} from "./completeness.entity.js"
export { assessCompleteness } from "./completeness.entity.functions.js"
export { DecisionCaseId, DecisionTrial, SelectionObservation } from "./decision-comparison.entity.js"
export { compareDecisionTrials, selectionMetrics } from "./decision-comparison.entity.functions.js"

export { EvidenceProjection } from "./domain/evidence-projection.entity.js"
export { type RunnableExecution, runnableExecutionPort } from "./ports/runnable-execution.port.js"
export { type EvaluationEnvironment, evaluationEnvironmentPort } from "./ports/evaluation-environment.port.js"
export { TrialExecution } from "./ports/trial-execution.port.js"
export { EvidenceProjector } from "./ports/evidence-projector.port.js"
export { GraderAssessment } from "./ports/grader-assessment.port.js"
export { TrialRecorder } from "./ports/trial-recorder.port.js"

export { EvaluationServices } from "./ports/evaluation-services.port.js"
export { EvaluationServicesLive } from "./adapters/evaluation-services.adapter.js"
