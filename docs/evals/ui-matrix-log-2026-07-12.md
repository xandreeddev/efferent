# ui-agent model/prompt optimization log — 2026-07-12

The running record of the matrix campaign: every run's numbers, what they
mean, and the decision they drove. Evidence JSONs live in
`.efferent/evals/`; this file is the summary of record.

## Baseline state (before this campaign)

Two full matrix runs (v2 19:25, v3 20:49) scored **0.000 for every candidate**
(8+ models × 3 efforts × 3 tasks). Per-trial error analysis split the failures
into exactly two classes — neither was model quality:

| class | count (v3 run) | cause |
| --- | --- | --- |
| `planner/TimeoutException` at 12s | 33 | planner must emit a COMPLETE `start_ui` payload inside the budget |
| `tool:start_ui/UiRejected` design-system mismatch | ~18 | the prompt never told the model the host's designSystem id/version (fixed in prompts 5.0.0/6.0.0/3.0.0: host contract block + admission canonicalization of optional asset refs) |

Post-fix smoke (deepseek-v4-flash · low · 3 tasks): **first accepted page
ever** — observability-landing: visible 9.7s, complete 28.1s, 1 patch,
DS 1.00, relevance 1.00, IA 0.50. Other two tasks still died at the 12s
planner budget. Contract seam: FIXED. Latency: the open problem.

## E1 — transport first-token probe (35s cap, effort low, tiny completion)

Every healthy model streams its first part in **0.8–2.1s**:

| model | first part |
| --- | --- |
| opencode:glm-5.1 | 811ms |
| opencode:mimo-v2.5 | 906ms |
| opencode:minimax-m3 | 1125ms |
| opencode:deepseek-v4-flash | 1152ms |
| openai-codex:gpt-5.6-luna | 1182ms |
| opencode:kimi-k2.7-code | 1370ms |
| opencode:qwen3.7-plus | 1446ms |
| opencode:qwen3.7-max | 1490ms |
| opencode:mimo-v2.5-pro | 1548ms |
| opencode:qwen3.6-plus | 1683ms |
| opencode:glm-5.2 | 1725ms |
| opencode:deepseek-v4-pro | 1893ms |
| opencode:kimi-k2.6 | 2122ms |
| opencode:minimax-m2.7 | **BROKEN** — empty responses, excluded |

**Finding (overturns the transport hypothesis):** the network/provider path
is fast. The 9–30s first-paint in the matrix is *generation time for the
full `start_ui` JSON* (manifest + blocks before anything renders), plus
thinking-token overhead. Latency optimization = **output tokens on the
critical path**, exactly the "50 props will be a mess and slow" intuition.

## E1b — constrained-JSON throughput probe (~3k-char governed emission, effort low)

| model | total | chars/s | valid JSON |
| --- | --- | --- | --- |
| opencode:minimax-m3 | 9.8s | **420** | ✗ (sloppy) |
| opencode:mimo-v2.5-pro | 12.8s | 274 | ✓ |
| openai-codex:gpt-5.6-luna | 12.3s | 238 | ✓ |
| opencode:glm-5.2 | 12.9s | 257 | ✓ |
| opencode:glm-5.1 | 14.2s | 246 | ✓ |
| opencode:kimi-k2.7-code | 18.9s | 168 | ✓ |
| opencode:mimo-v2.5 | 21.6s | 118 | ✓ |
| opencode:deepseek-v4-pro | 32.0s | 115 | ✓ |
| opencode:kimi-k2.6 | 51.6s | 56 | ✓ (thinking-dominated) |
| opencode:deepseek-v4-flash | 21.1s | **empty text** | ✗ |
| qwen3.7-max / 3.7-plus / 3.6-plus | 60s timeout ×3 | — | ✗ |

**The math that forces the architecture:** at ~250 chars/s, a full ~3k-char
`start_ui` payload = ~12s. No accessible model meets a <2s first block with a
full-page first paint. The contract is reachable ONLY skeleton-first
(manifest + 1 block ≈ 0.8–1.2k chars ≈ 3–5s, then `patch_ui` enrichment).
"Fewer, smarter props" is not a style preference — it is the latency budget.

## E2 — capability matrix, 6 candidates × low × 3 tasks, relaxed budgets (120s/180s)

