# Evals v3 — scenario packs, evidence, standing baselines

**Status: approved direction (2026-07-07). Implemented after reshape PR R1** (which
deletes the distill suites and the Verifier support the migration would otherwise
carry). Breaking: the v2 `EvalSpec` (`data → task → scorers`) API is removed.

> **Note (2026-07-10):** the design landed in `packages/scenarios` (this doc's
> `packages/evals` paths read as `packages/scenarios`); foundry's stranded
> `EvalContract.ts` was retired — the scenarios framework is the ONE eval type
> system. The keyed batteries run through `bun run evals:live` (see
> `packages/scenarios/CLAUDE.md`).

> **UI matrix (2026-07-13):** `bun run evals:ui-matrix` is a separate, keyed
> model × effort × incremental-protocol campaign. Its default path boots the
> actual Canvas server, submits through a headless Chromium form, measures the
> first content delta and meaningful DOM paint, captures desktop/mobile
> screenshots and overflow, and audits the SQLite page/failure trail. It never
> substitutes scripted page content. Provider/schema/tool failures AND runtime
> defects are contained per trial as failed rows — one dead candidate never
> aborts the concurrent work. Every settled trial is persisted immediately to
> `<evidence>/trials/<candidate-task-sample>.json` before aggregation, so a
> killed campaign keeps its completed evidence; the aggregate report is still
> written at the end. `--strict` opts into a non-zero exit when every candidate
> fails. `--session-only` is a diagnostic path, not quality evidence.

## Why a revamp

The agent line (`docs/agents/`) ships four agents whose definition-of-done is a
**full scenario** — a refine dialog that locks a spec and forges it; a tutor
session that serves, grades, and adapts; a social scan that drafts, gates, and
queues. Evals v2 cannot express that:

1. **The case shape is one-shot.** `task(input) → output → scorers` forces a
   multi-turn scenario into an opaque task, and scoring sees only the final
   output. There is no way to assert "after turn 2 the draft file changed" or
   "the lock event preceded the forge event".
2. **Evidence is not first-class.** "Are the steps being invoked correctly?" is
   answered today by hand-auditing `~/.efferent/efferent.db` (tool-call
   sequences, turn alternation, brief contents). The framework should capture
   the event trail + the persisted conversation + the workspace and hand them
   to checks as data.
3. **Regression detection is opt-in.** `--save`/`--compare` + the bootstrap-CI
   gate exist and are good, but nothing runs them unless a human remembers the
   flags. Baselines should be a committed convention checked by default —
   foundry's ratchet UX, applied to agent quality.
4. **Suites are per-feature, not per-agent.** Each agent needs a scenario pack
   that IS its regression battery, extended as the agent grows.

The current runner keeps ordered scenarios and evidence as the unit. Samples
retain raw outcomes and report empirical success with a Wilson interval plus
pass@k/pass^k estimates. Hard checks and infrastructure are mandatory outside
the quality mean. Committed baselines carry per-sample evidence and
git/lock/runtime provenance; missing, renamed, or unbaselined cases fail.
Config-matrix A/Bs, sharding, cost budgets, and bootstrap change tests remain
future work rather than implied shipped behavior.

## The model

```
Suite = { name, threshold, scenarios: NonEmpty<Scenario<W>>, samples?, gate? }

Scenario<W> = {
  name, tags?, difficulty?,
  boot:  Effect<W, unknown, EvalEnv>          // acquire the world (scoped)
  steps: NonEmpty<Step<W>>                    // ordered; a step failure stops the scenario
  judges?: Judge<W>[]                         // graded 0..1 axes over the FINISHED world
}

Step<W>  = { name, act: (w) => Effect<unknown, unknown, EvalEnv>, checks: NonEmpty<Check<W>> }
Check<W> = { name, severity: "hard" | "soft", run: (w) => Effect<CheckResult, never, EvalEnv> }
CheckResult = { pass: boolean, detail?: string }
```

- **World `W`** is the pack's evidence carrier, built by `boot` (scoped acquire/
  release — temp workspace, in-memory or SQLite stores, hook-fed event log).
  The standard `AgentWorld` exposes: `dir` (workspace root + fs helpers),
  `events` (every AgentEvent, ordered), `conversation(id)` (persisted messages
  — the DB audit as data), `finalText`, `trees` (context nodes). Packs extend
  it (`SmithWorld` adds the SpecDoc + the `.foundry/runs` artifact; `MathWorld`
  adds the graded-answer ledger).
- **Steps enforce order.** `act` drives the agent (send a turn, lock a spec,
  submit an answer); `checks` are deterministic assertions on the world AFTER
  the act. A failed **hard** check marks the scenario failed and skips the
  remaining steps (fail-closed, like a staged gate pipeline); **soft** checks
  record findings without stopping.
- **Judges** run once per scenario on the finished world, only in live mode —
  anchored-rubric LLM judges (the calibration machinery already guards them).
- **Scoring.** deterministic score = checks passed / checks evaluated, FLAT
  across hard and soft (the planned hard/soft weighting never shipped — a
  hard failure instead fail-closes the remaining steps, so it already
  dominates). Beware the dilution: soft checks raise the floor under a hard
  failure, so packs whose score must be exact (the calibration battery) use
  a single hard check per scenario. The scenario folds judges in at the
  pack's declared judge weight (default 0.3); `samples: k` runs a scenario
  k times and records the mean.

