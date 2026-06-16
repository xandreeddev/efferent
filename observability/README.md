# Observability (traces + metrics → Grafana)

efferent's production code only **annotates** OpenTelemetry spans, records a few
metrics, and writes structured logs. Where that data goes is a layer choice:

- **Evals** always collect spans **in-memory** to build their report (no Docker
  needed — see `packages/evals`).
- A local **`grafana/otel-lgtm`** stack (one image: OTLP collector + Tempo +
  Prometheus + Loki + Grafana) turns the same telemetry into **trace waterfalls**
  and **metric dashboards**.

## Runbook

```bash
# 1. start the all-in-one stack (Grafana :3000, OTLP :4318 HTTP / :4317 gRPC)
docker compose -f docker-compose.observability.yml up -d

# 2. point the app at the collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# 3a. evals — pushes traces+metrics AND builds the in-memory report
bun run eval --config packages/evals/src/config/baseline.matrix.json

# 3b. a real session — turn export on once, then just use efferent
#     (persisted setting; or set EFFERENT_OTLP=1 for a one-off)
EFFERENT_OTLP=1 efferent "fix the failing test in src/sum.ts"

# 4. open Grafana → http://localhost:3000 (anonymous admin)

# 5. stop
docker compose -f docker-compose.observability.yml down
```

To keep export on for every local session without env ceremony: `:set telemetry on`
in the TUI (persists `telemetry: true` to `.efferent/config.json`).

## What to look at

- **Trace waterfalls** — Grafana → *Explore* → **Tempo** datasource → search.
  TraceQL examples:
  - `{ name = "agent.run" }` — one real session: `agent.run → agent.turn → llm.generate` (+ helper spans `agent.approval.judge` / `agent.headroom.digest` / `agent.title`).
  - `{ name = "eval.run" }` — an eval matrix: `eval.run → eval.suite → eval.case → eval.task → agent.run …` plus `eval.scorer:*`.
  Span attributes carry `gen_ai.request.model`, `gen_ai.usage.*`, `agent.finish_reason`, `eval.score.*`, etc.
- **Metric dashboards** — Grafana → *Dashboards* → **efferent — agent metrics**
  (auto-provisioned from `observability/grafana/dashboards/`): tokens by role,
  LLM calls by model, turn-latency p95, tool calls, approval verdicts, eval scores.

## Notes

- otel-lgtm is **ephemeral** local-dev infra (no volumes) — data resets on `down`.
- Metric names follow the OTel→Prometheus normalization (`gen_ai_tokens_total`,
  `agent_turn_latency_ms_bucket`, …). If a panel shows *No data*, confirm the name
  in Grafana → Explore → Prometheus and adjust the query.
- No Docker? `bun run eval` still prints its trace-derived report from the
  in-memory exporter; only Grafana is unavailable.