17/18 trials produced ACCEPTED pages; DS = 1.00 across the board (contract
fix validated at scale). Evidence: `ui-agent-matrix-2026-07-12T22-00-54-844Z.json`.

| model (low) | visible | complete | patches | IA mean | rel | strict success |
| --- | --- | --- | --- | --- | --- | --- |
| opencode:glm-5.1 | **5.8–13.3s** | 15–26s | 2,2,2 | 0.67 | 1.00 | 0/3 |
| openai-codex:gpt-5.6-luna | 8.9–16.6s | 24–32s | 1,1,1 | 0.75 (one 1.00) | 0.93 | 1/3 |
| opencode:glm-5.2 | ~19s | 33–41s | 1 | 0.75 | 1.00 | 1/3 |
| opencode:mimo-v2.5-pro | 21–28s | 49–78s | 1,2,1 | **0.83 (one 1.00)** | 1.00 | 1/3 |
| opencode:minimax-m3 | one NO-PAGE trial | — | — | 0.42 | 0.67 | 0/3 — OUT |
| opencode:kimi-k2.7-code | 14–38s | ≤99s | 2 | 0.67 | 0.93 | 0/3 — OUT |

**Systematic IA losses (prompt gaps, not capability gaps):**
- observability-landing scored IA 0.50 for nearly every model — the validator
  expects the LANDING archetype to open with `hero`; models open with
  `navigation`. Nobody told them the per-archetype first-block rule.
- Slot order vs block order drops points similarly.

## E3a — ordering rules + one-block skeleton (prompts 5.1.0/6.1.0/3.1.0)

Top-4 × low × 3 tasks. Evidence: `ui-agent-matrix-2026-07-12T22-07-09-220Z.json`.
- **mimo-v2.5-pro: 3/3 perfect (IA 1.00 everywhere)** — the explicit rules fixed it.
- glm-5.1 visible dropped to **4.6–9.0s** (one-block skeleton works); luna 6–10.7s.
- Residual: observability-landing stuck at IA 0.50 for glm-5.1/glm-5.2/luna.

**Evidence dissection of the residual (the key diagnostic):**
1. Nav link targets emitted as `#features` — the validator wants verbatim
   block ids; every 0.50 trial had unresolved targets.
2. The prompt's OWN recipe line listed `landing.hero-grid: navigation, hero…`
   — models that "failed" hero-first were obeying the prompt's own ordering.
   (mimo followed the explicit rule; the rest followed the listing.)

## E3b — recipe-order fix + no-# rule + host canonicalization (5.2.0/6.2.0/3.2.0)

Also: `canonicalizeUiBlocks` strips `#` from nav targets host-side and now
runs on BOTH `start_ui` and `patch_ui` admission (patches previously had no
normalization at all). Colocated test added. Top-4 × low × 3 tasks.
Evidence: `ui-agent-matrix-2026-07-12T22-15-49-780Z.json`.

**12/12 perfect deterministic trials — every model 3/3, DS 1.00 IA 1.00.**

| model | visible | complete p50/p95 |
| --- | --- | --- |
| gpt-5.6-luna | 5.6–9.4s | 24.9s / 31.8s (most consistent) |
| glm-5.2 | — | 24.6s / 47.2s |
| mimo-v2.5-pro | 9.7–13s | 38.6s / 112.9s (heavy tail) |
| glm-5.1 | **4.6–7.6s** | 72s / 98s (completion variance blew up) |

## E3c — chunked enrichment (5.3.0/6.3.0/3.3.0): 2–3 blocks per patch_ui

Composer emits SEVERAL small patches (complete:true on the last); matrix
composer maxSteps 3→5. Top-3 × low × 3 tasks.
Evidence: `ui-agent-matrix-2026-07-12T22-25-38-022Z.json`.
- First patch improved 25–45s → **17–20s typical** (glm-5.2 p50 11.8s, one
  sub-10s trial); patches 2–4 per page; DS/IA still 1.00 everywhere.
- Trade: some completion tails grew (glm-5.2 arch-doc 104s); relevance
  wobbled at k=1 (0.60–1.00) — sample noise, needs k≥2.
- Structural note: first-patch ≤10s requires planner ≤5s + first chunk ≤5s;
  only glm-5.1-class paint speed makes that reachable. The honest UX metric
  is visible ~5–10s then a patch every ~5–10s — achieved.

