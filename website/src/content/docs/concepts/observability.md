---
title: Observability
description: Trace-first by design — production code annotates OpenTelemetry spans and records a few metrics; export is one layer at the edge.
sidebar:
  label: Observability
  order: 8
---

efferent is **trace-first**: production code only *annotates* OpenTelemetry spans and records a handful of
Effect `Metric`s — it never builds a metrics store. Everything is **inert without a tracer**, so there's
zero overhead when export is off.

## The span waterfall

One trace per user message captures the full execution:

```
agent.run            one per user message — conversation id, prompt excerpt, model, run-total tokens
└─ agent.turn        one loop iteration
   └─ llm.generate   model + token usage + cost + cache-hit ratio + finish reason
   └─ agent.tool     one per tool call — name, ok, args summary
   └─ agent.subagent a spawned run's subtree — node, depth, folder
```

Plus helper spans (`agent.approval.judge`, `agent.headroom.digest`, `agent.title`).

## Metrics

A few RED-style counters/histograms (`gen_ai_tokens_total`, `gen_ai_calls_total`,
`gen_ai_cost_usd_total`, `agent_turns_total`, `agent_turn_latency_ms`, `agent_tool_calls_total`,
`agent_errors_total{kind,error}`, `approval_verdicts_total`). **Bounded tags only** — conversation/node/run
ids and prompts live on *spans*, never on a metric.

## Turning it on

Export is one layer at the edge: `OtlpTelemetryLive` (Effect-native OTLP over HTTP — no heavy OTel SDK in
the bundle). It's gated solely by the `telemetry` setting (`:set telemetry on`; default off). The endpoint
defaults to `http://localhost:4318` (`OTEL_EXPORTER_OTLP_ENDPOINT` overrides *where*, not *whether*).
Provide it at your composition root the same way as any other layer.

Evals export under a separate `service.name` so production and eval traces stay logically split in one
stack. The bundled Grafana dashboards (fleet health, per-conversation waterfalls, eval runs) and the
`:traces` / `:dashboard` deep-links build on these spans.
