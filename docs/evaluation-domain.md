# Evaluation domain and adapters

The evaluation packages run typed functions, retrievers and agents without depending on an agent runtime or an observability provider. Applications own their schemas, execution adapters, environment lifecycle, evidence projections, model selection and budgets. Local reports are the source of truth.

The task, trial, grader, transcript, outcome and suite vocabulary follows [Anthropic's evaluation definitions](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). A runnable is the versioned execution target bound to a task. A calibration evaluates a grader's agreement with labels; comparing application prompts or models is an ordinary suite.

## Package boundaries

```text
packages/
  evals/src/
    domain/          # Schema entities and pure rules
    contracts/       # typed execution and application registration
    ports/           # durable storage and export services
    usecases/        # scoped execution, grading, calibration
    graders/retrieval/
  evals-cli/src/
    adapters/        # atomic filesystem storage
    cli.adapter.ts   # commands and local report operations
    config-loader.adapter.ts
    main.ts          # Node entrypoint
  evals-langfuse/src/ # official SDK export adapter
  evals-langsmith/src/# official SDK export adapter
```

The core has no agent SDK, Docker, browser, database or provider client dependency. The CLI and exporters are Node 24 packages. An app can use the core runner without the CLI or register its own exporter without changing the domain.

## Entities and their relationships

| Entity | What it records |
| --- | --- |
| Task | Input, separate reference, dataset/version/split/review, grader bindings and provenance |
| Candidate | Configuration and fingerprints of the subject under test |
| Runnable | Identity and version of an execution target |
| Journey | Fixture and ordered actions; action codecs belong to the app |
| Trial | One task/candidate/sample attempt, timestamps, status, output, full evidence, transcript, outcome and grades |
| Transcript | Ordered durable events, including intermediate tool work and failures |
| Outcome | State observed through the environment after execution |
| Grader | Versioned code, model or human grading definition and declared metrics |
| GradingContext | Schema-encoded app projection, references, omissions, UTF-8 size and fingerprint |
| Grade | Score or an explicit unavailable/error/pending/skipped result, plus its exact context and usage |
| Suite | Tasks, candidates, repetitions, concurrency, deadlines, purpose and gates |
| Calibration | Grader being evaluated and the suite measuring its agreement |
| EvaluationRun | Trial evidence, gate findings, failures and run provenance |
| ReviewBundle | Explicit labelled approvals bound to fingerprints of captured evidence |

Inputs and references travel on different paths. `RunnableExecution.execute` receives the task input, candidate and environment; it reads the trial-scoped `TrialRecorder` port. It never receives the reference or task declaration. The app projection receives the captured trial and reference afterwards. This prevents the harness from leaking labels; an app must also keep them out of its fixtures and closures.

## Eval ports and app layers

The eval package defines `RunnableExecution<I,O,E,W>` and `EvaluationEnvironment<I,W>`
contracts. Each application specializes them as concrete `Context.Service` ports, implemented
with Layers. Input, output, evidence and live world types are explicit. Factory helpers
`runnableExecutionPort` and `evaluationEnvironmentPort` create typed services for generic
suite declarations; apps may declare named service classes directly.

`defineRunnable` binds the specific execution Layer to its compatible environment Layers and
input/output/evidence schemas. TypeScript rejects mismatched input or world types. Each
runnable registration owns its allowed named environments. The binding implements
`TrialExecution`, the portable runtime port: its input and captured results use `Schema.Json`,
the recursive JSON value union. The adapter decodes input before opening the environment,
then encodes output and evidence with their declared schemas and normalizes portable JSON
using the persistence serialization rules. Absent diagnostic fields are omitted; serialized
model requests remain exact strings. No live world or environment cast
crosses into the shared harness. A task input can be a discriminated union, such as separate
information-search and image-search requests.

`EvaluationServicesLive(app)` selects a bound registration and builds fresh services within
the trial scope. Use cases request these through `EvaluationServices` and call the resolved
ports; they construct no Layers. Every trial has independent resources and a recorder.
Grading constructs only `EvidenceProjector` and `GraderAssessment`, so it acquires no
execution/environment services. Optional exporters implement `EvaluationExport`.

The CLI provides the resolver and local store. Programmatic consumers provide both
`EvaluationServicesLive(app)` and an `EvaluationRunStore` implementation to `runEvaluation`
or `gradeEvaluation`.

## Typed runnable boundary

`defineGraderCalibration` builds a native calibration around an existing `GraderRegistration`.
The app supplies a concrete input codec, controlled cases and `CalibrationReference` labels.
The registered grader runs as the subject and captures `CalibrationObservation` plus its exact
grading context. A separate agreement projection/grade checks status and metrics, including
expected unavailable results, false passes and false failures. Labels never enter the subject.
Regrading saved observations makes no subject calls; testing a revised target grader requires
executing the controlled calibration again. Candidate fingerprints include the target grader.

Native validation rejects duplicate grader scopes, gates without task bindings, and families
split across development and validation. Gate coverage requires exactly one scored metric per
bound scope; duplicate grades cannot substitute for a missing scope.

```ts
const TextRunnable = runnableExecutionPort<
  string, string, { readonly length: number }, { readonly prefix: string }
>("text-function")
const TextEnvironment = evaluationEnvironmentPort<
  string, { readonly prefix: string }
>("text-function")

const registration = defineRunnable({
  definition: { id: EvalId.make("text-function"), version: "1", description: "Text function", fingerprints: {} },
  input: Schema.String,
  output: Schema.String,
  evidence: Schema.Struct({ length: Schema.Number }),
  runnable: TextRunnable,
  environment: TextEnvironment,
  layer: Layer.succeed(TextRunnable, {
    execute: (input, candidate, world) => Effect.succeed({
      output: world.prefix + input, evidence: { length: input.length }
    })
  }),
  environments: [{ id: "memory", layer: Layer.succeed(TextEnvironment, {
    open: () => Effect.succeed({ prefix: "hello " }),
    inspect: (world) => Effect.succeed({ state: world, references: [] })
  }) }]
})
```

`EvaluationEnvironment.open` acquires a fresh scoped world. `inspect` observes its resulting state. Acquire resources with `Effect.acquireRelease`; the scope closes after success, failure or timeout. A function evaluation may use a small in-process world; a stateful agent may inspect database records or filesystem changes. Docker is one possible app-owned environment.

`TrialRecorder.record` persists each transcript event during execution. If a target fails, the earlier events remain. The runner persists the terminal execution before grading and each completed grade independently. A grading failure does not erase the target's evidence.

A grader declares all possible metric names in `metrics`. Its optional `optionalMetrics` is a unique subset of those names; absence means an empty subset. Only those metrics may be omitted when inapplicable. Required omissions, unknown names, duplicates and invalid numeric ranges fail validation. Omitted metrics stay absent: a gate or primary comparison that requires one remains unmeasured. Native grading and target-grader calibration use the same validation before accepting a scored observation, and saved calibration observations are checked against the same required/optional contract during agreement grading. Changing applicability changes grader fingerprints and requires fresh comparison specifications.

## Evidence projection

Each grader binding chooses versioned `EvidenceProjection` metadata and a scope. The app implements the `EvidenceProjector` port; its `project(trial, task, scope)` returns a `GradingContext`. The app selects facts, conversation turns, tool results or outcome fields relevant to that criterion. Avoid sending every model request and every tool schema to a judge.

`gradingContext` encodes the selected schema, measures UTF-8 JSON bytes, adds the reserved rubric/response allowance and rejects over-budget required context as unavailable. It never truncates automatically. The app records optional omissions explicitly and keeps full evidence in the trial. The fingerprint covers the projection identity/version, input and budget. A judge cache also needs grader, rubric, schema, model and settings identity; the context fingerprint alone is insufficient.

## Local CLI

```sh
efferent-eval list --config eval.config.ts
efferent-eval validate --config eval.config.ts
efferent-eval run function-contract --config eval.config.ts --split validation --directory .eval-results/run-1
efferent-eval calibrate grader-agreement --config eval.config.ts --repetitions 2
efferent-eval inspect --report .eval-results/run-1/report.json
efferent-eval compare --baseline baseline.json --candidate-report candidate.json
efferent-eval grade --config eval.config.ts --from .eval-results/run-1/execution.json --directory .eval-results/grade-1
efferent-eval review --config eval.config.ts --report report.json --directory .eval-results/review
```

`inspect` and `compare` work without loading app configuration. `list`, `validate` and `estimate` require declarations only; resource acquisition belongs to environment/runnable execution. An async default configuration factory can inspect command arguments without acquiring execution resources. Apps register extensions for domain-specific cost estimation or plan selection.

`grade` runs the app's graders against saved output/evidence and creates a separate report revision without acquiring the subject environment. Reviews start unapproved; `review --import review.json` requires unchanged evidence fingerprints and named approvals with rationales, and writes approved records separately. Applying labels to an app's dataset remains an app-owned, versioned operation.

A run writes `report.json` and individual trial files under `trials/`. Writes use a temporary file followed by atomic rename. Blocking gate failure exits with status 2; missing measurements remain unavailable.

## Prospective comparisons

Ordinary `compare` checks compatibility and displays gates. It does not establish a statistically supported improvement. For a prospective claim, freeze one `ComparisonSpecification` before either execution and pass the same specification to both sides:

```sh
efferent-eval validate answer-quality --config eval.config.ts --spec comparison.json --side baseline --split holdout --repetitions 3
efferent-eval run answer-quality --config eval.config.ts --spec comparison.json --side baseline --split holdout --repetitions 3 --directory .eval-results/baseline
efferent-eval run answer-quality --config revised.config.ts --spec comparison.json --side candidate --split holdout --repetitions 3 --directory .eval-results/candidate
efferent-eval compare --spec comparison.json --baseline .eval-results/baseline/report.json --candidate-report .eval-results/candidate/report.json
```

These are ordinary native runs. `--spec` does not choose tasks, candidates, splits or repetition counts: the explicit selection must match the frozen declaration. `validate --spec` is read-only and opens no execution environment. `calibrate --spec --side …` uses the same preflight after resolving the calibration declaration; `validate` also resolves a named calibration. Calibration defaults to the calibration split; `run` and `validate` default to validation. Split names on native tasks are application-defined.

The specification contains:

| Field | Meaning |
| --- | --- |
| `version`, `id`, `application`, `hypothesis` | Versioned comparison identity and the claim being tested |
| `baseline`, `candidate` | Each exact native Candidate and expected application run fingerprints |
| `allowedFingerprintChanges` | Explicit changed run fingerprint keys; fixture/protocol/assessment changes cannot be allowed |
| `tasks`, `repetitions` | Suite/task IDs and full task fingerprints, including input, reference, review, family, split and grader bindings; repeated samples per task |
| `execution` | Each suite's environment bindings, timeout and concurrency |
| `gradingConfiguration`, `gates` | Frozen assessment definitions/projections and native gate definitions |
| `primary` | One grader/version, metric and direction (`higher` or `lower`) |
| `minimumImprovement` | Strictly positive practical improvement in the metric's original units required by the interval's lower bound |
| `plannedIndependentFamilies`, `targetPower`, `powerRationale` | Planned independent family count, target power of 0.8 and its design rationale |
| `seed` | Unsigned 32-bit bootstrap seed |

Build these identities from declarations, not by copying a result after observing it:

```ts
const selection = { ids: [suite.id], split: "holdout", repetitions: 3 }
const specification: ComparisonSpecification = {
  version: 1, id: EvalId.make("instruction-revision-1"), application: baselineApp.id,
  hypothesis: "The revised instruction improves supported answer quality.",
  baseline: { candidate: baselineCandidate, fingerprints: baselineApp.fingerprints },
  candidate: { candidate: revisedCandidate, fingerprints: revisedApp.fingerprints },
  allowedFingerprintChanges: ["application"],
  tasks: suite.tasks.filter((task) => task.split === "holdout").map((task) => ({
    suiteId: suite.id, taskId: task.id, fingerprint: comparisonTaskFingerprint(task),
  })),
  repetitions: 3,
  execution: comparisonExecutionSettings(baselineApp, selection),
  gradingConfiguration: comparisonGradingFingerprint(baselineApp),
  gates: comparisonGateDefinitions([suite]),
  primary: { grader: "answer-quality@1", metric: "supported", direction: "higher" },
  minimumImprovement: 0.05,
  plannedIndependentFamilies: plannedFamilyCount, targetPower: 0.8,
  powerRationale: designRationale, seed: 42,
}
// Serialize with Schema.encodeEffect(ComparisonSpecification), so Option gate bounds encode correctly.
```

Programmatic consumers pass `comparison: { specification, side }` in `EvaluationSelection`. The public `comparisonPreflight` checks the complete selection without I/O. The CLI exports `evaluationSelection(args)` so application admission can use the same parser. Application-specific provider routing, budgets and fixture revisions must be captured in Candidate configuration or run fingerprints; the generic runner cannot discover them. A calibration's effective application and target-grader provenance come from `calibrationApplication(app, calibrationId)`.

Before any subject call, the CLI exclusively creates `comparison-spec.json` in a fresh directory. The core validates selection and binds the decoded specification fingerprint and side to execution provenance. A failed attempt cannot overwrite this file by reusing the directory. `grade` preserves the original specification identity and rejects `--spec`: it cannot add preregistration retroactively. Changing grading policy makes a frozen comparison incompatible. Regrade both saved captures for exploratory measurement corrections, then freeze a new design for future confirmation. Historical reports remain readable through ordinary comparison, but do not acquire prospective status.

The subject still receives only its input, candidate and environment. The specification, references and power rationale never enter runnable input. A target judge revision is a candidate change in a calibration; its agreement grader and labels remain fixed. Agreement grader fingerprints describe the metric contract and agreement rule, while target fingerprints stay on the candidate, runnable and calibration provenance.

### Estimation and interpretation

The comparison matches every specified task and repetition. It averages bound primary scopes within a trial, paired repetitions within a task, tasks within a family, and then gives every family equal weight. `Task.family` is an application-wide lineage ID: translations, paraphrases and cases derived from one source retain the same family even across datasets or suites. Efferent does not infer semantic independence from a filename or language.

It resamples paired family means 10,000 times using the frozen seed and reports a two-sided 95% percentile bootstrap interval. Positive reported improvement always means better, including lower-is-better metrics. At least `max(30, plannedIndependentFamilies)` independent families are required for confirmation. Thirty is a conservative reporting floor, not a power calculation: the application supplies the design rationale, expected effect/variation and independent family count for its 80% target. More repetitions do not increase the independent sample count.

The report gives `incompatible`, `inconclusive`, `improved` or `regressed`. Improvement requires the entire interval above the declared practical margin; regression requires it below the negative margin. An interval crossing either decision boundary is inconclusive, not a tie or equivalence. Insufficient families, provisional references, incomplete required evidence and degenerate intervals remain inconclusive. Nonmatching task/specification/configuration identities are incompatible. No p-value or achieved power is invented.

`accepted` additionally requires the candidate to pass the recomputed frozen blocking gates. Reports expose per-task paired changes, observed regressions, gate findings and missing measurements, so an aggregate cannot conceal failures. All primary pairs and required blocking grades must be present; unavailable primary data is never a zero or an omitted successful pair. Secondary unmeasured grades are counted separately and do not invalidate an otherwise complete primary comparison. Secondary scores, exploratory candidate searches and repeated looks cannot be promoted to the preregistered primary claim. `compare --spec` exits 0 only when accepted, otherwise 2; invalid inputs retain typed errors. Plain `compare` retains its existing compatibility-only exit behavior.

### Holdout ownership

The application owns fresh case authoring, review, semantic family assignment, sealing, exposure records and the draft/frozen/consumed/retired lifecycle. A split named `holdout` is not proof that nobody has read it. The library can validate recorded identities, not observe source-file access or certify secrecy. Once a result informs an instruction, fixture, judge or policy change, retire that holdout version from confirmation. Preserve the original failures and use a fresh independent family set for the next prospective claim. This policy needs no separate runner or campaign service.

## Export

```sh
efferent-eval export --config eval.config.ts --report report.json --exporter langfuse,langsmith
efferent-eval run function-contract --config eval.config.ts --exporter langsmith
```

Register `langfuseExporter(options)` or `langsmithExporter(options)` in the app's `exporters`. Clients are constructed only when exporting. Stable remote IDs map back to local trial IDs and metric identities. Both adapters use the provider's official SDK. Langfuse receives traces and numeric scores; LangSmith receives project runs and feedback. Full encoded trial metadata retains unavailable grades, context, usage and provenance.

Export after a run is best-effort and produces separate receipts/errors after the local report is durable. The explicit export command can retry a saved report. Live application telemetry is a separate concern and is not reconfigured by evaluation export.

## Retrieval grading

`rankingMetrics` provides hit rate, precision, recall, MRR, nDCG, anchor nDCG and unjudged/duplicate counts. Unknown relevance makes judged precision/full nDCG unavailable. Anchor nDCG deliberately measures against the known positive anchors and must be named as such. Applications may supply observed relevance grades when they own a stronger duplicate identity rule.

`semanticRetrievalGraders(judge)` provides contextual precision over ranked passages, contextual recall over expected claims and contextual relevancy over statements. Apps project documents, sentence units and claims, bind their judge model and cost guard, and preserve the verdicts. Missing or duplicate verdict IDs fail validation. Empty required units are unavailable. The definitions are informed by DeepEval's [precision](https://deepeval.com/docs/metrics-contextual-precision), [recall](https://deepeval.com/docs/metrics-contextual-recall) and [relevancy](https://deepeval.com/docs/metrics-contextual-relevancy) metrics; no Python runtime is required. Answer faithfulness and answer relevance are separate answer graders.

## Historical reports

The root entrypoint exposes the typed evaluation domain. The previous calibration/journey
execution APIs and the `legacy` entrypoint have been removed. Historical evidence stays
unchanged; migrate declarations to tasks and use `grade` with a new directory for each
grading revision. The deprecated reference scenarios retain their frozen runner independently
of the evaluation package.
