---
title: Plugin configuration
description: Replace services and configure every capability through a validated graph.
---



Base names are `efferent.config.json` and `efferent.config.ts`; having both in
one directory is an error. Global bases live in `~/.efferent/`. TypeScript
exports a default configuration and may export `plugins: Plugin[]` containing
local definitions. JSON resolves `use: "./my-plugin.ts"` or an installed package.
Only trusted configuration modules should be loaded: TypeScript executes code.

The merge order is preset, global base, workspace base, selected profile,
`.efferent/overrides.json`, then invocation. Plugin entries merge by instance
`id`; options merge by key. Changing `use` replaces the prior instance options.
Profile maps and bindings merge by key. An unknown profile is an error.

Removing a required provider fails validation until its dependants are changed too.

`harness.reconfigure(config)` validates and stages the next graph before making
it available. Idle sessions refresh; active sessions refresh before their next
turn. A changed runtime graph returns `restart-required`; the host decides when
to restart. Source TypeScript configuration is never rewritten.

## Model endpoints

The models plugin calls the built-in providers (`opencode`, `google`,
`anthropic`, `openai`, `openai-codex`) with a stored key. To use any
OpenAI-compatible server instead — a local model, a self-hosted gateway — name
it under `endpoints` and select its models as `<name>:<model id>`:

```json
{
  "version": 1,
  "plugins": [
    { "id": "models", "use": "@xandreed/plugin-models", "options": {
      "model": "local:llama3.1:8b",
      "endpoints": {
        "local": { "url": "http://localhost:11434/v1" },
        "gateway": { "url": "https://gateway.example/v1", "apiKeyEnv": "GATEWAY_API_KEY" }
      }
    } }
  ]
}
```

Requests go to `<url>/chat/completions`. The key is optional: the plugin uses
`apiKey`, then the environment variable named by `apiKeyEnv`, then a key stored
for that name; with none it sends no `Authorization` header. `standardOnly`
(default `true`) sends only standard chat-completions fields. An endpoint whose
name matches a built-in provider replaces it. A `local` credential with a
`baseUrl` in `auth.json` routes the same way, without a key.

See the [SDK guide](/docs/concepts/harness) for plugin authoring and lifecycle.
