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
for that name; with none it sends no `Authorization` header. An endpoint with
its own key (`apiKey`, or an `apiKeyEnv` that is set) never reads the
credential store, and an empty one (`apiKey: ""`, or a variable set to `""`)
sends no key. From code, pass `apiKey` as `Redacted.make(...)` so it prints
as `<redacted>`; a plain string shows in error messages and the agent's
fingerprint, so JSON configuration names an environment variable instead.
`standardOnly` (default `true`) sends only standard chat-completions fields. An
endpoint whose name matches a built-in provider replaces it. A `local`
credential with a `baseUrl` (stored, or given in `credentials`) routes the same
way, without a key.

## Credentials and storage

The models plugin keeps its credentials (`AuthStore`) and model settings
(`SettingsStore`) in one of two places, chosen by its `storage` option.

**`storage: "local"`** (the default) uses `.efferent` files:

- Credentials live in `~/.efferent/runtime/auth.json` (a login lands there,
  mode 0600), and `<workspace>/.efferent/runtime/auth.json` overrides it per
  provider. With `inheritPrevious` (default `true`), `~/.efferent/auth.json` and
  `<workspace>/.efferent/auth.json` are read as fallbacks; a refreshed
  inherited token is written to the runtime file.
- The settings are the plugin's options (`model`, `fastModel`,
  `fallbackModel`), over the model settings of `~/.efferent/config.json` and
  `<workspace>/.efferent/config.json` when `inheritPrevious` is on. The files
  are read again on every `load`, so an edit applies from the next model call.
  `setRole` and `set` are refused: the options are the source.

**`storage: "memory"`** reads and writes no file, and never looks up the home
directory:

- Credentials come from, later winning: the host's `HostCredentials` (below),
  the API keys of the environment variables `credentialEnv` names (read once,
  when the agent is defined; an unset variable adds nothing), and
  `credentials`.
- The settings start at the plugin's options and are writable: `setRole` and
  `set` change them in memory, checked as the file store checks them.
- `inheritPrevious` is ignored.

```ts
import { Redacted } from "effect"
import { modelsPlugin } from "@xandreed/plugin-models"

declare const anthropicKey: string // the host's own secret

const models = { plugin: modelsPlugin, options: {
  storage: "memory",
  model: "anthropic:claude-sonnet-5",
  credentials: {
    anthropic: { type: "api_key", key: Redacted.make(anthropicKey) },
  },
} }
```

Give a provider a credential only when there is one: an empty key is still a
credential, so the provider's calls would fail at the provider instead of with
the plugin's "no credential" error. A key read from the environment belongs in
`credentialEnv`, which skips a variable that is not set.

JSON configuration cannot carry a `Redacted` value, so it names environment
variables instead:

```json
{ "storage": "memory", "model": "opencode:glm-5.2", "credentialEnv": { "opencode": "OPENCODE_API_KEY" } }
```

`credentials` and `credentialEnv` need `storage: "memory"`; under `"local"`
the options are refused. Every secret in `credentials` (an API key, an OAuth
access or refresh token) must be `Redacted`: a plain string is refused, and
the error never repeats it. `Redacted` values print as `<redacted>` in errors,
logs and the agent's fingerprint, so two agents that differ only in a secret
have the same fingerprint. The plugin reference shows these fields as strings
because that is their JSON shape; TypeScript hosts pass `Redacted` values.

### Credentials the host keeps

A host that keeps credentials itself (a secrets manager, its own database)
provides `HostCredentials` through `Agent.define({ services })`. `load` is read
once, when the agent is defined; `save` receives every change — a login, a
logout (`None`), an OAuth token refreshed in memory — so the host can keep it.
Secrets cross the port `Redacted`.

