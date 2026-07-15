# Math authoring campaign v1 — 2026-07-14

32 live trials: 2 models × 2 efforts × 4 grade/theme tasks (g2 stickers,
g4 fractions, g6 decimals/percentages, g8 linear equations) × k=2. Every trial
drives the REAL math session (prompt 2.1.0, toolkit, admission, SQLite trail)
over two turns (`start` + `more`) and scores deterministically: admission pass
rate, independent-solver key agreement, answer-kind variety, difficulty
spread, latency. Evidence: `.efferent/evals/math-matrix-campaign-v1.json` +
`…-evidence/trials/` (durable per-trial JSONs, defect containment, hard caps —
the uiMatrix v9 reliability kit).

## What was fixed before the campaign (the investigation's findings)

1. **The choice placement trap** (live-caught 2026-07-07: 2 of 4 exercises in
   a real grade-4 batch bounced with a MISLEADING reason): models nest options
   inside `answer.choices`, schema decode silently stripped them. Admission
   now HOISTS them (canonicalize, don't reject), the rejection message names
   the top-level placement precisely, and the prompt (2.1.0) finally shows a
   complete choice exemplar. Campaign result: choice exercises admitted in
   every trial, `rejected=0` on nearly every batch.
2. **Accept-list consistency gate**: a numeric `accept` entry that doesn't
   grade equal to the key is dead or contradictory — bounced with a fix-it
   reason while the model can still correct it.
3. **Question-text dedup (G6)**: the same question under a fresh id bounces —
   in-call and session-wide (`servedPromptKey`); id-only dedup let repetition
   through.
4. **The turn-parking bug (cross-agent, engine+providers)**: after a run's
   last successful tool call, models finish with an EMPTY response; the
   router's empty-response rejection sent it through retries and the turn
   ERRORED with no `agent_end`, riding its full deadline. Live: math turns
   burned 120s budgets for ~20s of work; the same signature inflated the v9
   ui composers to their 55s caps. Fixed with `CurrentEmptyResponseTolerance`
   (first-call empties stay hard-rejected — the real outage signature).
   Smoke-verified: turns 125s → 18–30s.
5. **Codex streaming is transport-broken**: the subscription websocket refuses
   its upgrade (Expected 101). Math runs generateText deliberately; the v9 ui
   campaign de-facto ran on the same fallback throughout.

## Results

| candidate | success | admission | solver agreement | first-batch p50 | turn p95 |
| --- | --- | --- | --- | --- | --- |
| **luna / medium** | **8/8** | **1.00** | **0.98 (100%, see below)** | 19.6s | 38.9s |
| luna / low | 8/8 | 0.99 | 0.89 | 20.5s | 43.3s |
| glm-5.2 / low | 7/8 | 0.92 | 0.93 | 60.0s | 125s |
| glm-5.2 / medium | 5/8 | 0.83 | 0.95 | 57.7s | 125s |

The single luna-medium solver "miss" was grading noise (solver replied `$51`
for key `51`; the oracle can't parse currency) — true key correctness at
medium is **100%**. The harness now strips currency prefixes.

## Verdict

**Pinned: effort MEDIUM (`modelPolicy` in `mathAgentBundle`), model follows
the general role (today `openai-codex:gpt-5.6-luna`).** Medium's reasoning
margin lands exactly on the product's most important number — key correctness
(0.89 → ~1.00 vs low) — at equal latency. glm-5.2 is disqualified for an
interactive product: ~60s to the first exercise and turns that still ride
their timeouts. Re-run `bun run evals:math-matrix` before trusting any
general-role model change.

## Follow-ups

- The validated pool (task #32 M4) remains unbuilt — every `more`/`harder` is
  a live ~20s authoring turn; the pool is the path to instant serves and
  cross-session variety memory.
- Difficulty-arc validation (G13) and a `harder` step-up assertion belong in
  the matrix's next revision; difficulty spread is measured but not gated.
- A pedagogy judge (grade-fit, hint-teaches-method, warm contexts) on
  finalists — deterministic scorers cannot see teaching quality.
- samples=2 per candidate; re-screen at k≥3 before any future re-pin.
