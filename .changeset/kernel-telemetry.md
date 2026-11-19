---
"@xandreed/sdk": minor
---

The kernel's telemetry (ADR 0030): `Sessions.turn` is the span `session.turn` and `callTool` the span `tool.call`;
a model call keeps Effect AI's own span, which `openAiCompatibleModel` now gives the same `gen_ai.*` attributes as
the Anthropic provider (its new `provider` option names `gen_ai.provider.name`), and `planned` marks each attempt on
the span it runs under; a turn the inbox or a task runs on a fiber of its own is a trace of its own. Every kernel
span is named `<part>.<op>` with no `kernel.` prefix. The spend charge counts every call a provider sends, its
tokens and what the ledger settled it at, with that cost's basis; `callTool` counts tool calls.
`@xandreed/sdk/kernel/node` exports them over OTLP/HTTP: `otlpTelemetry`, `otlpTelemetryOver`,
`otlpTelemetryFromEnv`, `otlpTelemetryFromEnvOver` and `flushTelemetry`, with a span policy and a `content` option,
off by default, which keeps what was said, a failure's words among it, in the process.
