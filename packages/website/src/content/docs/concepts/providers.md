---
title: Plugin configuration
description: Configure each plugin's options and replace services through a validated graph.
---



An agent's plugins are configured where it is defined: each entry in
`Agent.define({ plugins })` is a plugin, or `{ plugin, id?, options }`. Options
merge over the plugin's defaults, nested objects key by key (an array, or an
object of another of the shapes the schema allows, replaces its default), and
decode through its schema; undeclared keys are refused. Two providers of one service need a `bindings` entry naming the
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
for that name; with none it sends no `Authorization` header. The variable is
read with Effect's `Config`, from the current `ConfigProvider` (the process
environment unless the host provides another). An endpoint with its own key
(`apiKey`, or an `apiKeyEnv` that is set) never reads the credential store,
and an empty one (`apiKey: ""`, or a variable set to `""` under a provider
that keeps empty values, `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`)
sends no key; the default environment provider reads `""` as unset. From
code, pass `apiKey` as `Redacted.make(...)` so it prints as `<redacted>`; a
plain string shows in error messages and the agent's fingerprint, so JSON
configuration names an environment variable instead.
`standardOnly` (default `true`) sends only standard chat-completions fields.
`images` (default `false`) says the endpoint's models read images: see
[Images](#images). An endpoint whose name matches a built-in provider
replaces it. A `local`
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
- A file that is missing reads as empty. One that cannot be read, or does not
  hold a JSON object, fails every credential call with an `AuthError` of code
  `auth.corrupt` naming the file (and a `config.json` like it, every settings
  load, with a `SettingsError` of code `settings.corrupt`): the plugin never
  takes a damaged file for an empty one and writes over the credentials it
  could not read. Fix or remove the file. An entry it cannot read (from a
  newer version, or with a field of the wrong type) is not used, and is kept
  as it is when the file is written.
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
it expires. In memory and in the files alike, one refresh per provider runs
at a time (concurrent calls share its token request), and a login or logout
made while the refresh's token request is in flight wins: the refreshed token
is dropped, and the host never receives it. One made while a refreshed token
is being committed (and handed to `HostCredentials.save`) waits for that
commit, then applies. A provider that does not rotate the refresh token
leaves it out of its answer, and the stored one is kept; an answer without an
access token or a lifetime fails the refresh with an `AuthError`, which never
quotes the answer. An expired token of any other provider fails the call with
an `AuthError`, which the routed model reports as an `AiError` with an
`AuthenticationError` reason (not retried, no fallback).

The file stores lock each file within one process: every agent the process
defines shares the locks, and each write replaces the file through a temp
file of its own. Two processes that share these files are not coordinated: a
refresh in one can spend the refresh token the other holds, so run one
process over them at a time, or use `storage: "memory"`.

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

## Proxy

When a proxy applies, every call the models plugin makes goes through one
transport: the provider SDKs (`anthropic`, `openai`, OpenCode's `gpt-*`
models), the OpenAI-compatible client (OpenCode's other models, `google`,
configured endpoints), the OAuth token refreshes and the OpenAI
subscription's WebSocket. Its proxy is the plugin's `proxy` option, else the
environment's:

```ts
{ plugin: modelsPlugin, options: {
  proxy: "http://proxy.corp.example:3128",
  noProxy: "gateway.internal.example,10.0.0.0/8",
} }
```

- **`proxy`** is one URL for every target, `http://` or `https://`; a value
  without a scheme (`proxy.corp.example:3128`) reads as `http://`. Empty (the
  default), `https_proxy` (then `HTTPS_PROXY`) serves `https:` targets and
  `http_proxy` (then `HTTP_PROXY`) `http:` ones, lower case first as undici
  and curl read them; an `https:` target falls back to the `http:` proxy, as
  Node's own environment proxy does. The variables are read through
  Effect's `Config` when the agent is defined, so a host's `ConfigProvider`
  decides what the plugin sees. The runtime's own fetch reads the real
  environment, though: Bun's always, Node's under `NODE_USE_ENV_PROXY`. A
  `ConfigProvider` that hides the variables does not keep those fetches from
  using them.
- **`noProxy`** lists hosts that go direct, added to `no_proxy` (then
  `NO_PROXY`) from the environment. Entries are separated by commas or
  spaces: `example.com` (with its subdomains; `.example.com` and
  `*.example.com` mean the same), `example.com:8443` (that port only), an IP
  address (`10.1.2.3`, `[::1]`, `[2001:db8::1]:8080`), a range (`10.0.0.0/8`,
  `fd00::/8`), or `*` for every host, which turns the proxy off.
- **Loopback hosts always go direct**: `localhost` and its subdomains,
  `127.0.0.0/8` and `::1`, so a local model server is never sent to the
  proxy. On Bun this holds for the `proxy` option, not for a proxy in the
  environment (see below).
- A proxy URL may carry credentials (`http://user:pass@proxy:3128`); from
  code, pass it as `Redacted.make(...)`. Error messages show a proxy as
  `http://<redacted>@proxy:3128`, and credentials in any URL the OpenAI-compatible
  client, the OAuth requests or the WebSocket report are redacted too.
- SOCKS proxies (`socks5://`) and `ALL_PROXY` are not supported. A proxy URL
  that is not an `http://` or `https://` URL fails `Agent.define`
  (`config.options`), naming where it came from (`the proxy option`,
  `HTTPS_PROXY`, ...). With `noProxy: "*"` the environment's proxy variables
  are not read at all, so one meant for other tools is left alone.

A call that fails at the proxy says so: `the request to
https://api.anthropic.com through the proxy http://<redacted>@proxy:3128
failed: ...`. On Bun, a proxy that refuses the request with any status other
than 407 (Proxy Authentication Required) is the exception: Bun hands that
refusal (a 403, say) back as the response itself, so it reads as the
provider's own error.

**On Node**, a proxied call goes through undici's `fetch` with a proxy agent
(a CONNECT tunnel for every target) and a direct call through undici's own
direct agent. Node's global `fetch` ignores `HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY` is set. The transport depends on neither that nor the
global dispatcher and agents, so the `noProxy` and loopback hosts stay direct
even when it is set, and with `noProxy: "*"` every call does. Without any
proxy setting the plugin adds no transport: its calls use the runtime's own
fetch, as they did before it knew proxies, and a `FetchHttpClient.Fetch` the
host provides around a turn still reaches the provider SDKs. Corporate
certificate authorities come from `NODE_EXTRA_CA_CERTS`.
A proxy that closes the connection while a tunnel opens fails the call at
once.

**On Bun**, a proxied call passes fetch's `proxy` option. Bun's fetch applies
`HTTPS_PROXY` and `HTTP_PROXY` from the environment by itself, honouring the
environment's `NO_PROXY`: a host that only the `noProxy` option or the
loopback rule exempts still goes through a proxy set in the environment, so
list such hosts in `NO_PROXY` on Bun. For the same reason `noProxy: "*"`
leaves a proxy in the environment in force on Bun: set `NO_PROXY=*` there
instead. On a runtime that is neither Node nor Bun, a proxy setting fails
`Agent.define` instead of being ignored.

**The OpenAI subscription (`openai-codex`)** talks over a WebSocket. When the
proxy applies to `chatgpt.com`, the socket tunnels through it: on Node with an
`https.Agent` and its `proxyEnv` option (Node 24.5 and later, which the
package requires), on Bun with Bun's own `WebSocket` and its `proxy` option
(Bun 1.3.6 and later). Bun 1.3.0 to 1.3.5 cannot tunnel a WebSocket, so there
the call fails with an `AuthenticationError` (not retried, no fallback) instead
of connecting directly past the proxy.

Not covered: the Langfuse and LangSmith exporters make their own requests
(`@xandreed/evals-langfuse`, `@xandreed/evals-langsmith`).

### A transport of the host's own

A host that needs its own HTTP stack (client certificates, a custom agent)
provides `ModelsTransport` through `Agent.define({ services })`: every call
goes through its `fetch`, and the plugin's `proxy` and `noProxy` options are
refused, since they would not apply. Without `webSocketAgent`, the
subscription's WebSocket connects the runtime's default way. A
`webSocketAgent` route of the wrong kind for the runtime (`Agent` is for
Node, `Proxy` for Bun) fails the call rather than connecting past the proxy.

```ts
import { Context } from "effect"
import { ModelsTransport } from "@xandreed/plugin-models"

declare const corporateFetch: typeof fetch // the host's own, with its certificates

const services = Context.make(ModelsTransport, ModelsTransport.of({ fetch: corporateFetch }))
```

The OAuth login helpers (`exchangeAnthropicCode`, `exchangeOpenAiCodexCode`
and the refresh functions) take a `fetch` too. A host that signs in behind a
proxy gives them a transport's:

```ts
import { Effect } from "effect"
import { exchangeAnthropicCode, ModelsTransport, ModelsTransportLive } from "@xandreed/plugin-models"

declare const code: string
declare const verifier: string

const tokens = Effect.gen(function* () {
  const transport = yield* ModelsTransport
  return yield* exchangeAnthropicCode(code, verifier, { fetch: transport.fetch })
}).pipe(Effect.provide(ModelsTransportLive({ proxy: "http://proxy.corp.example:3128" })))
```

`ModelsTransportLive` closes its connection pools with its layer, so provide
it around the whole use, as above.

## Images

A user's images (`UserMessage.attachments`) and the images a tool returns
(`Media` values in its result) reach the model as images on the routes that
take them; on the others the model gets a label line in place of each image
(`[image omitted: image/png, 182 KB, form.png]`), never a provider error.

| Route | A user's images | A tool result's images |
|---|---|---|
| `anthropic` (Messages API) | image blocks | image blocks inside the `tool_result` |
| `openai`, `openai-codex`, OpenCode `gpt-*` (Responses API) | `input_image` | `input_image` inside the `function_call_output` |
| `google` (chat completions), a configured endpoint with `images: true` | `image_url` parts | one user message after the tool messages, each result's images captioned `Images returned by <tool> (call <id>):` |
| OpenCode's other models, `openai-codex:gpt-5.3-codex-spark`, endpoints without `images`, a `local` credential's URL | a label line per image | a label line per image |

A configured endpoint reads no images unless it says so:

```ts
import { modelsPlugin } from "@xandreed/plugin-models"

const models = { plugin: modelsPlugin, options: {
  model: "vision:llava",
  endpoints: { vision: { url: "http://127.0.0.1:11434/v1", images: true } },
} }
```

`imageInputFor(selection)` says whether a built-in route reads images, and
the model catalog states it per model (`input: ["text", "image"]` or
`["text"]`) for the route the model is sent through: a configured endpoint
of a built-in provider's name by its `images`, a `local` credential's URL as
text only. An image is at most 3.75 MiB and 8000 pixels a side, a message
carries at most 8 and a tool result sends at most 4, they take at most
20 000 000 base64 characters together, and one request sends at most 8
images, whatever the memory plugins' `maxImages` says (`MEDIA_LIMITS`):
within Anthropic's per-image and per-request limits. When a provider refuses
a request over an image anyway, the turn omits the images that request sent
(their label lines from then on) and sends the step once more; on
`openai-codex` too, where an `error` event refusing the request before any
other event is the same `InvalidRequestError` an HTTP 400 is.

## Provider errors and reasoning effort

The routed model fails with effect/ai's `AiError`, its reason saying what
went wrong. A rate limit (a 429), a server error, a transport failure or a
timeout is retried three times with backoff, then sent once to the
`fallbackModel` when one is set; anything else fails at once. A 429 whose
`Retry-After` is over a minute counts as a daily quota and fails at once too.

- An exhausted balance or quota is a `QuotaExhaustedError`: a 402, or an
  error whose type or code names one (OpenCode's `CreditsError`, OpenAI's
  `insufficient_quota`), at any status. It is not retried and does not fall
  back. A plain 429 stays a `RateLimitError`, whatever its message says.
- A credential the call cannot have (none stored, a refresh that failed) is
  an `AuthenticationError`: not retried, no fallback.
- A response the provider got wrong (a body or stream chunk that is not
  JSON, `null`, or of the wrong shape, a subscription stream that broke off)
  is an `InvalidResponseError`. The step loop does not answer it with a
  corrective turn: those are for the model's own invalid output (an unknown
  tool, tool arguments that do not parse).
