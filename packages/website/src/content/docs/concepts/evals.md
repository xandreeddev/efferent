---
title: Evaluation domain and adapters
description: Tasks, trials, graders, suites, app environments, local Node CLI and portable export.
---

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

`defineGraderCalibration` reuses an app's registered grader as its subject. The app supplies
the typed input codec and controlled labelled cases. Execution saves the original grading
context and verdict; a separate agreement grade checks the expected status and metrics,
including unavailable evidence, false passes and false failures. Regrading those observations
does not call the subject. Rerun the calibration to test a changed target grader implementation.
Native gates require exactly one measurement per bound scope, and validation rejects duplicate
scopes, unbound gates and families leaking across dataset splits.

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
efferent-eval run function-contract --config eval.config.ts --execute-only --directory .eval-results/capture
efferent-eval grade --config eval.config.ts --from .eval-results/capture/execution.json --directory .eval-results/grades-1
efferent-eval review --config eval.config.ts --report report.json --directory .eval-results/review
```

`inspect` and `compare` work without loading app configuration. `list`, `validate` and `estimate` require declarations only; resource acquisition belongs to environment/runnable execution. An async default configuration factory can inspect command arguments without acquiring execution resources. Apps register extensions for domain-specific cost estimation or plan selection.

`run` defaults to the validation split; `calibrate` defaults to calibration. Use `--split all`
when a declared suite intentionally crosses both. `--task`, `--candidate`, `--repetitions`,
`--concurrency` and `--timeout-ms` select and bound execution.

Execution writes `execution.json` before any grader runs. `--execute-only` stops there.
`grade --from execution.json` projects and grades saved work with the registered graders,
creates new run/trial identities, records source execution provenance and writes a separate
`report.json`. It never opens an execution environment. Use `--grader id` for a subset and a
fresh directory for each revision. Required projection context has a deadline as well as a
byte budget. Incomplete execution cannot pass a gate even if a grader returns a score.

Reviews start unapproved; `review --import review.json` requires unchanged evidence
fingerprints and named approvals with rationales, and writes approved records separately.
Applying labels to an app's dataset remains an app-owned, versioned operation.

Writes use a temporary file followed by atomic rename; each trial and grade is durable as
it completes. Blocking gate failure exits with status 2. Missing measurements are unavailable.
Remote export does not change the local execution or grade revision.

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

## Migration

The previous calibration/journey execution APIs and `rescore` / `rejudge` command aliases
are removed. The public package exports the native domain and its pure grading helpers;
`./stats` remains a separate entrypoint. There is no historical report importer. Existing
historical artifacts can remain on disk while new runs use the native schema.

## Agent plugins and captured context

An application composes its agent plugins independently of its `EvaluationApp` registry.
Memory plugins maintain and render model context from a session log; tool discovery provides
active tool definitions. An app model adapter captures the serialized request after those
steps and any provider-specific transformations, then the runnable copies capture into the
portable execution. Final database state is useful as an independent outcome but cannot
reproduce what an earlier model call saw.

A projection reads saved capture, not current memory or live storage. Another app supplies
its own environment, runnable, evidence codecs and projections while reusing this domain,
CLI, retrieval graders and optional export adapters. To test a changed memory plugin, execute
again. To test a changed rubric or projection, grade the same saved execution again.