## Confirmation run: glm-5.2 vs gpt-5.6-luna, k=2, judge ON

Evidence: `ui-agent-matrix-2026-07-12T22-30-12-122Z.json`.

| model (low) | strict | DS | IA | rel | cons | judge | visible | first-patch p50/p95 | score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **openai-codex:gpt-5.6-luna** | **6/6** | 1.00 | 1.00 | 0.97 | 0.97 | 0.93 | **6.0–8.7s** | 18.9s / 40.0s | **0.721** |
| opencode:glm-5.2 | 6/6 | 1.00 | 1.00 | 0.97 | 0.97 | 0.93 | 7.8–13.7s | 26.2s / 77.2s | 0.717 |

Quality is a dead heat (identical deterministic scores, identical judge).
The separation is latency SHAPE: luna's distribution is tight; glm-5.2
throws 64s first-patches and 77s completion tails.

## VERDICT

**Pinned: `openai-codex:gpt-5.6-luna` (effort low) for all three stages,
fallback `opencode:glm-5.2`** — written into
`packages/ui-agent/profiles/streaming-ui-v1.json` (version 6.0.0, composer
maxSteps 5 for chunked patching). deepseek-v4-flash (the old pin) is
disqualified: empty text in E1b, timeouts in the smoke.

What actually moved the numbers, in causal order:
1. **Host contract in the prompt** (sol) — from 0 accepted pages ever to
   pages passing admission.
2. **Recipe-order fix + verbatim-target rule + host canonicalization**
   (`#`-strip on both admission paths) — IA 0.50–0.83 → **1.00 everywhere**.
   The single highest-yield finding: the prompt's own recipe listing
   contradicted the validator's hero-first expectation.
3. **One-block skeleton planner** — first paint 9–28s → **5–9s**.
4. **Chunked composer (2–3 blocks/patch)** — first enrichment 25–45s →
   17–20s, page builds progressively.
5. Model selection last — and only latency-shape separated the finalists.

The goal's "50 props will be a mess and slow" intuition, quantified: every
accessible model generates governed JSON at ~170–275 chars/s, so payload
size IS the latency. The winning geometry keeps every critical-path payload
small (skeleton ≈ 1k chars ≈ 4–8s, chunks ≈ 1–1.5k ≈ 5–8s) and lets the
host canonicalize instead of reject. Props stay lean; smartness lives in
the compiler and the recipes, not in the block schema.

Known limits, stated honestly:
- first-patch ≤10s (the strictest contract line) is structurally out of
  reach at these throughputs: planner (≥5s) + first chunk (≥5s) leaves no
  slack. Options if it must be met: overlap composer start with planner
  streaming, or a sub-second-class model for the planner stage only
  (glm-5.1 paints at 4.6s but its completion variance is wild).
- Occasional opencode "malformed response" hiccups — the loop's recovery
  handles them (observed recovering in-run, no trial lost to them).
- Relevance keyword coverage wobbles ±0.2 per trial at k=1; means at k=2
  sit at 0.97. Use k≥2 for any future ratchet on this matrix.

Verification at close: ui-agent+canvas tests 14/14, `bun run typecheck`
0 findings, `bun run scenarios canvas` all scenarios 1.00, exit 0.

## E4 — "can it go faster?" (effort/reasoning knobs, measured)

Hero-block payload (~300–500 chars), sequential probes:

| model | effort | wall times |
| --- | --- | --- |
| gpt-5.6-luna | low / medium / high | 2.6–3.5s at EVERY effort — reasoning is not its bottleneck |
| glm-5.2 | low ×4 | **bimodal: 4.6s, 5.7s, 27.7s, 45s-timeout** |
| glm-5.2 | medium ×4 | uniformly ~15s (7.0, 15.0, 15.7, 15.8) |

**Findings:**
- Dropping/raising reasoning gains nothing on luna (payload + roundtrip
  dominate) and offers no stable win on glm-5.2 (low is a coin-flip between
  5s and 30s+; medium is consistently slow). glm-5.2's fat matrix tails are
  intrinsic gateway variance, not an effort mis-setting — the fallback role
  is exactly right for it.
- Luna emits a complete hero block in ~3s — direct evidence that
  **host-templated manifests** (recipe supplies the manifest, planner only
  writes first-block content) would put first paint at ~3–4s.

