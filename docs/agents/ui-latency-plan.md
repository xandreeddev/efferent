# UI-agent latency plan — from 11.6s to a sub-4s first paint

Status: Phase 0 + both probes SHIPPED 2026-07-16 (stage-boundary events,
per-stage usage/wall-clock in matrix trials, `evals:ui-latency-probe`);
probe results in `docs/evals/ui-latency-probes-2026-07-16.md` — argument
deltas STREAM on the codex route (Phase 2 greenlit on native-tools) and
effort `none` is accepted (`minimal` rejected; vocabulary widened). Phases
1–4 remain to build, each gated by the matrix. Sources: the v9 screening
evidence (`docs/evals/ui-agent-screening-v9-2026-07-13.md`, trial JSONs), a
static decomposition of the current prompts/schemas/adapters, and a 2025–26
state-of-the-art sweep of the latency levers available on our provider routes.

## Where the 11.6s actually goes (measured + back-solved)

The winning config (luna / native-tools / medium) paints at p50 11.6s and the
ENTIRE budget is server-side before `page_opened` — WS push + browser
mutation is a measured **+20ms** tail, session boot is ≤~100ms. The opaque
11.4s block decomposes against known physics as:

| stage | ms | status |
|---|---|---|
| planner first-token | ~1,500 (0.8–2.1s) | prior campaigns; UNMEASURED for native-tools (`recordFirstDelta` only listens to the text channel) |
| reasoning @ medium, interleaved with decode | ~3,400 | back-solved residual; the 62 tok/s observed vs luna's 224 tok/s ceiling is the reasoning-interleave signature |
| generating the 1,624-char `start_ui` payload | ~6,500 @250 chars/s | measured payload × measured throughput |
| admission + WS + paint | ~20–120 | measured |

Completion is worse: composer 4-node patches are ~2,732 chars (~11s each), so
sequential completion blows the 55s composer deadline into repair on most
trials → complete p95 130s. The composer/repair interval is UNATTRIBUTABLE
today — no stage-boundary events carry wall-clock.

**The payload wall:** the required `start_ui` alone (1,624 chars) floors at
6.5s @250 chars/s — over the 5s target with zero first-token and zero
reasoning. No knob fixes this; the payload must shrink or stream.

The manifest is 1,138 of those 1,624 chars, and most of it is host-derivable:
the 590-char slots array (admission already back-fills missing slots), the
326-char theme block (already `Schema.optional`; host tokens are the live
fallback), the designSystem echo (admission OVERWRITES it — pure waste),
id/title (derivable from the request). Genuinely model-owned: recipe +
archetype + the first node (~650 chars total).

## The plan (ordered; every prompt/profile change pays the matrix ritual)

