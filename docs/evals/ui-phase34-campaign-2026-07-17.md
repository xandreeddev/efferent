# UI-agent Phases 3+4 — parallel composer, prefix caching (2026-07-17)

The final two phases of docs/agents/ui-latency-plan.md. Gate: two 9-trial
arms at the pinned config (same code, same prompts) — composer workers 1 vs
2 — plus smokes and a 3/3 verification on the historically hostile task.

## What ships

**Phase 4 — prefix caching:**
- The role sentence moved to the END of every stage prompt (prompts
  v10/v11/v8): the shared contract is now a byte-identical PREFIX across
  planner/composer/repair, so provider-side prefill caching fires across
  stages, pages, and workers.
- One prompt-cache lane per HOST CONTRACT: the engine's `AgentConfig` gains
  `promptCacheKey`; the ui-agent session keys it by an FNV-1a hash of the
  contract instead of the conversation id. Probe-verified first: three
  concurrent requests on one shared `prompt_cache_key` (→ one codex
  session-id) all accepted.
- Grammar pre-warm was DROPPED: the pinned route runs `strict: false` —
  there is no schema grammar to compile. (The plan assumed strict mode.)

**Phase 3 — parallel composer:**
- `composer.workers` in the profile (validated 1..4). With workers > 1 and
  ≥2 remaining slots, the composer fans out over DISJOINT slot ranges, one
  child conversation per worker (a shared conversation would corrupt
  alternation). Block upsert-by-id makes worker writes compose.
- Each worker has its OWN deterministic goal — all of its assigned slots
  filled — because the page-complete goal can never fire for a worker
  (workers never declare complete); without it a finished worker's
  continuation turn parks to the stage deadline (measured 64.7s tail in the
  first smoke, gone after).
- The barrier gate: once every required slot has content, the HARNESS
  declares complete through the normal `patch_ui` handler, which still
  validates completeness for real. Workers are forbidden to.
- Storage order is now CANONICAL: the page fold sorts root blocks into
  manifest slot order (children stable after them). Workers finish out of
  order by design; the fold owns visual order, the renderer always agreed,
  and the old emission-order IA check is now enforced by construction.

**#118 containment (found by this campaign):** the catalog handle's
disk-I/O can strike MID-SESSION, and `catalog.list` sits on the admission
path — one broken read turned every component block into "not registered"
and voided whole sessions (3/3 obs-landing failures in the fleet arm, all
identical). The catalog now serves the static CORE vocabulary with a
warning when the workspace read fails: the workspace rows are an
enhancement, never the spine.

## Measured

Arms (same day, same code, successful trials):

| | workers 1 | workers 2 |
|---|---|---|
| complete p50 | 48.5s | **35.4s** (−27%) |
| first content patch p50 | 28.7s | 22.7s |
| judge | 0.46 | **0.60** |
| quality on clean trials | 1.00 | 1.00 |

Post-pin verification on observability-landing (previously 0/6 across two
campaigns): **3/3 clean** — completes 27.1/31.6/31.9s, composer walls
12.6–19.5s, quality 1.00/1.00/1.00.

## Pin

`streaming-ui-v1@10.1.0`: prompts v10/v11/v8 (suffix-role), composer
`workers: 2`. Model/protocol/effort unchanged (luna / native-tools /
medium). Baselines re-minted.

## The four-phase trajectory (pinned config, successful trials)

| | v9 (2026-07-13) | after all phases |
|---|---|---|
| browser paint p50 | 11.6s | **6–12s** (planner-token bound) |
| first content | — (complete-bound) | **15–25s**, blocks progressive |
| complete | p95 130s | **p50 ~30s** |
| quality | 1.00 | 1.00 |

Remaining above the line: the effort-`none` re-pin (paint 4–9s measured,
blocked on #118's full resolution) and Phase 2's text-protocol re-screen.

## Final verdicts (the two questions left open above, settled same day)

Two 18-trial arms on the shipped 10.1.0 runtime (loaded process, all
diagnostics armed):

**Effort re-pin: CLOSED — medium retains, on merit.** Head-to-head at k=9
per effort: medium 7/9 success, judge 0.68, paint p50 8.4s, complete p50
33.2s; `none` 5/9 (+2 painted partials), judge 0.59, paint p50 **8.5s** —
the paint advantage that `none` held pre-phases (4.8–9.6s vs 5.8–20s) is
GONE: streaming admission + the payload cut made paint planner-token-bound
at every effort, and medium wins success and judge outright. Not a punt —
an evidence-based retention.

**Text protocols: CLOSED — confirmed dead on luna.** 0/18 (compact-lines
0/9, a2ui-jsonl 0/9), all `planner/UiPageNotProduced`: no accepted start
record is ever produced, so the failure sits UPSTREAM of the schema the
Phase 1 loosening fixed. The revival hypothesis is falsified for this
model; never re-enable without a different model family and a fresh screen.

**#118 containment: verified under load.** Zero disk-I/O trial voids across
both arms (the catalog core-fallback held; two obs-landing trials survived
as painted partials). Residual failure class: 4 hard caps + 2 partials in
36 trials (~11%) — a provider-hang tail, tracked in #118.
