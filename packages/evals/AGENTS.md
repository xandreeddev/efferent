# @xandreed/evals

The evaluation domain: tasks, runnables, candidates, trials, transcripts, outcomes, graders, suites with gates, calibrations and reviews, the use cases that run and grade them in scoped trials, and dataset-level assessment (semantic judges, completeness, retrieval metrics, statistics). Apps bring their own execution, environments, projections, models and budgets. Node 24 (the declared engine; the tests run on Bun); layer `evals` in `foundry.config.ts` (imports `effect`, `effect/ai` and `@noble/hashes/` only: no agent runtime, provider client or other `@xandreed/*` package).

## Rules

- Keep labels away from the subject: `RunnableExecution.execute` gets the input, candidate and world only; references reach projectors and graders after execution.
- Use cases resolve services through `EvaluationServices` and build no Layers; Layers are built in `src/adapters/` (`EvaluationServicesLive`, `defineRunnable`).
- Every chosen id is an `EvalId` (one segment, no `/` or `@`); trial and event ids are `EvalPath`s (`run/suite/candidate/task/sample`); a grader key is `<id>@<version>`.
- Record a failure's reason with `reasonOf` (`code: message`, `interrupted`, or a defect's message), never a stack or a path: reports and exports are shared.
- An `EvaluationError` or `AssessmentError` that wraps a failure keeps it as `cause` and says what failed in `message` (a schema error's `message`, `reasonOf(Cause.die(error))` for a foreign one), never `String(error)`; `reasonOf` never reads the cause.
- A model call's `AiError` becomes `assessmentOfAiError(error)`: `unavailable` when the provider may answer on a retry (`isRetryable`), `provider` otherwise, its message led by the reason's tag.
- A missing measurement stays unavailable, never a zero, and never passes a gate; `isUnavailable(error)` tells one from an error.
- `gradingContext` never truncates: over budget is `unavailable`, and omissions are recorded by the app.
- An app from outside (a configuration module, a host's value) goes through `parseEvaluationApp`; the runner parses its app too. A new cross-reference check is a rule of `AppViolation`, its `path` leading from the app to the value.
- A `metadata` field (`Grade`, `EvaluationResult`, `SemanticResult`, `Assessment`) is a `Schema.JsonObject`: it is stored and exported as JSON.
- Order with an explicit `Order` (`Order.String`, code-unit order), never the locale: fingerprints and comparison lines must match on every machine.
- Persist each transcript event and the settled trial as they happen; a trial settles under `uninterruptibleMask`, so an interrupted one is stored as `cancelled`.
- A use case or port method that runs once per run, trial, grade or judge call is `Effect.fn("eval.<op>")`, one span per call: `eval.run`, `eval.trial`, `eval.regrade` (`gradeEvaluation`), `eval.grade` (`gradeTrial`), `eval.calibrate`, `eval.calibration.execute` and `.project`, `eval.pairwise`, `eval.retrieval.assess`, `eval.semantic.run`, the judges' `eval.semantic.llm` and `.jev`; `assess` keeps its `eval.evaluator` span. A pipeable sets the ids on the span and on the logs under it, under the same keys (`eval.run.id`, `eval.trial.id`, `eval.suite.id`, `eval.task.id`, `eval.candidate.id`, `eval.sample`). Validators and judge constructors are `Effect.fnUntraced`.
- Service keys are `efferent/evals/<Name>` (per app: `efferent/evals/<id>/RunnableExecution`, `…/EvaluationEnvironment`); never rename one.

## Public surface

- Domain schemas: `EvalId`, `EvalPath`, `Version`, `Fingerprints`, `EvaluationError` (a refused app's `violations`), `AppViolation`, `Task`, `GraderBinding`, `Journey`, `Runnable`, `Candidate`, `Transcript`, `TranscriptEvent`, `Outcome`, `GradingContext`, `ContextBudget`, `Grader`, `Grade`, `Trial`, `Suite`, `Gate`, `GateFinding`, `Calibration`, `EvaluationRun`, `ReviewBundle`, `ReviewItem`, `CalibrationObservation`, `CalibrationReference`, `EvidenceProjection`, `ExportReceipt`.
- App contract: `defineEvaluationApp`, `parseEvaluationApp` (an app from a value: its shape, then `evaluationAppViolations`; `validateEvaluationApp` is its deprecated alias), `evaluationAppViolations`, `defineRunnable`, `defineGraderCalibration`, `runnableExecutionPort`, `evaluationEnvironmentPort` (types `EvaluationApp`, `EvaluationSelection`, `GradingSelection`, `RunnableExecution`, `EvaluationEnvironment` and the registrations: `RunnableRegistration`, `EnvironmentRegistration`, `ProjectionRegistration`, `GraderRegistration`, `ExporterRegistration`). `EvaluationApp.observability` is a `Layer.Layer<never>` (a tracer) that the CLI provides around a command that loads the app; `parseEvaluationApp` keeps it, and the use cases never provide it.
- Use cases: `runEvaluation`, `gradeEvaluation`, `calibrateGrader`, `gradeTrial`, `executionFingerprint`, `runGates`, `comparisonIssues`, `reviewBundle`, `approveReviews`, `gradingContext`, `fingerprint` (also `evaluationFingerprint`), `tasksFromDataset`.
- Ports: `EvaluationServices`, `EvaluationRunStore`, `EvaluationExport`, `TrialExecution`, `TrialRecorder`, `EvidenceProjector`, `GraderAssessment`, `SemanticJudge`. A host composes `EvaluationServicesLive(app)` plus an `EvaluationRunStore` (evals-cli has the file one); `SemanticLlmLive` / `makeSemanticLlmJudge` (`SemanticLlmOptions`; needs a `LanguageModel`), `SemanticJevLive` / `makeSemanticJevJudge` (`SemanticJevOptions`); `isolatedServices`.
- Assessment: `assess`, `assessAll`, `semanticEvaluator`, `semanticResponseSchema`, `validateSemanticInput`, `validateSemanticAnswers`, `assessCompleteness`, `evaluationScores`, `projectEvaluatorInput`, `evaluatorRegistry`, `compareCalibrationMetric`, `summarizeCalibration`, `compareDecisionTrials`, `calibrationAgreement`, `selectionMetrics`, `assessmentOfAiError`, `reasonOf` (a cause as report text, for the CLI and exporters too), `validateDataset`, `validateMetrics`, `numericMetric`, `summarizeAssessments`, `unknownEvaluationUsage`, and their schemas and types: `Metric`, `EvaluationUsage`, `EvaluationResult`, `EvaluationSplit`, `LabelReview`, `AssessmentError`, `Evaluator`, `EvaluatorBinding`, `EvaluatorRegistration`, `Assessment`, `AssessmentInput`, `Dataset`, `DatasetCase`, `SemanticQuestion`, `SemanticQuestions`, `SemanticAnswer`, `SemanticAnswers`, `SemanticInput`, `SemanticResult`, `EvaluationScore`, `RequiredAction`, `ActionAssessment`, `ActionId`, `ActionToolReference`, `CompletenessEvidence`, `ToolInvocationId`, `TraceStepId`, `DecisionTrial`, `DecisionCaseId`, `SelectionObservation`.
- Retrieval: `rankingMetrics`, `contextualPrecision`, `contextualRecall`, `contextualRelevancy`, `semanticRetrievalGraders(judge, { rubric })` (a `RetrievalJudge` gets `retrievalItems`, the units it gives one verdict each, and its answer is decoded: its ids may be plain strings; `SemanticRetrievalOptions`), `retrievalItems`, and the schemas `RetrievalContext`, `RetrievalItem`, `RetrievalJudgement`, `RetrievalMeasure`, `RetrievalDocumentId`, `RetrievalItemId`. Statistics (also `@xandreed/evals/stats`): `wilsonInterval`, `percentile`, `mean`, `standardDeviation`. Flags: `argValue`, `hasFlag`, `csv`, `positiveInt`.

The root and `./stats` name each export, and `quality/exports-have-consumers` checks each one: another package, a script or a doc code block imports it, or its declaration is tagged `@public` (the names above that no first-party code imports).

## Model-facing text

The prompts are the app's (`SemanticLlmOptions.prompt`, the judge given to `semanticRetrievalGraders`, whose `rubric` names that prompt in the grader's fingerprint); the package writes no prose a model reads.

| Text | Source | Pinned by |
|---|---|---|
| The judge's structured-output name, `semantic_assessment` | `src/adapters/semantic-llm.adapter.ts:28` | unpinned |
| The judge's response schema: one property per question id, `probability` in 0..1, `score` within the scale, `choice` among the offered keys, nothing else | `src/semantic.entity.functions.ts:43-52` | structure, `src/semantic.test.ts:111`, `:119` |
| `llmEvaluator`'s object name, from its id (not exported) | `src/evaluators/llm.ts:17` | unpinned |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/domain/` | entities (`*.entity.ts`) and their pure rules (`*.entity.functions.ts`): identity, task, trial, grader, suite, run, review, calibration, grading context |
| `src/contracts/`, `src/ports/` | `EvaluationApp`, the registrations and `parseEvaluationApp`; the `Context.Service` ports and the per-app port factories |
| `src/usecases/run-evaluation.usecase.functions.ts` | running, grading and calibrating: scoped trials, recorder, grades, gates |
| `src/adapters/` | `EvaluationServicesLive`, `defineRunnable`, `defineGraderCalibration`, `isolatedServices`, the LLM and Jev semantic judges |
| `src/graders/retrieval/` | ranking metrics and the three judged retrieval graders |
| `src/*.ts`, `src/evaluators/` | dataset-level assessment (`assessment.*`, `semantic.*`, `completeness.*`, `decision-comparison.*`, `evaluation-score.*`, `evaluator-*`, `evaluators/semantic.ts`), `stats.ts`, `cli.functions.ts`; `evaluators/llm.ts` and `evaluators/pairwise.ts` are not exported |
| `src/testing/` | `fixture.testing.ts` (the fixture app and the `spanRecorder` tracer the exporter tests reuse) and the use-case tests; the build leaves the whole folder out |

## Tests

- `src/testing/`: `evaluation.test.ts` (runner, gates, reasons, app violations), `traces.test.ts` (the span tree and its ids), `scoped-layers.test.ts` (scopes, timeouts, late callbacks), `typed-ports.test.ts`, `grader-calibration.test.ts`; `src/semantic.test.ts`, `src/assessment.test.ts`, `src/evaluation-contract.test.ts`, `src/decision-comparison.test.ts`, `src/graders/retrieval/semantic-retrieval.test.ts`, `src/domain/identity.entity.functions.test.ts` (`reasonOf`), `src/stats.test.ts`; every judge is scripted, no keys.
- `bun run verify:packages` imports the packed package on Node and runs `scripts/evaluation-consumer.fixture.mjs` (a typed function suite through the packed CLI).
- Run: `bun test packages/evals/src`.

See the root AGENTS.md for the enforced rules and the definition of done.