### Phase 0 — instrument before optimizing (SHIPPED 2026-07-16)
Landed as: `ui_stage` stage-boundary events (turn receive + started/settled
per stage, wall-clock, ledgered) published by the ui-agent session; the
matrix's arrival-stamped per-trial `timeline` with derived `stageMetrics`
(wall + tokens + turns per stage, `deriveStageMetrics`) and
`serverReceiveMs`; per-candidate stage p50s in the report. The
tool-params-start stamp was deferred INTO Phase 2 (the probe below already
answered the first-token question, and the fan-out is Phase 2's mechanism).

### Probes (SETTLED 2026-07-16 — `evals:ui-latency-probe`, results in `docs/evals/ui-latency-probes-2026-07-16.md`)
1. **Argument-delta probe: PASS.** The codex route emits
   `tool-params-start/delta/end` through `streamText` (301/323 deltas per
   start_ui call), streaming over the final 2.5–10.0s the settled path
   spends waiting. Phase 2 proceeds on native-tools; the text-protocol
   fallback is unnecessary for streaming admission. Also measured: NO
   text-delta parts exist under native-tools, and reasoning arrives as one
   summary blob — text-channel first-delta metrics are structurally blind
   here.
2. **Effort probe: `none` accepted (reasoning_tokens 0), `minimal`
   REJECTED** by the subscription dialect. The vocabulary gained `none`
   end-to-end (engine policy, ui profile schema, catalog, matrix grid);
   pins stay medium until the Phase 1 matrix (k≥3, `--efforts
   none,low,medium`, admission-rejection-controlled) decides.

### Phase 1 — shrink the required `start_ui` (the only lever that alone gets the floor under 5s)
Extend `normalizeInitialUiAdmission` (the existing canonicalization seam):
synthesize ALL slots from recipe order + emitted blocks; default theme to host
tokens (deviations via `patch_theme`); derive id/title from the request; stop
requiring the designSystem echo. Planner emits recipe + archetype + ONE node.
Payload 1,624 → ~650 chars; generation floor 6.5s → **~2.6s**; paint estimate
at medium ≈ 1.5 + 3.4 + 2.6 ≈ **~7.5s**, with the effort probe's outcome
(minimal-class emit) taking it to **~4.5s**. Bonus: this canonicalization is
the SAME fix the disqualified text protocols need (their records failed on
exactly these host-derivable fields), so it revives them for the fallback
fleet for free. Quality risk: models may rely on writing slots to plan IA —
gate on the matrix at k≥3.

### Phase 2 — streaming admission for native-tools (perceived paint ≈ first-token + first node)
If the argument-delta probe passes: fan `tool-params-*` in `streamFold.ts`
(new delta channel), tolerant partial-JSON decode in the session, and an
incremental admitter that opens the page from a manifest skeleton + first
completed node (today `start_ui` validates only a COMPLETE manifest). Order
the strict schema so model-owned, paint-critical fields close FIRST — OpenAI
structured outputs emit properties in schema order. With Phase 1's payload:
paint ≈ 1.5s first-token + ~1.8s first node ≈ **~3.3s**, independent of total
decode. If the probe fails: fall back to the (Phase-1-fixed) compact-lines
text protocol, which already has a working per-line decoder.

### Phase 3 — parallel composer fan-out (completion 130s p95 → ~45–60s)
Blockers mapped: one shared attempt conversation (interleaved appends corrupt
alternation), page-global `complete:true` (validates the whole fold), and a
read-modify-write race on the event fold. Enabler: block upsert-by-id is
already idempotent and disjoint. Design: one child conversation per worker on
disjoint slot ranges, same pageId, single barrier-gated `complete:true`. Cuts
the serial 2.7k-char-patch chain that currently rides the 55s deadline into
repair on most trials.

### Phase 4 — prefix caching + grammar pre-warm (shaves prefill, not decode)
Move the per-stage role sentence to the END of the prompt so the 5,312-char
shared `contract()` becomes a common cacheable prefix across planner/composer/
repair (today the differing first sentence kills the prefix at ~40 chars).
Rethink `prompt_cache_key`: it IS forwarded on the codex route but keyed per
conversation → every new page is a cold prefill; key by host-contract hash
instead so cross-page hits fire. Pre-warm the strict-schema grammar at canvas
boot (first-call compile penalty is real; ~24h cache, invalidated by schema
edits). Worth ~0.5–1.5s of TTFT on a 1,450-token system prompt.

### Ruled out (evidence)
Predicted Outputs (no GPT-5.x, no tools, no Responses API), `service_tier:
priority` (platform-API per-token billing, not the subscription route),
model swaps (luna is already the fastest GPT-5.6 decoder at 224 tok/s; the
Go fleet scored 1/81 in v9). vLLM-style speculative decoding is only
reachable for gateway/OSS fallbacks, not the primary.

## Projected trajectory (to be validated per phase by the matrix, k≥3)

| state | paint p50 | complete p95 |
|---|---|---|
| today (v9) | 11.6s | 130s |
| + Phase 1 (payload) | ~7.5s | ~90s |
| + effort probe outcome | ~4.5s | ~60s |
| + Phase 2 (streaming) | **~3.3s** | ~60s |
| + Phase 3 (parallel composer) | ~3.3s | **~45s** |

Every number above the "today" row is a projection from measured physics, not
a measurement — Phase 0 exists so each phase's claim gets settled by evidence.
