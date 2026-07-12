# Observability (current agent line)

Every agent composition root installs `TracingLive("smith" | "math" |
"canvas" | "social")`. It exports Effect spans and metrics through OTLP HTTP
to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). When no
collector is listening, export failures do not interrupt the agent.

```bash
bun run obs:up       # Grafana :3000, OTLP HTTP :4318
bun run smith --cwd <workspace>
bun run obs:down
```

## Current telemetry contract

The production span hierarchy is:

```text
agent.run
└── engine.run
    ├── engine.turn
    │   └── providers.generate
    └── engine.compact

smith.session
└── foundry.run
    └── foundry.attempt
        └── foundry.pipeline
            └── foundry.gate
```

`agent.run` carries `agent.conversation_id`, a prompt character count, and a
redacted prompt field. `engine.run` carries outcome, stop reason, turns, token
usage, tool calls/failures, and correction count. `providers.generate` carries
the resolved model, usage, finish reason, fallback status, and tool names.

Model content is **redacted by default**. Set `EFFERENT_TRACE_CONTENT=1` only
against a trusted local collector to include clipped prompt/reasoning content.
Conversation ids and prompts never become metric labels.

Metrics exported by the new line:

- `llm_usage_input_tokens_total`, `llm_usage_output_tokens_total`
- `llm_requests_total{llm_model,outcome,fallback}`
- `llm_request_duration_milliseconds_bucket`
- `engine_runs_total{engine_outcome,engine_reason}`
- `engine_tool_calls_total{engine_tool,engine_ok}`
- `engine_corrections_total{engine_kind}`
- `smith_judge_verdicts_total{verdict}`

The provisioned production dashboards query this contract directly. The
conversation pages use `agent.run` for identity and structural TraceQL to reach
the nested `engine.run`/`engine.turn` spans.

The local `grafana/otel-lgtm` stack is ephemeral: `docker compose down` removes
its stored telemetry. Dashboard JSON hot-reloads, but provisioning changes may
require recreating the container.
