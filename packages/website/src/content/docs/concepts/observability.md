---
title: Observability
description: OTLP traces with per-turn reasoning and usage, token/latency metrics, a Grafana dashboard, and file logs — one compose file away.
---

Every agent main composes `TracingLive(serviceName)` from providers — the
spans and metrics are always on, and export **silently no-ops** when no
collector is listening. Bring up the local stack and the same run lights up:

```bash
bun run obs:up      # grafana/otel-lgtm: OTLP collector + Tempo + Prometheus + Loki + Grafana
# Grafana on http://localhost:3000 (anonymous admin)
```

## Traces

Three spans tell a run's story: `engine.run` (the whole session turn, with
its outcome, reason, turn count, and total tokens), `engine.turn` (one loop
step), and `providers.generate` (one routed model call — with `llm.model`,
`llm.finish_reason`, input/output tokens, the tool names it called, and the
**clipped reasoning text itself**). A Tempo query answers "what did the model
do and think" without opening the conversation database:

```
{resource.service.name="smith"}
```

## Metrics

The router counts every call into four families, tagged by resolved model:
`llm.usage.input_tokens`, `llm.usage.output_tokens`, `llm.requests` (by
final outcome, after retries), and `llm.request.duration` (a millisecond
histogram from 100ms to the request timeout). The **"efferent — llm"**
dashboard ships provisioned: token throughput per minute, p50/p95 and mean
request duration, requests by outcome — filterable by agent and model.

## Logs

The smith TUI routes Effect's logger to an append-only file
(`<workspace>/.efferent/logs/smith.log`) — a TUI must never write to the
console, and a silent logger means a failed run leaves no evidence. Headless
modes log to stderr, keeping stdout as the event stream.

## In the TUI

The same story renders live: every turn shows its reasoning, its tool calls,
its model, and its spend, and the status strip carries a context-window
gauge (`ctx 17.9k/256k (7%)`) computed from the latest turn's input tokens —
the honest measure of what the context costs right now.
