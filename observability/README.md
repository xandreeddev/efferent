# Observability (traces + metrics → Grafana)

efferent's production code only **annotates** OpenTelemetry spans, records a few
metrics, and writes structured logs. Where that data goes is a layer choice:

- **Evals** always collect spans **in-memory** to build their report (no Docker
  needed — see `packages/evals`).
- A local **`grafana/otel-lgtm`** stack (one image: OTLP collector + Tempo +
  Prometheus + Loki + Grafana) turns the same telemetry into **trace waterfalls**
  and **metric dashboards**.

## Production vs eval — one stack, separated

Real sessions and eval runs share the one stack but never mix:

| | `service.name` | Prometheus `job` | `deployment.environment` | Grafana folder |
|---|---|---|---|---|
| real session | `efferent` | `efferent` | `production` | **efferent — production** |
| eval run | `efferent-evals` | `efferent-evals` | `eval` | **efferent — evals** |

Every production dashboard query filters `{job="efferent"}`; eval dashboards
filter `{job="efferent-evals"}`. `service.name` is the reliable split — the
otel-lgtm collector promotes it to the Prometheus **`job`** label and Tempo
indexes `resource.service.name`. (`deployment.environment` mirrors it for any
env-tag-based filtering; it rides `target_info` in Prometheus and would need a
`* on(job,instance) group_left(deployment_environment) target_info` join — not
used by the shipped dashboards, the `job` filter already separates the two.)

Evals stay **in-memory only by default**; they reach the stack only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Runbook

```bash
# 1. start the all-in-one stack (Grafana :3000, OTLP :4318 HTTP / :4317 gRPC)
docker compose -f docker-compose.observability.yml up -d

# 3a. evals — opt in by pointing them at the collector (evals have no persisted
#     setting; the endpoint env var is their switch), then run a matrix
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  bun run eval --config packages/evals/src/config/baseline.matrix.json

# 3b. a real session — telemetry export is driven SOLELY by the setting. Turn it
#     on once in the TUI (:set telemetry on), then just use efferent normally:
efferent "fix the failing test in src/sum.ts"

# 4. open Grafana → http://localhost:3000 (anonymous admin)

# 5. stop
docker compose -f docker-compose.observability.yml down
```

A real session exports **iff** `telemetry` is on (`:set telemetry on`, persisted to
`.efferent/config.json`; schema default off) — no env var enables it. The endpoint
defaults to `http://localhost:4318`; set `OTEL_EXPORTER_OTLP_ENDPOINT` only to send
somewhere else.

## The dashboards (auto-provisioned from `observability/grafana/dashboards/`)

Folder **efferent — production**:

- **fleet health** (`/d/efferent-fleet`) — the global metrics view, senior-SRE
  shaped: an overview row (spend, turn error rate, cache-hit rate, turns), then
  **RED** (turn rate · error rate by kind · turn latency p50/p95/p99), **LLM &
  cost** (token throughput · cost rate by role · call rate, all `$role`/`$model`
  filtered), and **tools & approvals** (tool success rate · call rate · verdict
  split). All numbers use SI/`$`/`%` units — `100K`/`1.2M`/`$0.0034`, never raw
  digit walls.
- **conversations** (`/d/efferent-conversations`) — the entry point: a Tempo
  table, one row per `agent.run` = **one user message**. Click a **Trace ID** to
  open the full waterfall; click a **conversation id** (data link) to drill in.
- **conversation** (`/d/efferent-conversation?var-conversation=…`) — one
  conversation's messages + its tool calls, each trace opening the waterfall.

Folder **efferent — evals**:

- **eval runs** (`/d/efferent-evals`) — per-suite mean score + pass rate, eval
  spend/tokens/cases, a config table, and a `eval.case` trace table scoped by a
  `$run` id (the `bun run eval` link sets it).

**Navigation flow:** conversations → click a conversation id → conversation
drill-down → click a trace → native Tempo waterfall
(`agent.run → agent.turn <n> → {llm.generate <prompt>@<version> · <provider>/<model>, agent.tool.<name>, agent.subagent <label> → …}`).

## From the CLI

- `:traces` — open the **conversation** dashboard filtered to the active session
  (hints if telemetry export is off).
- `:dashboard` — open **fleet health**.
- Grafana base URL defaults to `http://localhost:3000`; override with
  `:set grafanaUrl <url>` (or `EFFERENT_GRAFANA_URL` for the eval link).
- `bun run eval` prints a deep link to the eval dashboard for that run (only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set — otherwise the data never left memory).

## Spans & metrics

- Spans: `agent.run` (per user message — `agent.conversation_id`, `agent.prompt`,
  `agent.model`, run-total tokens) → `agent.turn <n>` → `llm.generate <prompt>@<version> · <provider>/<model>`
  (`agent.prompt.*`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.cost_usd`,
  `gen_ai.cache_hit_ratio`), plus **`agent.tool.<name>`** (name, ok, `args_summary`),
  **`agent.subagent <label>`** (node/depth/folder), and the helper spans
  `agent.approval.judge:<tool>` / `agent.headroom.digest` / `agent.title`. Eval runs add
  `eval.run → eval.suite → eval.case → eval.task` + `eval.scorer:*`
  (`resource.eval.run_id` on every eval span).
- Metrics: `gen_ai_tokens_total`, `gen_ai_calls_total`, **`gen_ai_cost_usd_total`**,
  `agent_turns_total`, `agent_turn_latency_ms`, `agent_tool_calls_total`,
  **`agent_errors_total{kind,error}`**, `approval_verdicts_total`, and the eval
  metrics `eval_score` / `eval_cases_total`. High-cardinality identity
  (conversation/node/run id, prompt) lives **only on spans**, never on metrics.

> **Note — TraceQL-metrics panels are an enhancement.** The conversation/eval
> trace tables and all Prometheus panels are the reliable backbone; a couple of
> panels use TraceQL metrics (`| quantile_over_time(…)`, `select(…)`) and may
> show *No data* on an older otel-lgtm — that never breaks the dashboard. Confirm
> the Tempo datasource uid is `tempo` and Prometheus is `prometheus` if a Tempo
> panel is empty (Explore → datasource dropdown).

## Notes

- **Picking up dashboard/provisioning changes:** the dashboard *files* hot-reload
  on an interval, but the provider config (`efferent-dashboards.yaml`) is read
  only at Grafana startup, and editing it replaces the file inode — which a
  single-file bind mount won't follow. So after changing the provisioning yaml or
  the dashboard folder layout, **recreate** the container, don't just restart it:
  `docker compose -f docker-compose.observability.yml down && … up -d` (a plain
  `restart` keeps the stale mount). Verify with
  `curl -s localhost:3000/api/search?type=dash-db`.
- otel-lgtm is **ephemeral** local-dev infra (no volumes) — data resets on `down`.
- Metric names follow the OTel→Prometheus normalization (`gen_ai_tokens_total`,
  `agent_turn_latency_ms_bucket`, …). If a panel shows *No data*, confirm the name
  in Grafana → Explore → Prometheus and adjust the query.
- No Docker? `bun run eval` still prints its trace-derived report from the
  in-memory exporter; only Grafana is unavailable.