- On `openai-codex`, an `error` event before any other is answered as the
  HTTP endpoint answers it, with its status and error body: a server error
  is a retried `InternalProviderError`, `insufficient_quota` a
  `QuotaExhaustedError`. The server closing the socket normally ends the
  stream; a close before any event fails the call as a transport error. A
  conversation keeps its session id while the agent lives, for up to 1024
  conversations (past that, the one used least recently gets a new id).

The settings' `reasoningEffort` (unless the call pinned a policy of its own)
reaches each route in the vocabulary it takes: `openai-codex` as it is;
`openai`, `opencode` and endpoints with `standardOnly: false` with `xhigh`
and `max` as `high` and `none` as `low`; `anthropic`, `google` and
standard-only endpoints not at all. On `openai` it is sent only to the
models `reasoningEffortsFor` lists, since the others refuse it. Utility calls
(titles, digests, summaries) run on `fastModel` at `fastReasoningEffort`,
else `reasoningEffort`. `generateObject` is routed like `generateText`.

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
`gen_ai.usage.reasoning.output_tokens`), the `engine.run` span the run's sums
as `engine.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`,
and the `agent.turn` span the turn's as
`efferent.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`.
The models plugin's `providers.generate` span puts the model's reasoning in
`llm.reasoning` (its first 500 characters) only when the run captures trace
content (`captureTraceContent`, read per call as `CurrentTraceContent`) or
`EFFERENT_TRACE_CONTENT=1` is set (read with `Config`, from the current
`ConfigProvider`); otherwise it reads `[redacted]`.

That span encloses the whole routed call: its credential, a
`models.credentials` span (an endpoint's own key, or the `AuthStore`'s with a
token refresh included), the provider's build and the request. The counters
and `llm.request.duration` count the request alone, so a credential that
cannot be had counts no request. A `UtilityLlm` completion is a
`models.utility` span around its call's `providers.generate`. Logs written
during a call carry its model as the `llm.model` annotation, never in their
text; the warning before the fallback rung carries `llm.model` (the primary)
and `llm.fallback_model`.

The counts hold three invariants: both cache counts are inside the input, the
reasoning is inside the output, and the total is input plus output. The usage
`agent.turn` returns, the bus `turn.ended` event and the stored `step.usage`
records of a turn always agree.

See the [SDK guide](/docs/concepts/harness) for plugin authoring and lifecycle.
