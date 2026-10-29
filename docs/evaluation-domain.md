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

Suite, task, candidate, runnable, grader, projection, calibration and run ids are `EvalId`s: one segment, without "/" or "@". A trial's id joins them as `run/suite/candidate/task/sample` (an `EvalPath`, as are transcript event ids) and a grader key is `<id>@<version>`, so two trials never share a trial file and a key always splits back into its grader and version. A run id that is not an `EvalId` fails the run as `invalid`.

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
The app supplies a concrete input codec, controlled cases and `CalibrationReference` labels;
the result is an `Effect` that fails with `invalid` when a case's input does not encode.
The registered grader runs as the subject and captures `CalibrationObservation` plus its exact
grading context. A separate agreement projection/grade checks status and metrics, including
expected unavailable results, false passes and false failures. Labels never enter the subject.
Regrading saved observations makes no subject calls; testing a revised target grader requires
executing the controlled calibration again. Candidate fingerprints include the target grader.

`parseEvaluationApp` decodes an app before every run, grading and `validate`, and
`loadEvaluationApp` passes a configuration's default export through it. It checks the shape
first (definitions as their schemas' types, so a gate without a minimum or maximum is refused
there; layers are Layers and commands functions), then the cross-references
(`evaluationAppViolations`): unique ids, suites with tasks and candidates, graded tasks,
duplicate grader scopes, families split across development and validation, registered
runnables, environments, graders and projections, and gates bound to a task and to a metric
of their grader. A refusal is `invalid` and lists every `AppViolation` (`{ rule, path,
message }`, `rule` being `shape` or the broken cross-reference) in `violations`; its message
names the first five. Gate coverage requires exactly one scored metric per bound scope;
duplicate grades cannot substitute for a missing scope.

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

`TrialRecorder.record` persists each transcript event during execution. If a target fails, the earlier events remain. The runner persists the terminal execution before grading and each completed grade independently. A grading failure does not erase the target's evidence. A failed trial, grade or assessment records its reason as text: `code: message` for a coded error, `interrupted`, or a defect's message, never a stack trace or the local paths in one, so reports and exports can be shared. A trial that times out or is cancelled still has its world inspected, within the inspection's own deadline, so its outcome is kept.

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

Flags take `--flag value` or `--flag=value`. Without `--directory`, results go to `.eval-results/runs/<id>`, named after the run or grading revision they hold. `--repetitions`, `--concurrency` and `--timeout-ms` take positive integers; anything else is a usage error (`invalid`), never a silent default. A report or review file that does not exist fails as `missing`; one that does not decode, as `invalid`; any other file failure, as `persistence`. Each such error says what failed (`Cannot read <path>: EISDIR: …`) and keeps the underlying error as its `cause`.

`inspect` and `compare` work without loading app configuration. `list`, `validate` and `estimate` require declarations only; resource acquisition belongs to environment/runnable execution. An async default configuration factory can inspect command arguments without acquiring execution resources. Apps register extensions for domain-specific cost estimation or plan selection.

`grade` runs the app's graders against saved output/evidence and creates a separate report revision without acquiring the subject environment. Reviews start unapproved; `review --import review.json` requires unchanged evidence fingerprints and named approvals with rationales, and writes approved records separately. Applying labels to an app's dataset remains an app-owned, versioned operation.

A run writes `report.json` and individual trial files under `trials/`. Writes use a temporary file followed by atomic rename; a failed write removes its temporary file. Blocking gate failure exits with status 2; missing measurements remain unavailable. Ctrl-C or SIGTERM interrupts the command: running trials settle as `cancelled`, their scoped worlds close, and the command exits with status 130 (a second signal ends it at once). `runCliMain` runs a command this way for an app's own entrypoint.

## Export

```sh
efferent-eval export --config eval.config.ts --report report.json --exporter langfuse,langsmith
efferent-eval run function-contract --config eval.config.ts --exporter langsmith
```