```ts
import { Context, Effect, Option } from "effect"
import { AuthError } from "@xandreed/core"
import type { ProviderId } from "@xandreed/core"
import { HostCredentials } from "@xandreed/plugin-models"
import type { CredentialInput } from "@xandreed/plugin-models"

declare const vault: {
  readonly read: () => Promise<ReadonlyMap<string, CredentialInput>>
  readonly write: (provider: ProviderId, credential: Option.Option<CredentialInput>) => Promise<void>
}

const services = Context.make(HostCredentials, HostCredentials.of({
  load: Effect.tryPromise({
    try: () => vault.read(),
    catch: (error) => new AuthError({ provider: "*", message: `the vault could not be read: ${String(error)}` }),
  }),
  save: (provider, credential) => Effect.tryPromise({
    try: () => vault.write(provider, credential),
    catch: (error) => new AuthError({ provider, message: `the vault did not save: ${String(error)}` }),
  }),
}))
```

`HostCredentials` needs `storage: "memory"`. A login or logout the host cannot
save fails and changes nothing; a refreshed token the host cannot save is still
used (the old one no longer works) and the failure is logged. Both hold only
for a failure the host reports as an `AuthError`, as above: a rejected promise
bridged with `Effect.promise` is a defect, which the plugin does not catch, so
a failed save of a refreshed token would fail the model call.

### Refresh, lifetime and precedence

An OAuth token for `anthropic` or `openai-codex` is refreshed a minute before
it expires. In memory, one refresh per provider runs at a time, and a login or
logout made while the refresh's token request is in flight wins: the
refreshed token is dropped, and the host never receives it. One made while a
refreshed token is being committed (and handed to `HostCredentials.save`)
waits for that commit, then applies. An expired token of any other provider
fails the call with an `AuthError`.

The memory seeds are read in order, later winning: `HostCredentials.load`,
then `credentialEnv`, then `credentials`. So an OAuth credential in
`credentials` replaces the refreshed one the host saved: after a restart the
plugin starts again from the option's refresh token, which the provider has
already rotated, and the next refresh fails. When the host keeps credentials
through `HostCredentials`, seed OAuth credentials there, not in `credentials`.

The plugin is runtime-scoped: `Agent.define` builds it once, so credentials,
refreshed tokens and settings edits held in memory last for the agent's
lifetime, across turns. They belong to the agent, not to a session: every
session of the agent shares them, so a login, logout, `setRole` or `set` made
in one session applies to all of them. A host serving users whose credentials
or models differ defines one agent for each.

A turn's own services win over the plugin: a `LanguageModel` (or any other
service the plugin provides) in a turn's `services` replaces the plugin's for
that turn. That reaches the turn's own code only. The plugin's `LanguageModel`,
`UtilityLlm` and `ModelCatalog` were built with the plugin's `AuthStore` and
`SettingsStore`, so a per-turn `AuthStore` or `SettingsStore` does not change
the credentials or models they use; to change those for one turn, give the
turn its own `LanguageModel`. The `SessionEnvironment` (the workspace) and
`HostCredentials` the plugin reads come from
`Agent.define({ workspace, services })`; a session-scoped plugin providing
either is refused when the agent is defined.

Hosts composing layers themselves use the stores directly:
`MemoryAuthStoreLive(seed?)`, `MemorySettingsStoreLive(initial)`,
`LocalAuthStoreLive(cwd, home)` and `LocalSettingsStoreLive(cwd, home)`. Each
passes its [conformance kit](/docs/concepts/conformance).

## Images

A user's images (`UserMessage.attachments`) reach the model as image parts on
the routes that take them; on the others the model gets the message's text
and a label line in place of each image (`[image omitted: image/png, 182 KB,
form.png]`).

| Route | Images |
|---|---|
| `anthropic` (Messages API) | image blocks |
| `openai`, `openai-codex`, OpenCode `gpt-*` (Responses API) | `input_image` |
| OpenCode's other models, `google` and configured endpoints (chat completions) | not sent yet: a label line per image |

An image is at most 3.75 MiB and 8000 pixels a side, a message carries at
most 8, they take at most 20 000 000 base64 characters together, and one
request sends at most 8 images, whatever the memory plugins' `maxImages`
says (`MEDIA_LIMITS`): within Anthropic's per-image and per-request limits.

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
