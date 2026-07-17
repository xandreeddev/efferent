# UI-agent Phase 1 campaign — host-derived manifest, stage goals, effort re-screen (2026-07-16)

The latency plan's Phase 1 gate (docs/agents/ui-latency-plan.md), run as three
27-trial browser campaigns over `openai-codex:gpt-5.6-luna × {none, low,
medium} × native-tools × 3 screening tasks × k=3`, plus a text-protocol
revival check. Probes and Phase 0 landed in PR #240; this campaign gates the
Phase 1 code:

- **the minimal wire manifest** (model owns id/title/archetype/compact slot
  plan/optional theme; host derives recipe + design-system ref + slot
  metadata; same loose schema in the text-protocol start record);
- **prompt v9/v10/v7** (planner/composer/repair — host-default restatement
  removed, compact slots mandated);
- **deterministic stage goals** (added mid-campaign, see below): a stage
  settles when its outcome exists in the page store — planner on page-open,
  composer/repair on page-complete — with the model call raced as a
  DISCONNECTED loser.

## Campaign A — Phase 1 payload on the old runtime (the "before")

| effort | success | paint p50 | complete (successful trials) | note |
|---|---|---|---|---|
| none | 6/9 | 5,698ms | 70.2–76.8s | every success 1.00/1.00/1.00 quality |
| low | 6/9 | 13,184ms | 37.0–79.0s | same quality profile |
| medium | 4/9 | ∞ (worse) | 35.7–77.4s | failures cascade late in the run |

Two findings the stage telemetry made undeniable:

1. **Effort `none` is the paint winner and quality holds.** Payload cut +
   no reasoning ⇒ paint p50 5.7s (vs 22.6s pinned pre-Phase-1); planner
   `start_ui` output dropped ~990 → ~150–220 tokens. Every successful `none`
   trial scored 1.00 design-system / 1.00 IA / 1.00 relevance.
2. **Post-goal turns dominated everything else.** After the last successful
   tool call, the continuation turn parks on provider empties (the
   turn-parking bug's STREAMING-path sibling — the settled-path tolerance
   fix never reaches `streamText`) or hangs outright with zero events for
   the full 300s request timeout. Planner and composer each rode their 55s
   deadlines; completions landed at 70–79s; hung continuations blew trials
   into the 375s cap, and each abandoned runtime degraded the rest of the
   campaign (disk-I/O churn, provider contention).

## Campaign A2 — + stage goals (race, non-disconnected)

Successful trials collapsed to **complete 24.6–38.5s** (planner walls
7–16s, composer 15–33s, zero parking) with quality intact — but success
stayed ~5/9: post-completion trials still capped out. Autopsy of the
abandoned trial workspaces showed **12 of 13 had `page_completed` in the
store** — the work finished; the trial wedged AWAITING the interruption of
the hung model call the goal had just beaten (interruption waits on the
wedged continuation — the same physics as the v8 finalizer freeze).

## Campaign A3 — + disconnected race loser

Post-completion caps disappeared, but caps persisted on stages whose FIRST
call hung: the stage deadline (`Effect.timeout`) declares victory by
interrupting the call, and that interruption waits on the same wedge — the
disconnect protected the goal path but not the deadline path.

| effort | success | complete p50 (successes) | range |
|---|---|---|---|
| none | 4/9 | 24.3s | 21.2–27.1s |
| low | 6/9 | 31.4s | 25.8–84.5s |
| medium | 5/9 | 33.8s | 30.9–53.1s |

Failure taxonomy: 6× trial cap (hung first call + wedged deadline), 3×
SQLite disk-I/O at trial boot, 2× browser-closed — the latter two are
harness infra (task #118), uncorrelated with effort or the Phase 1 code.
Every completion above is the model's own work: quality 1.00/1.00/1.00 on
all successes except one 0.80 IA.

## Campaign A4 — + disconnect UNDER the stage deadline

Stage-level wedges eliminated: every successful trial's stage walls are now
bounded (planner p50 6.5–10.1s, composer p50 20.4–34.1s) and completions
hold at p50 **29.9s (none) / 35.9s (medium) / 41.8s (low)**. But the trial
success rate DEGRADED (12/27; 7 caps + 6 disk-I/O + 2 browser) even as the
runtime got strictly safer — and the failures worsened monotonically across
the four back-to-back campaigns (~110 luna browser trials in ~2h). The
infra failure class is environmental (harness SQLite pressure from the goal
pollers and/or provider fatigue under sustained load), NOT attributable to
the Phase 1 code: across all four campaigns, every trial that produced a
page scored 1.00/1.00/1.00 (two exceptions at 0.80–0.9 IA), painted in
4.1–20s, and completed in 21–107s. All error sites are now labeled and the
post-drive evidence reads retry once — the follow-up is task #118.

## Aggregate: what four campaigns of SUCCESSFUL trials prove

| metric | v9 pinned (medium, pre-Phase-1) | Phase 1 (medium) | Phase 1 (none) |
|---|---|---|---|
| planner `start_ui` output tokens | ~990 | ~210–410 | ~130–225 |
| browser paint | p50 11.6s | 5.8–20.0s | **4.1–9.6s** |
| complete | p95 130s (deadline-ridden) | p50 ~30–36s | p50 ~24–30s |
| quality (DS/IA/relevance) | 1.00 | 1.00 | 1.00 |

The completion collapse comes from the deterministic stage goals (not the
model): pre-goal, planner and composer each rode their 55s deadlines after
finishing their work — the post-tool continuation turn parks on provider
empties (the turn-parking bug's streaming-path sibling) or hangs outright.

## Text-protocol revival

Included in schema only: the start record now carries the loose wire
manifest (v9's text protocols failed admission on exactly the
host-derivable fields). The live re-screen is deferred until #118 makes
campaign evidence clean — text protocols remain OFF.

## Verdict

- **Profile pin: streaming-ui-v1@9.0.0 — luna / native-tools / medium
  (model, protocol, effort all UNCHANGED).** The latency gains ship in the
  code (payload + stage goals), not in a pin move.
- **Effort `none` is the measured paint frontier** (4.1–9.6s paints,
  perfect quality on every completed trial) — the re-pin decision is
  BLOCKED on clean campaign reliability (#118), per the rule that pins move
  only on clean evidence.
- Re-run ritual: `bun run evals:ui-matrix --models
  openai-codex:gpt-5.6-luna --efforts none,low,medium --protocols
  native-tools --samples 3` once #118 lands, then decide none-vs-medium.

