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

See the [SDK guide](/docs/concepts/harness) for plugin authoring and lifecycle.
