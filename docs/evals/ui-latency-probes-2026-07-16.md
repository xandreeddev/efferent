# UI-latency probes — 2026-07-16

The two architecture-deciding probes from `docs/agents/ui-latency-plan.md`,
run live against `openai-codex:gpt-5.6-luna` with
`bun run evals:ui-latency-probe` (source:
`packages/scenarios/src/live/latencyProbe.ts`). Both settled on the first
run; raw part timelines and effort verdicts persist in the probe's JSON
output.

## Probe 1 — argument-delta stream parts (`--probe parts`)

Method: `LanguageModel.streamText` through the production router/transport
(the codex WebSocket-as-SSE client), real planner system prompt
(`uiPlannerPrompt`, native-tools), the real `start_ui` tool schema with a
stub handler, effort medium, 2 samples + one `generateText` control.

| sample | first part | reasoning-delta | tool-params-start | tool-params-delta count | settled tool-call | total |
|---|---|---|---|---|---|---|
| 1 | 3,206ms | 10,120ms | 10,129ms | 301 | 12,586ms | 12,599ms |
| 2 | 1,040ms | 3,750ms | 3,774ms | 323 | 13,782ms | 13,846ms |
| generateText control | — | — | — | — | — | 14,235ms |

**Verdict: PASS — Phase 2 (streaming admission) is greenlit on native-tools.**

- The codex subscription route DOES emit `tool-params-start/delta/end`
  through `@effect/ai`'s `streamText`. The part vocabulary is fully decoded;
  our `streamFold` merely passes the parts through today.
- The argument deltas stream over the interval the current pipeline spends
  WAITING for the settled call: 2.5s (sample 1) to **10.0s** (sample 2) of
  head start for an incremental admitter, on top of Phase 1's payload cut.
- Under native-tools there are NO `text-delta` parts at all — every
  pre-tool-call millisecond is reasoning. The v9 harness's
  `firstContentDeltaMs` (text channel) is structurally blind on this path;
  the Phase-0 stage events + the coming `tool-params` stamp are the honest
  replacements.
- `reasoning-delta` arrives as ONE summary blob (count 1), not a token
  stream — reasoning progress is not observable mid-flight on this dialect.
- The `generateText` control (14.2s) matches the streamed totals: identical
  transport, so streaming admission costs nothing on the settled path.

## Probe 2 — reasoning effort floor (`--probe effort`)

Method: raw `response.create` frames over the SAME WebSocket transport
production uses (`OpenAiCodexWebSocketHttpClient`), tiny fixed prompt, 2
samples per effort.

| effort | verdict | wall (2 samples) | output tokens | reasoning tokens |
|---|---|---|---|---|
| none | **accepted** | 1,858 / 1,328ms | 5 | 0 |
| minimal | **rejected** (200 + rejected event) | — | — | — |
| low | accepted | 1,534 / 1,433ms | 5 | 0 |
| medium | accepted | 1,350 / 1,413ms | 5 | 0 |

**Verdict: the effort ladder gains exactly one rung — `none`.**

- `none` is accepted by the subscription dialect and genuinely skips
  reasoning (`reasoning_tokens: 0`). Prompted with a trivial request, low
  and medium also skipped reasoning, so this probe settles ACCEPTANCE only —
  the decode-speed and quality questions belong to the Phase 1 matrix with
  `--efforts none,low,medium` at k≥3.
- `minimal` is NOT accepted (the backend answers 200 with a rejected event —
  the `MalformedOutput` signature). It stays out of the vocabulary.
- The vocabulary was widened accordingly: engine `ReasoningEffort` and the
  ui-agent profile schema now include `"none"`; `reasoningEffortsFor` offers
  it on the probed gpt-5.6 subscription family; non-codex adapters clamp
  `none` to their nearest supported value. Every pinned profile stays
  `medium` — evidence, not this probe, moves pins.

## What this settles in the plan

- **Phase 2 architecture**: build the `tool-params-*` fan-out + incremental
  admitter on native-tools. The text-protocol fallback is NOT needed for
  streaming admission (it remains interesting only as a fallback-fleet
  revival via Phase 1's canonicalization).
- **Phase 1 matrix grid**: include `effort none` candidates alongside
  low/medium — the probe's acceptance evidence makes the run cheap and the
  reasoning block (3.7–10.1s of the measured budget) is the single biggest
  prize after the payload cut.