Register `langfuseExporter(options)` or `langsmithExporter(options)` in the app's `exporters`. Clients are constructed only when exporting. Stable remote IDs map back to local trial IDs and metric identities. Both adapters use the provider's official SDK. Langfuse receives traces and numeric scores; LangSmith receives project runs and feedback. Full encoded trial metadata retains unavailable grades, context, usage and provenance; everything sent is the report's encoded form, so an absent value is `null`. Exporting a report to LangSmith again updates the runs and feedback the first export created.

Export after a run is best-effort and produces separate receipts/errors after the local report is durable. A failed export is a `provider` error whose message carries the service's reason (`LangSmith export: Failed to create project. Received status [401]…`) and whose `cause` is the client's error; a receipt keeps the message only. The explicit export command can retry a saved report. Live application telemetry is a separate concern and is not reconfigured by evaluation export.

## Traces

A host that runs the use cases under a tracer (`Effect.withTracer`, or its telemetry layer) sees one span per unit of work:

```text
eval.calibrate         calibrateGrader: eval.calibration.id, eval.run.id
└─ eval.run            runEvaluation: eval.run.id
   ├─ eval.trial       one trial: eval.run.id, eval.trial.id, eval.suite.id, eval.task.id, eval.candidate.id, eval.sample
   │  └─ (the runnable's own spans; a calibration's eval.calibration.execute)
   └─ eval.regrade     gradeEvaluation, also on its own over saved work: eval.run.id
      └─ eval.grade    gradeTrial, one trial's grades: the trial's ids
         └─ (the projection's and graders' spans: eval.calibration.project, eval.retrieval.assess)
```

Logs written under `eval.trial` and `eval.grade` carry the same ids as annotations, under the same keys. Dataset-level assessment opens `eval.evaluator` per evaluator, `eval.semantic.run` for `semanticEvaluator`, the judges' `eval.semantic.llm` and `eval.semantic.jev`, and `eval.pairwise` over both orders. Each exporter's `exportRun` is one `eval.export` span carrying `eval.exporter` and `eval.run.id`.

The command line traces through the app. An app's `observability` layer (a `Layer.Layer<never>`, such as `Layer.orDie(OtlpTelemetryFromEnv())` from `@xandreed/plugin-telemetry`) is provided around each command that loads the app, and that command is one `eval.cli` span carrying `eval.command`, over the spans above and the exports' `eval.export`. The layer closes with the command, so its spans are flushed when the command ends and when Ctrl-C or SIGTERM interrupts it. It has no error type: observability never fails an eval. `inspect`, `compare` and `help` load no app and open no span.

## Retrieval grading

`rankingMetrics` provides hit rate, precision, recall, MRR, nDCG, anchor nDCG and unjudged/duplicate counts. Unknown relevance makes judged precision/full nDCG unavailable. Anchor nDCG deliberately measures against the known positive anchors and must be named as such. Applications may supply observed relevance grades when they own a stronger duplicate identity rule.

`semanticRetrievalGraders(judge, { rubric })` provides contextual precision over ranked passages, contextual recall over expected claims and contextual relevancy over statements. Apps project documents, sentence units and claims, bind their judge model and cost guard, and preserve the verdicts. The judge is given the units to rule on (`retrievalItems`: the documents, the claims as `claim:<n>` or the statements as `<document>/statement:<n>`, each with its text) and returns one verdict per id; missing or duplicate verdict IDs fail validation. `rubric` holds each measure's judge prompt (or its template): its fingerprint becomes the grader's `rubric` fingerprint, so reports graded under different prompts do not compare as alike. Empty required units are unavailable. The definitions are informed by DeepEval's [precision](https://deepeval.com/docs/metrics-contextual-precision), [recall](https://deepeval.com/docs/metrics-contextual-recall) and [relevancy](https://deepeval.com/docs/metrics-contextual-relevancy) metrics; no Python runtime is required. Answer faithfulness and answer relevance are separate answer graders.

## Historical reports

The root entrypoint exposes the typed evaluation domain. The previous calibration/journey
execution APIs and the `legacy` entrypoint have been removed. Historical evidence stays
unchanged; migrate declarations to tasks and use `grade` with a new directory for each
grading revision.
