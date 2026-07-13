# @xandreed/scenarios

**Evals v3** (`docs/evals-v3.md`, adapted to the new line): the unit is a
SCENARIO — ordered steps over a booted WORLD — and the evidence (event trail,
persisted conversation, workspace fs) is data the checks read. The TOP of the
new line's dependency graph: packs may import the agent packages; nothing
imports scenarios.

```bash
bun run scenarios [pack …] [--mode scripted|live] [--json]
bun run scenarios -- --update-baselines     # rewrite the committed ratchet files
bun run scenarios -- --no-check             # skip the baseline comparison

bun run evals:live [battery …] [--samples n] [--update-baselines]   # the KEYED batteries
bun run evals:ui-matrix [--models …] [--efforts …] [--protocols …] # real Canvas browser matrix
```

## evals:live — the pre-merge ritual for prompt changes

`src/evalsLive.ts` runs the KEYED batteries (never CI): the judge-gate
calibration set, the refiner/digest/memory golden sets, and the scored live
smith run — all as live-mode `Pack`s through the SAME runner/baseline
machinery. Each eval'd prompt carries a version constant recorded in the
pack's `meta` and the minted baseline; drift prints a warning so every
score delta is attributable. **The ritual: change a prompt → bump its
version constant → `bun run evals:live <battery>` → review the delta →
`--update-baselines` in the same PR.** Framework extras: `Pack.samples`
(raw independent outcomes, empirical success + Wilson 95% interval, and
pass@k/pass^k estimates; the quality score is the mean),
`Pack.tolerance` (per-pack regression wobble), `Pack.summary` (derived
lines, e.g. calibration false-block/false-pass). Cost of a FULL run ≈ 1M
tokens (dominated by the live forge); the per-change ritual runs ONE
battery. The trajectory critic lives in `src/judges/trajectoryCritic.ts` as
a reusable `Judge<W>`; `src/critic.ts` stays its manual CLI.

- **framework/** — `model` (Scenario/Step/Check/Judge/Pack; worlds erased by
  PRE-BINDING the runner, no casts), `run` (scoped boot → step fold — a hard
  check failure fail-closes the rest — → judges in live mode; every failure
  captured, never thrown), `evidence` (fileExists/fileContains · eventOrder/
  eventCount/eventWhere · toolSequence/turnAlternationValid/briefContains).
- **packs/** — one per agent. `smith-spec`: the refine → lock → forge
  pipeline; the SCRIPTED twin (smith's `RefineAgent` + `runForgeSessionWith`
  seams + foundry's scripted implementor) runs key-free in CI and proves the
  harness wiring end-to-end — spec file lifecycle, event order, spec checks
  becoming accept gates, the reject→fix→accepted loop. Live scenarios ride
  the same checks with the real model (key-gated).
- **baselines/** — committed `<pack>.<mode>.json` ratchet files, compared BY
  DEFAULT. Missing/new/orphaned cases and prompt-version drift fail; each mint
  carries raw check/judge/sample evidence plus git/lock/runtime provenance;
  `--update-baselines` is the explicit, PR-reviewed update.

Hard checks are mandatory independently of score, infrastructure-failed
samples remain errors, and empty/all-skipped packs fail. Each agent PR ships
its pack additions + baseline updates — the full-scenario battery is part of
the agent's definition of done. Remaining simplifications: no bootstrap
change test, config matrix, cost budget, or sharding yet.

`bun test packages/scenarios` — framework semantics (hard-fail stops, soft
continues, mode skip, captured act failures, evidence combinators, pack
means). ZERO-entry ratchet baseline like every new-line package.

## UI matrix evidence

`src/uiMatrix.ts` is model-backed by definition. Its default path boots a real
Canvas server, submits the request through the browser form, observes the first
meaningful DOM mutation, captures desktop/mobile screenshots and overflow, and
then reads the SQLite event/failure trail. It compares model × effort × protocol
without substituting scripted page content. Provider timeouts and schema/tool
failures become failed trial rows and the JSON report is still written; pass
`--strict` when an all-failed campaign should return a non-zero exit. Use
`--session-only` only to diagnose the runtime without browser rendering.

The default `screening` task set spans landing/application/document. Pass
`--task-set reference` for the frozen twelve-product corpus. Relevance is
concept-group coverage with localized/inflected aliases, not English exact
substring matching; IA also requires the requested archetype. Non-native
protocols send no native tool schemas to the provider—the decoded records still
use the same local toolkit handlers.
