# UI-agent screening campaign v9 — 2026-07-13

108 real browser trials: 4 models × 3 efforts × 3 protocols × 3 screening
tasks (recipe application, observability landing, architecture document),
samples=1, concurrency 3, judge enabled. Every trial boots a real Canvas
server, submits through headless Chromium, and persists timings, desktop +
mobile screenshots, DOM overflow, the SQLite page/failure trail, and a durable
per-trial JSON the moment it settles.

Evidence: `.efferent/evals/ui-agent-screening-v9.json` (aggregate, v5 schema) ·
`.efferent/evals/ui-agent-screening-v9-screenshots/` (screenshots + `trials/`).
Log: `ui-agent-screening-v9.log`.

## Campaign reliability (the reason v9 exists)

The v8 attempt froze for 5+ hours two minutes in: closing a crashed Chromium
sat in an unbounded, uninterruptible release path, and Effect interruption
waits for finalizers — so the 315s trial timeout could never fire. Fixed in
`180087f8db6`: every trial runs under `Effect.disconnect` + a hard wall-clock
cap (budget + 60s) that abandons a wedged runtime in the background, and
browser/server closes are bounded at 10s. A regression test reproduces the
wedge. v9 then ran all 108 trials to completion with zero harness casualties —
every provider failure and defect settled as a durable failed-trial row.

## Results (success = complete page + DS 1.0 + IA 1.0 + relevance ≥ .6 + accepted refinement)

| candidate | success | browser-first p50 | complete p95 | DS | IA | rel | judge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **luna / native-tools / medium** | **3/3** | 11.6s | 130s | 1.00 | 1.00 | 1.00 | **0.91** |
| luna / native-tools / high | 2/3 | 14.1s | ∞ | 0.67 | 0.67 | 0.67 | 0.58 |
| luna / native-tools / low | 2/3 | 22.6s | ∞ | 0.67 | 0.67 | 0.67 | 0.57 |
| glm-5.2 / native-tools / high | 1/3 | ∞ | ∞ | 0.33 | 0.33 | 0.33 | 0.31 |
| everything else (32 candidates) | 0/3 | ∞ | — | ≤0.33 | ≤0.27 | ≤0.33 | — |

## Findings

1. **Both text protocols failed EVERYWHERE — 0/54 including luna.** The
   `compact-lines` and `a2ui-jsonl` planners keep emitting records that fail
   schema admission (e.g. `page.title` missing), so no page ever opens
   (`UiPageNotProduced`). Without native tool-schema enforcement the models do
   not reliably produce a valid full manifest as freeform JSON-per-line. The
   previously committed profile pinned `compact-lines` — live Canvas would
   have failed most requests. **The streaming protocols are not
   production-ready as shipped**; they need either admission-side default
   canonicalization (host fills title/recipe), a worked example in the
   protocol instruction, or provider tool-argument delta streaming instead.
2. **Winner: `openai-codex:gpt-5.6-luna` / native-tools / effort medium** —
   the only candidate at 3/3, deterministic quality perfect, judge 0.91, and
   its screenshots show genuinely specific model-generated pages (themed,
   no overflow, honest failure banner during composer soft-timeouts). Medium
   beat low (the previous pin): low failed 1 of 3 and pays ~2× first-paint
   (22.6s vs 11.6s p50 — reasoning at low effort is NOT faster on the new
   component grammar). n=3 caveat: medium-vs-high separation is thin; the
   pin is medium on success count + tails + judge, not on a significant gap.
3. **The opencode Go fleet is currently unusable for this workload**:
   deepseek-v4-flash 0/27 (provider 400 "Upstream request failed" on every
   trial), kimi-k2.6 0/27 (never finishes a page — throughput), glm-5.2 1/27
   (native/high only; its known bimodal latency). Fallback stays glm-5.2 as
   the least-dead option, but a fallback activation today would usually fail.
4. **Latency truth vs targets**: best browser-first-visible p50 is 11.6s and
   0/108 trials made ≤5s. The ≤5s first-meaningful-UI target is unreachable
   with settled native tool calls on the 73-component grammar (payload
   physics); completion p95 for the winner is 130s (composer 55s hard cap +
   repair completing the page). The path to ≤5s remains task #113 — templated
   manifests and STREAMING admission — which now additionally requires fixing
   finding 1 (protocol validity) first.

## Actions taken

- Profile `streaming-ui-v1.json` → **8.1.0: protocol native-tools, all stages
  effort medium** (was compact-lines / low). Canvas pack meta bumped, canvas
  scripted baseline re-minted (scenarios exit 0), full battery green
  (686 tests, 7 packs, typecheck zero findings).

## Follow-ups

- Protocol validity (finding 1) before any streaming-latency work: admission
  canonicalization for missing manifest fields + a worked `@ui start` example,
  then re-screen the protocols. (#113)
- Wire the profile fallback for real + failure-state banner (#114) — with the
  Go fleet this weak, fallback correctness matters less than fallback honesty.
- Re-screen at samples≥3 before treating medium-vs-high as settled; consistency
  scoring needs samples>1 to mean anything.
- deepseek-v4-flash: drop from DEFAULT_MODELS or probe the provider 400 — 27
  guaranteed-failed trials per campaign is wasted wall-clock.
