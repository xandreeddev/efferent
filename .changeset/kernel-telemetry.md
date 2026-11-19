---
"@xandreed/sdk": minor
---

The kernel's telemetry (ADR 0030): `Sessions.turn` is the span `session.turn` and `callTool` the span
`tool.call`; a model call keeps Effect AI's own span, which `openAiCompatibleModel` now gives the same
`gen_ai.*` attributes as the Anthropic provider (its new `provider` option names `gen_ai.provider.name`), and `planned`
marks each attempt on the span it runs under. `modelAnswer` counts model calls and tokens, `callTool` tool calls, and
the spend charge what the ledger settled. `@xandreed/sdk/kernel/node` exports them over OTLP/HTTP: `otlpTelemetry`,
`otlpTelemetryOver`, `otlpTelemetryFromEnv`, `otlpTelemetryFromEnvOver` and `flushTelemetry`, with a span policy and
a `content` option, off by default, for what was said.