## The remaining speed frontier (engineering, not knobs)

1. **Host-templated manifests** — paint 6–9s → ~3–4s (measured basis: E4).
2. **Progressive streaming admission** — parse the start_ui stream, admit
   blocks as they close → paint ≈ first-token + first-block ≈ 2–3s; the
   only path to the <2s contract line.
3. **Parallel composer fan-out** on disjoint slot ranges (isolated child
   conversations; upsert-by-id already safe) — complete ~25s → ~15s.
4. **k≥3 sampling** for any future pin/ratchet decision — the campaign's
   k=1 relevance wobble (±0.2) and glm-5.2's bimodality both demand it.

## E5 — output-format shootout (same content · 6 formats · 3 models · k=2)

Formats: single JSON object (baseline), NDJSON (one block per line), YAML,
indented component DSL (`hero my-id` + `field: value` lines), custom-element
HTML, TOON-style tabular. Probe: `packages/scenarios/format-probe.ts`.

| model | json | ndjson | yaml | dsl | html | toon |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-luna | 7.0s | **6.7s** | 7.3s | 7.6s | 7.9s | 5.4s (1/2 valid) |
| glm-5.1 | 25.9s | 16.3s | 12.1s | **8.7s** | 20.6s (1/2 valid) | 35.8s |
| mimo-v2.5-pro | **0/2 valid** | ~7.5s | ~6.9s | ~7.2s | ~6.8s | 34.1s (slow) |

**Findings (directional, k=2):**
- **Luna is format-invariant** (6.7–7.9s all formats, all valid) — for the
  pinned model, format choice is a SYSTEM decision, not a speed decision.
- **The opencode fleet is heavily format-sensitive**: glm-5.1 emits the
  indented DSL **3× faster than JSON** (8.7s vs 25.9s) — fluency, not char
  count, drives wall time. If the fallback path ever needs speed, the DSL is
  its wire format.
- **HTML loses**: never faster, validity misses on glm-5.1, and it would
  need a tag parser + invites markup drift past the no-HTML-authoring rule.
- **TOON loses**: fewest chars (~900) but slowest wall on opencode + validity
  misses — matches the published research (models lack TOON fluency; savings
  only materialize on large uniform tables).
- Research corroboration: YAML saves only 1–6% tokens vs JSON; format does
  not significantly move accuracy in aggregate (9,649-trial study); TOON's
  syntax-teaching overhead cancels gains on short payloads.

**Format verdict: NDJSON-per-block as the wire format for the streaming-
admission milestone.** Rationale: luna's fastest valid format; every
completed LINE is an admissible block (progressive rendering with plain
`JSON.parse` per line — no partial-JSON parser, no custom grammar); per-block
Schema validation unchanged; ~1.6× faster than single-JSON even on the
fallback fleet. The DSL stays the documented fast path for opencode-only
deployments if one ever exists.

## Harness changes made during the campaign (all in-tree, uncommitted)

- prompts.ts → 5.3.0/6.3.0/3.3.0 (host-contract ordering rules, verbatim nav
  targets, one-block skeleton planner, chunked composer)
- ui-page.entity.functions.ts → `canonicalizeUiBlocks` (nav-target `#` strip,
  shared by both admission paths); toolkit.ts patch_ui now canonicalizes
- ui-agent.test.ts → +1 canonicalization test (8/8 green)
- uiMatrix.ts → composer maxSteps 5
- profiles/streaming-ui-v1.json → version 6.0.0, prompt pins 5.3.0/6.3.0/3.3.0
  (validateUiAgentProfile pins prompts to code constants; canvas would refuse
  to boot otherwise). Model pins still deepseek-v4-flash — TO BE REPLACED by
  the confirmation winner; deepseek-v4-flash is disqualified by E1b/smoke.
- Follow-up owed: canvas.scripted baseline re-mint (prompt-version drift).

## Decisions so far

- `openai-codex`: only `gpt-5.6-luna` is in scope (user directive).
- minimax-m2.7 excluded (broken).
- The optimization axes, in order of expected yield:
  1. shrink the first-paint payload (schema-lean skeleton first, enrich via `patch_ui`)
  2. pick the highest chars/sec model that holds DS/IA quality
  3. per-model prompt tailoring only after 1–2 are settled
