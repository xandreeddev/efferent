# UI-agent Phase 2 — streaming admission (2026-07-17)

Phase 2 of docs/agents/ui-latency-plan.md, greenlit by the argument-delta
probe (docs/evals/ui-latency-probes-2026-07-16.md). Native-tools only; the
text protocols remain off.

## What ships

- **Engine**: `streamFold` fans `tool-params-start/delta` through the delta
  channel (`assistant_delta` gains channel `"tool-params"` + optional
  `toolName`); the parts still pass through settled, so the settled turn is
  byte-identical to the non-streamed path. Plain-text renderers drop the
  channel (the smith TUI does).
- **ui-agent**: an incremental admitter in the session buffers each tool
  call's streaming arguments and admits through the SAME toolkit handlers:
  - `start_ui`: once the `page` object and the first `criticalBlocks`
    element are complete (string-aware prefix scan + full schema decode),
    the page opens early — at most once per call.
  - `patch_ui`: each block paints the moment its own JSON completes;
    `complete` is NEVER inferred from a prefix — only the settled call may
    declare it.
  - Early admissions are failure-silent (the settled call owns rejections,
    so repair never sees duplicate findings), and every early block passes
    the full admission gate individually.
- **Page fold**: re-opening an existing page MERGES (manifest replaced,
  accepted blocks upserted) — the settled call's re-open and any late
  abandoned call can no longer wipe progress.
- **Matrix**: `firstToolParamsMs` per trial; the evidence reads gained a
  fresh-handle fallback (#118 diagnostic).

## Measured (pinned config: luna / native-tools / medium)

| metric | Phase 1 | Phase 2 |
|---|---|---|
| browser paint p50 | ~30–36s era: 5.8–20s | **6.2–8.5s** (p50 7.1) |
| first content patch | 30.9–51.5s (settled-patch bound) | **15.8–25.1s** (p50 ~18–20s) |
| complete p50 | ~30–36s | **27.3–36.5s** (p50 31.2) |
| quality (successes) | 1.00 | 1.00 across DS/IA/relevance |

Composition of evidence: the 9-trial gate campaign (4 clean successes; 5
infra rows — 3 labeled catalog-handle disk-I/O, 1 trial cap, 1 browser
crash) + a 3/3 clean diagnostic re-run of the previously always-failing
observability-landing task + two instrumented smokes. The timeline proof of
mechanism (developer-api-landing smoke): early `page_opened` at 7.28s with
the settled merge at 7.43s; the composer's first block painted at 18.4s —
7.5s before its own patch settled at 25.9s; blocks then painted
progressively to completion at 43.5s. In the same trial the composer's
first settled patch was REJECTED (an undeclared prop) — the valid blocks
from it had already passed the gate individually and stayed painted; the
corrected re-send merged idempotently.

## The #118 update the labels bought

The infra failures self-identified: `trial catalog.list:
ui-component-catalog: SQLite disk I/O error`, persistent across a 500ms
retry. Ruled out by direct experiment: cached-statement races (`.all()` is
synchronous; a repro with 3 concurrent readers + writer is clean), closed
handles (different error), deleted files (reads survive via the open fd).
The failing task's "correlation" was WAVE POSITION — obs-landing boots in
the loaded second wave; alone it runs 3/3 clean. The fresh-handle fallback
now recovers the read AND logs whether a rebuilt handle works, which
settles handle-state vs file-state corruption on the next loaded campaign.

## Verdict

Streaming admission ships ON at native-tools (it is runtime behavior, not
a pin — profile stays luna/native-tools/medium@9.0.0). The paint p50 is now
bounded by planner first-token + first-node args; the remaining completion
tail is the composer's serial patch chain — Phase 3.
