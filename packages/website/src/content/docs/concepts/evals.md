---
title: Evals — scenario packs
description: Ordered steps over real agent worlds, deterministic evidence checks, and committed baselines compared by default.
---

`@xandreed/scenarios` sits at the top of the package graph — the only package
allowed to import the agents — and treats each agent's definition-of-done as
what it really is: **a full scenario**, not a one-shot input/output pair.

## The shape

A pack is a list of scenarios; a scenario is **ordered steps** over a real
agent world — boot the workspace TUI, type an idea, `:lock`, `:forge`, read
the dashboard — and **deterministic evidence checks** over three sources the
framework captures as data:

- the **event trail** (the session ledger, in order),
- the **persisted conversation** (the same SQLite trail the TUI resumes from),
- the **workspace** (files the run actually wrote).

"After the lock, the spec file's status is `locked`" and "the forge events
follow the lock event" are one-line checks, not hand audits of a database.

## Baselines by default

Every pack has a **committed baseline** compared on every run — foundry's
ratchet UX applied to agent quality. `bun run scenarios` (and CI) fails on
regression without anyone remembering a flag. The **scripted twins** — the
same scenarios driven by scripted models — run key-free in CI; live-keyed
runs use the same packs against real providers.

## Honest limits

Scripted twins validate the harness, the folds, and the wiring — they cannot
catch a live-provider defect (a response-shape change, a field the gateway
renamed) or rendering under real load. Those classes are covered by the
frame-level TUI battery (the real renderer, headless) and by live smoke runs;
when a live bug ships anyway, the rule is: reproduce it, fix it, and land the
regression at whichever layer would have caught it first.

## Reusable runner

`@xandreed/evals` exports `scenario`, `runPack` and `evaluate`. Supply arbitrary
scoped fixtures, checks, judges and reporters from your application. The runner
contains no application pack registry. `packages/scenarios` hosts this repository’s
reference-app batteries and committed baselines.

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

## Projections, registration and calibration

`projectEvaluatorInput(evaluator, project)` adapts a narrow evaluator to a larger
run bundle. For example, a helpfulness evaluator can receive only the request
and delivered answer while an execution evaluator receives tool definitions,
calls and step snapshots. The framework never fetches a tracing vendor's data.
The host owns capture, authorization, storage and optional telemetry export.

`evaluatorRegistry(entries)` validates unique `id@version` keys and returns a
checked resolver. Each entry records an evaluator, projection version, prompt
hash and effective settings. Use the same resolved evaluator when scoring a
journey and building its calibration target.

`promptFamilyBenchmark({ id, version, output, dataset, evaluate, comparator })`
builds an ordinary `Benchmark` for one prompt family. `evaluate` receives only
the case input; reference labels go to the outer comparator. The adapter never
runs an agent or silently calls several unrelated prompts. One subject prompt
may still emit multiple metrics. Human label review remains explicit in the
existing dataset case `review` field.

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
