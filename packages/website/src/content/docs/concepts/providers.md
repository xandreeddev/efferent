---
title: Providers — the edge
description: The routed LanguageModel, retries and timeouts, local auth/settings, the SQLite trail, and the telemetry layers.
---

`@xandreed/providers` is where side effects live: `Layer` implementations of
the engine's ports, and nothing an agent composes anywhere but its `main.ts`.

## The routed LanguageModel

`LanguageModelLive` re-resolves the model selection from
`.efferent/config.json` and the credential from `~/.efferent/auth.json` **on
every call** — keys are never captured at layer build, so a `:login` or
`:model` switch applies on the very next turn. v1 providers: the opencode
gateway (a generic OpenAI-compatible client over fetch), Google, OpenAI, and
Anthropic — the latter with subscription-auth support and prompt-cache
breakpoints.

Two hard-won details are baked in:

- The gateway fronts upstreams with **two reasoning vocabularies** —
  `message.reasoning` (kimi-k2.6) and `message.reasoning_content`
  (kimi-k2.7-code, deepseek). The client parses both; these models think by
  default, and dropping either field silently discards the thinking.
- The router stamps the **resolved model id** onto every response's finish
  part — and rebuilds the response as a real `GenerateTextResponse`, because
  its `finishReason`/`text`/`usage` are prototype getters that a `{...res}`
  spread destroys.

## Resilience

Every routed call rides a timeout (300s — thinking models legitimately run
minutes non-streaming), transient-only retries (429/5xx/transport; never a
4xx), and an empty-response rejection: an HTTP 200 with no text, tool call,
or reasoning is a provider failure, not a completed turn. A `Retry-After`
beyond one minute is a daily quota, not an outage — it fails fast instead of
parking the run.

## Stores

`SqliteConversationStoreLive` persists each agent's conversations to its own
database file with atomic positions — the auditable trail everything else
(the TUI's `:resume`, the scenario packs, the run artifacts) reads back.
`LocalAuthStoreLive` and `LocalSettingsStoreLive` own the `~/.efferent`
vocabulary with local-over-global merge.

## Telemetry

`TracingLive(serviceName)` exports the kernel's spans (`engine.run`,
`engine.turn`, `providers.generate` — with the model, token usage, finish
reason, and clipped reasoning as attributes) plus the router's token/latency
metrics over OTLP. `FileLoggerLive(path)` routes Effect's logger to an
append-only file — the TUI must never write to the console. See
[Observability](/docs/concepts/observability).
