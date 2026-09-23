# Composable evaluations

The eval package supports independent dataset tasks (`Benchmark`) and ordered,
stateful tasks (`journeyTask`). Both produce version 2 trials and select reusable
evaluators. Existing Pack/Scenario and Check/Judge entry points remain available.
Legacy score fields are now nullable when execution failed; consumers must test
availability before formatting, averaging or establishing a baseline.

## Composition

- A dataset owns typed inputs, reference labels, a version and fixed calibration
  and validation splits. Related families cannot cross splits. Subjective labels
  remain provisional until reviewed.
- A benchmark supplies an Effect task and output/evidence schemas. The task only
  receives input. Its evaluator receives input, output, evidence and reference.
- An evaluator owns an ID, version and named metrics. Bindings select metrics
  without making duplicate calls. One judge can emit several scores.
- `bindBenchmark` binds a typed task for a campaign. The host supplies model
  Layers; candidates in `BenchmarkOptions` are metadata, not implicit routing.
  A host selecting models per candidate binds its own `run(options)` function.
- `journeyTask` acquires a scoped world, performs actions in order, durably records
  each observation and returns partial evidence on a step failure. Its `completed`
  output must be included in the host's deterministic gate.
- `EvaluationStore` persists raw task evidence before assessment and each result
  before aggregation. Reporters/exporters consume results independently.

## Native prompts

Use `Prompt.make`, `Prompt.merge`, `LanguageModel.generateObject` and native model
Layers. Prompt modules own shared instructions, model-specific variants and
version metadata. The loop accepts a legacy system string or a native Prompt.
`CurrentPromptProvenance` carries an optional sidecar record for model adapters;
it does not change the Prompt format or introduce a prompt registry.

```ts
const judge = llmEvaluator({
  id: "answer-quality",
  version: "1",
  metrics: ["groundedness"],
  prompt: (input: { answer: string; evidence: string }) => Prompt.make([
    { role: "system", content: "Assess support using only the supplied evidence." },
    { role: "user", content: JSON.stringify(input) },
  ]),
  schema: Schema.Struct({ supported: Schema.Boolean, reason: Schema.String }),
  assessment: (value) => ({
    metrics: [{ kind: "boolean", name: "groundedness", value: value.supported }],
    reason: value.reason,
  }),
})
// Provide the selected native LanguageModel Layer at the host boundary.
const assessment = assessAll([
  { evaluator: judge, select: ["groundedness"] },
], { answer, evidence })
```

## Measurement and policy

Boolean, scalar, probability and pairwise metrics have distinct types. A scalar
score is not a probability. Calibration reports Brier error only for probability
predictions against boolean references. `summarizeCalibration` reports measured
coverage, confusion counts, precision/recall, false-pass/false-fail rates, scalar
absolute error and ten probability reliability bins; empty bins stay unavailable. `assessBothOrders` preserves both blinded
pairwise judgments and flags order sensitivity instead of converting it to a tie.

Evaluator failure, unavailable evidence and skipped execution contain no metrics.
Unknown usage/cost encodes as null through Effect Option. Deterministic gates are
separate from assessment; new semantic metrics can remain diagnostic. Gates that
depend on reference labels can require known or reviewed labels.

Campaigns preserve completed trials if a target or reporter fails, and report
those failures separately. `comparisonIssues` requires matching case sets and
dataset/fixture/evaluator/policy/evidence fingerprints. Re-scoring saved evidence
uses `assessAll` without rerunning the task.

All examples and regression tests use scripted providers. They establish
execution and measurement behavior, not model quality or provider compatibility.
