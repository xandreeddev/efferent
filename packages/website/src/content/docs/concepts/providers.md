---
title: Plugin configuration
description: Configure each plugin's options and replace services through a validated graph.
---



An agent's plugins are configured where it is defined: each entry in
`Agent.define({ plugins })` is a plugin, or `{ plugin, id?, options }`. Options
merge over the plugin's defaults and decode through its schema; undeclared keys
are refused. Two providers of one service need a `bindings` entry naming the
instance to use. The graph is validated before anything activates: invalid
options, missing dependencies, cycles, ambiguous providers and incompatible
plugin API versions are all refused.

## Model endpoints

The models plugin calls the built-in providers (`opencode`, `google`,
`anthropic`, `openai`, `openai-codex`) with a stored key. To use any
OpenAI-compatible server instead — a local model, a self-hosted gateway — name
it under `endpoints` and select its models as `<name>:<model id>`:

```ts
{ plugin: modelsPlugin, options: {
  model: "local:llama3.1:8b",
  endpoints: {
    local: { url: "http://localhost:11434/v1" },
    gateway: { url: "https://gateway.example/v1", apiKeyEnv: "GATEWAY_API_KEY" },
  },
} }
```

Requests go to `<url>/chat/completions`. The key is optional: the plugin uses
`apiKey`, then the environment variable named by `apiKeyEnv`, then a key stored
for that name; with none it sends no `Authorization` header. `standardOnly`
(default `true`) sends only standard chat-completions fields. An endpoint whose
name matches a built-in provider replaces it. A `local` credential with a
`baseUrl` in `auth.json` routes the same way, without a key.

## Token usage

Each model call the step loop makes reports a `TokenUsage`: `inputTokens` (the
full input, cache reads and writes included), `cacheReadTokens`,
`cacheWriteTokens`, `outputTokens` (reasoning included), `reasoningTokens` and
`totalTokens` (input plus output). `agent.turn` returns the turn's total as
`usage`; `turnUsageOf(events, turn)` reads the same total back from a session's
stored `step.usage` records. `uncachedInputTokens`, `usageBreakdown` and
`costOf(usage, price)` (from `@xandreed/core`) derive the uncached input, the
five billed kinds and a cost. Usage recorded before 0.14.0 reads 0 cache-write
and reasoning tokens.

| Provider (route) | Input and cache reads | Cache writes | Reasoning |
|---|---|---|---|
| `anthropic` (Messages API) | `input_tokens` + both cache counts; reads: `cache_read_input_tokens` | `cache_creation_input_tokens` | 0: not reported (thinking is inside `output_tokens`) |
| `openai`, `openai-codex`, OpenCode `gpt-*` (Responses API) | `input_tokens`; reads: `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` when sent | `output_tokens_details.reasoning_tokens` |
| OpenCode's other models (chat completions) | `prompt_tokens`; reads: `prompt_cache_hit_tokens`, `cached_tokens` or `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` when sent | `completion_tokens_details.reasoning_tokens` |
| `google` (OpenAI-compatible API) | as chat completions | as chat completions | 0: not read (Gemini's `completion_tokens` may leave its thoughts out) |
| configured endpoints and `local` credentials | as chat completions | as chat completions | `completion_tokens_details.reasoning_tokens`, whatever `standardOnly` says |

A turn's usage leaves out utility model calls (memory digests and summaries)
and provider attempts that never reached the loop as a decoded response (a
malformed response the loop corrects, a retried or cut-off attempt). The models
plugin's counters (`llm.usage.{input,output,cache_read,cache_write,reasoning}_tokens`
per `llm.model`) count every successful call it routes, utility calls included.
Each step's `engine.turn` span carries its call's usage under the OpenTelemetry
GenAI names (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`,
`gen_ai.usage.reasoning.output_tokens`), and the `engine.run` span the run's sums
as `engine.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`.

The counts hold three invariants: both cache counts are inside the input, the
reasoning is inside the output, and the total is input plus output. The usage
`agent.turn` returns, the bus `turn.ended` event and the stored `step.usage`
records of a turn always agree.

See the [SDK guide](/docs/concepts/harness) for plugin authoring and lifecycle.
