---
title: Evals — calibrations and journeys
description: One declarative value per calibration, journeys over booted applications, shared evaluators and judges, gates and reports.
---

`@xandreed/evals` runs two kinds of eval. A **calibration** runs one subject under
test (a port, an adapter, a prompt, a judge) over a labelled dataset for every
candidate. A **journey** runs an ordered conversation over a booted application
and scores each turn. Both produce the same trials, bind the same evaluators and
judges, persist through the same store and compare with the same fingerprints.
The application owns the datasets, subjects, candidates, evaluators and policy;
the library runs them and reports. It keeps no registry of its own.

## A calibration is one value

```ts
import { Effect, Schema } from "effect"
import { defineCalibration, runCalibration } from "@xandreed/evals"

export const localeCalibration = defineCalibration({
  id: "message-locale",
  version: "3",
  dataset: localeDataset,                       // typed inputs, labels, fixed splits
  candidate: Schema.Struct({ id: Schema.String, model: Schema.String }),
  candidates: [{ id: "small", model: "vendor/small" }, { id: "large", model: "vendor/large" }],
  subject: {
    task: (input) => resolveLocale(input.text),   // sees the input only
    services: (candidate) => LocaleLive(candidate.model), // fresh for every case
    fingerprints: { prompt: "locale-v3" },
  },
  output: LocaleDecision,
  evidence: LocaleDecision,
  evaluators: [{ evaluator: localeContract, select: ["locale", "fallback"] }],
  gates: [
    { evaluator: "locale.contract", metric: "locale", aggregate: "mean", minimum: 0.95, mode: "blocking" },
    { evaluator: "locale.contract", metric: "fallback", aggregate: "mean", maximum: 0, mode: "blocking" },
  ],
  select: (summaries) => summaries.filter((summary) => summary.passed),
  run: { repetitions: 3, concurrency: 1, timeoutMs: 90_000 },
})

const report = runCalibration(localeCalibration, { runId: "2026-10-02", split: "calibration" })
```

The dataset keeps `calibration` and `validation` splits apart and marks labels
`known`, `reviewed` or `provisional`. The subject's `task` never receives the
reference; its `services(candidate)` Layer is rebuilt for every case so counters,
budgets and clients never leak between cases. Candidates are decoded strictly
from files (`decodeCandidates`). Gates aggregate one metric per candidate
(`mean` or `passRate`, with `minimum`/`maximum`); diagnostic gates are reported,
never enforced. `judgeCalibration` pairs reference labels with the subject's
metrics so `summarizeCalibration` can report agreement, Brier error and
false-pass/false-fail rates: that is how a judge is calibrated. `select` is the
host's policy; without it there is no recommendation, and the library never
ranks or promotes on its own.

A run returns a `CalibrationReport`: identity fingerprints (calibration, dataset,
evaluators, subject, candidates), every trial, per-candidate metrics, gates,
performance and judge calibration, failures, the recommendation and whether it
is promotion eligible (every blocking gate passed, reviewed labels, no failures).
`calibrationMarkdown` renders it; `comparisonIssues` refuses to compare reports
whose identity, case sets or coverage differ.

## Keyed scores and declared completeness

Typed metrics retain their kind and range. Each metric may supply its own
`comment`; `evaluationScores(result)` returns `{ key, score, comment }` rows for
scored results, using the assessment reason as a compatibility fallback. Error,
unavailable and skipped results produce no numeric rows.

`assessCompleteness(evidence, actions)` validates one label for each declared
customer action, valid tool/evidence references, and explanations for every
partial or missing action. Code calculates `(matched + 0.5 * partial) / total`.
An empty applicable action set is unavailable. The generated comment includes
every action and its attributed invocation and step.

```ts
import { assessCompleteness } from "@xandreed/evals"

const assessment = assessCompleteness({
  required: [
    { id: "opening", description: "State the opening time." },
    { id: "directions", description: "Explain how to reach the office." },
  ],
  tools: [{ name: "read_office", invocationId: "call-1", stepId: "step-1" }],
  evidenceRefs: ["office-hours", "delivered-answer"],
}, [
  { actionId: "opening", status: "matched", tools: [
    { name: "read_office", invocationId: "call-1", stepId: "step-1" },
  ], evidenceRefs: ["office-hours", "delivered-answer"], reason: "09:00 is stated." },
  { actionId: "directions", status: "missing", tools: [],
    evidenceRefs: ["delivered-answer"], reason: "No directions were delivered." },
]) // Effect<Assessment, AssessmentError>; completeness = 0.5
```

## Projections and registration

`projectEvaluatorInput(evaluator, project)` adapts a narrow evaluator to a larger
run bundle. For example, a helpfulness evaluator can receive only the request
and delivered answer while an execution evaluator receives tool definitions,
calls and step snapshots. The framework never fetches a tracing vendor's data.
The host owns capture, authorization, storage and optional telemetry export.

`evaluatorRegistry(entries)` validates unique `id@version` keys and returns a
checked resolver. Each entry records an evaluator, projection version, prompt
hash and effective settings. Journeys bind judges by `id@version` from this
registry; a calibration of the judge itself uses the same resolved evaluator as
its subject, so a calibration result applies to exactly the judge the journeys
run.

## Journey selection and step evidence

Journey expectations accept `maxAgentSteps`, `requiredToolArguments` and
`requiredActions`. Missing measured steps fail an explicitly declared ceiling.
Journeys can declare `coverage: { tools, recipes }` and versioned evaluator
bindings with turn/journey scope; hosts execute those bindings against their own
appropriate evidence projections.

`selectJourneys(corpus, { tiers, tools, recipes, ids })` selects whole journeys
from declared coverage and expected required/forbidden calls, never from observed
execution. Values within one selector are OR; selector kinds are AND. Unknown
selectors and empty results fail. Numeric tiers 0–3 are supported;
`journeyTier` maps historical blocking/quality/exploratory to 0/1/2.

The agent loop emits `turn_end` with completed/failed/cancelled status, paired
with `turn_start`. `CurrentAgentStep` is a fiber-local optional step index,
inherited by model and parallel tool effects. Hosts can correlate provider
attempts and tool executions without a mutable global counter or an additional
LLM call. Capture duration using a monotonic clock; a fixed scenario date is not
an elapsed-time measurement. Absent usage or observations remain unavailable.

## Deprecated: scenario packs

`packages/scenarios` holds this repository's reference-application packs on a
frozen copy of the retired Pack/Scenario runner. They still run in CI
(`bun run scenarios`) and will be adapted to calibrations and journeys.