## Evidence library (`framework/evidence.ts`)

The manual DB audit, as combinators — each returns a `Check<AgentWorld>`:

- `toolSequence(conv, ["ls", "read_file", "propose_spec"], { mode: "subsequence" | "exact" })`
- `userTurnAt(conv, position, matcher)` · `turnAlternationValid(conv)` (tool-call/result pairing)
- `eventOrder(["spec_draft", "spec_locked", "forge_start"])` · `eventCount("llm_retry", { max: n })`
- `fileExists(rel)` · `fileContains(rel, matcher)` · `commandExitsZero(argv)`
- `briefContains(conv, matcher)` (first user message of a spawned run)
- `spendBelow({ tokens?, usd? })` (from the captured usage events)

Checks never throw; a missing conversation/file is a failing CheckResult with
detail, not a crash (the v2 `Effect.exit` discipline).

## Modes

- **`--mode live`** (default): the real model drives `act`; deterministic checks
  + judges both run. Key-gated, skips cleanly.
- **`--mode scripted`**: packs whose world exposes a scripted agent seam (smith's
  `RefineAgent` / `runForgeSessionWith`; more seams as agents land) run key-free
  — deterministic checks only. This is CI's free tier: it catches HARNESS
  regressions (events, persistence, gate wiring) on every push. A scenario
  declares `scripted: (w) => …` when it supports it; live-only scenarios are
  skipped in scripted mode. Unit tests remain the primary wiring proof; scripted
  scenarios prove the same wiring END-TO-END through the eval harness, so a
  live-mode failure can be bisected to model-vs-harness by re-running scripted.

## Standing baselines (the regression ratchet)

- `packages/evals/baselines/<suite>.json` — a committed `SavedReport` (report +
  manifest), one per suite that has earned a baseline.
- `bun run eval` **compares against the committed baseline by default** when one
  exists for a selected suite (the v2 bootstrap-CI + Bonferroni gate, no flag
  needed); a significant drop exits non-zero. `--no-check` opts out for
  exploratory runs.
- `bun run eval --update-baselines` rewrites the committed files (mirrors
  foundry's explicit ratchet update; reviewed in the PR diff like any baseline).
- `--save`/`--compare <path>` stay as the low-level escape hatch for ad-hoc A/Bs.

## Span vocabulary

`eval.run → eval.suite → eval.scenario → eval.step → eval.check | eval.judge`.
`trace/process.ts` aggregates scenario means the way it aggregated case means;
tokens/cost still come from descendant `llm.generate` spans. Grafana dashboards
get one new drill level (step), nothing else moves.

## Suite migration (all 20 v2 suites)

| v2 suite | v3 disposition |
|---|---|
| distill, distillClassification | **deleted in R1** (learning machinery gone) |
| quality, feature, handoff, toolSelection, coderEdit, backgroundShell, wholeTask, repoTasks | **coder pack** — wholeTask/repoTasks become real multi-step scenarios over `AgentWorld` (scenarioRun.ts's trajectory capture folds into the world); the rest map to single-step scenarios via the `caseScenarios` helper |
| judgeApproval, compactionDigest, sessionTitle | **helpers pack** — single-step scenarios calling the fast-tier use cases directly |
| webUi | **ui-builder pack** seed; W4 promotes `validateUi` checks into it |
| delegationDecision, orchestration, swarm, swarmCompile, researchDelegation, researchEfficiency | **swarm pack** — kept but tagged `swarm`, excluded from the default run once R4 flips the default roster to direct (`bun run eval swarm-pack` opts in) |
| — | **NEW smith-spec pack**: live refine→edit→lock→forge scenario (checks: propose_spec sequence, draft file decodes, lock precedes forge, accept gates in gateNames, artifact outcome accepted, brief carries the mid-refine edit; judge: spec quality rubric) + scripted twin over the session seams |
| — | **math / social packs** land with M2 / S3 per their plan docs |

`caseScenarios(cases, act, checks, judges?)` keeps dataset ergonomics: it fans
an `EvalCase[]`-shaped table into single-step scenarios, so migrating a v2
one-shot suite is mechanical.

## What the foundry `eval-shape` gate enforces after v3

Registration in `run.ts` · `threshold` present · scenarios non-empty · every
step's `checks` non-empty · every scenario name unique in its suite. (The
non-empty rules are BY TYPE too, as in v2; the gate catches the `as never`
escape hatches.)

## Phasing

1. **R1** (before this): distill suites + Verifier support deleted.
2. **v3 core PR**: framework (`Scenario`/`Step`/`Check`/`Judge`/`AgentWorld` +
   evidence lib + `caseScenarios`), runner rewrite (modes, standing baselines),
   span vocabulary, migrate the coder/helpers/ui-builder/swarm packs, update the
   eval-shape gate, delete `framework/Eval.ts`+`runEval.ts` (v2 API).
3. **smith-spec pack PR**: the live + scripted scenario pack; first committed
   baseline minted from a green live run.
4. Each subsequent agent PR (R3 gates, M*, S*, W*) ships its pack additions +
   baseline updates in the same PR — the full-scenario battery is part of the
   agent's definition of done, not an afterthought.
