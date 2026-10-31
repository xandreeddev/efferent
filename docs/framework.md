# Framework guide

## Runtime model

`Agent.define(config)` (from `@xandreed/sdk`) is the entry point. The runtime
validates the plugin graph, acquires runtime plugins once in the caller's
scope and activates session plugins per turn. Finalizers release resources in
reverse dependency order; a failed activation closes its partially acquired
scope. See [Composable agents](#composable-agents-the-host-composes-the-turn).

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies (and the fiber's settings:
logging, tracing and the current span, the clock); a host service it does not
declare is not there, even one provided around `Agent.define` or `Agent.turn`.
`definePlugin` holds the layer to its declaration: a layer that needs a
service `requires` does not list does not compile (a Reference needs no
entry), a service in `optional` is read with `Effect.serviceOption`, and an
activation that lacks a required service fails with `requires.missing`,
naming the plugin and the service, before the layer is built.
`provideDeclared(owner, requires)` is that check for a host's own extension
point: it runs an effect where it is called once every service in
`requires` (a `ServiceKeys`) is there, so its type needs only those, and
fails with `requires.missing`, naming `owner`, when one is missing.
Two providers of a service require a `bindings` entry selecting the instance
id. Runtime plugins cannot require session services. Dependencies are checked
before activation. An agent whose turns would have no `ConversationMemory`,
`ToolRegistry` or `StepLoop` (none provided by a plugin, none in `services`,
none declared in `turnServices`) is refused by `Agent.define` with
`config.graph`, naming the missing service, rather than failing its first turn.
A `HarnessConfig` names no profiles: the graph does not select one, so a
host folds the selected profile's plugins, bindings and system into the
configuration first, and `resolveGraph` refuses a config that still carries
`profile` or `profiles` (`config.profile`) rather than ignore them.

```ts
import { Layer, Schema } from "effect"
import { definePlugin, SessionEnvironment } from "@xandreed/sdk"

export default definePlugin({
  id: "example/workspace",
  version: "1.0.0",
  // Runtime-scoped, so runtime plugins (the models plugin) may depend on it.
  scope: "runtime",
  config: Schema.Struct({ workspace: Schema.String }),
  defaults: { workspace: "." },
  provides: [SessionEnvironment],
  layer: ({ workspace }) => Layer.succeed(SessionEnvironment, { workspace }),
})
```

A plugin's options are given where the agent is defined, as
`{ plugin, options }` entries in `Agent.define({ plugins })`. They merge over
the plugin's defaults (`mergeOptions`), nested objects key by key:
`{ inbox: { maxPending: 50 } }` keeps the sessions plugin's other inbox
defaults. An array, a string or any other value replaces its default, and so
does an object of another of the shapes the schema allows
(`{ ownership: { mode: "process" } }` over the default lease). The result
decodes through the plugin's schema; undeclared keys are refused.

The SQLite session store uses WAL and transactional sequence allocation. The
models plugin is runtime-scoped: built once per `Agent.define`, with a turn's
own services winning over it. With the default `storage: "local"` it reads
existing model settings and credentials from `.efferent` files as fallbacks
(re-reading the settings on every load). Explicit plugin options and current
credentials win. Set its `inheritPrevious` option to `false` to use an
independent setup; new logins and refreshed inherited credentials are written
to the current credential store. With `storage: "memory"` it reads and writes
no file: credentials come from `credentials` (`Redacted` secrets),
`credentialEnv` or the host's `HostCredentials`, settings are writable in
memory, and `inheritPrevious` is ignored. See the website's providers page,
"Credentials and storage".

Configured model endpoints keep chat completions when `api` is absent or
`"chat-completions"`. Select `api: "anthropic-messages"` for a Messages
compatible gateway. Its `url` is a base: root and proxy prefixes are kept,
a final `/v1` is accepted once, and requests go to `/v1/messages`. `auth`
chooses `"x-api-key"` (default) or `"bearer"`; `apiVersion` sets the version
header, and `betas` merge with the SDK's own flags. Keys remain opaque and
follow `apiKey`, then `apiKeyEnv`, then the credential store. An explicit
empty key sends no authentication. A configured bearer gateway has no
subscription prelude or subscription beta flags. Existing chat endpoints
retain `standardOnly` and default `images: false`; Messages endpoints read
images by default, with an explicit false override.

`modelSettings` maps full `provider:modelId` selections to static Messages
controls: tagged `thinking`, native `effort`, and `limits` (`contextWindow`,
`maxOutputTokens`). It is captured when the models layer is built, separately
from the writable role selections in `SettingsStore`. A call policy takes
precedence over model settings, then the documented profile supplies defaults.
Legacy Haiku 4.5 and Sonnet 4.5 ignore generic policy effort and reject
explicit per-model effort because those profiles support no effort control.
`max_tokens` always comes from that resolution. Unknown or deployment aliases
need an explicit output cap; their undocumented limits are omitted from the
catalog. `ModelCatalogEntry.limits` is provider-neutral metadata, not a measured
context-usage estimate. Per-model controls on another protocol are refused.

```ts
import { Redacted } from "effect"
import { modelsPlugin } from "@xandreed/plugin-models"

declare const gatewayKey: string
const messages = { plugin: modelsPlugin, options: {
  model: "gateway:claude-sonnet-5-5",
  endpoints: { gateway: {
    api: "anthropic-messages", url: "https://gateway.example/proxy/v1",
    auth: "bearer", apiKey: Redacted.make(gatewayKey),
    apiVersion: "2026-10-21", betas: ["thinking-binding-controls-2026-08-01"],
  } },
  modelSettings: { "gateway:claude-sonnet-5-5": {
    thinking: { _tag: "Adaptive", display: "summarized" },
    effort: "high", limits: { maxOutputTokens: 16_384 },
  } },
} }
```

The static profiles include Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5
with documented 1M context and 128K output limits. Supported Adaptive and
Budget thinking default to `display: "summarized"`. Fable 5.x and Opus 5.5
stay adaptive; Sonnet 5.5 supports `BetweenTools` at low/medium/high effort;
Haiku 5.5 and Opus 5 support `Off` at those efforts. Opus 4.7/4.8 default
to Off. `Budget` carries `budgetTokens` (at least 1024 and below the request's
output cap). Known profiles accept it only where documented; an unknown
alias may opt into it with explicit settings. Off and BetweenTools
carry no display, budget or binding fields. Native xhigh/max efforts are
preserved; neutral none maps to low on this route. Unsupported combinations
and forced-tool choices are refused before a network call. The profiles and
constraints follow the [model](https://platform.claude.com/docs/en/models/overview)
and [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
documentation checked on 2026-10-31; family rules for future Fable 5.x IDs are
local policy. The pinned client keeps `2023-06-01` as its default API version;
setting `apiVersion` changes the header. A host transport can add a required
workspace header. Fake-server tests verify bytes and control flow; live
provider acceptance requires configured credentials and versioned evidence.

**Messages prompt caching.** Set `modelSettings[selection].promptCache` to
`{ _tag: "Auto", ttl: "5m" | "1h" }`,
`{ _tag: "TopLevel", ttl: "5m" | "1h" }`, or `{ _tag: "Off" }`.
The default is Auto with five minutes. Auto considers the latest two stable
non-system messages and the last stable system message, preferring recent
history when caller controls leave fewer slots. It excludes the selected
run's volatile step-context tail. A volatile system suffix, which the SDK may
relocate, disables framework Auto additions conservatively.

Caller controls count toward the four effective breakpoints, including
emitted part and nested tool-result controls and the API's top-level control.
The planner runs after the pinned SDK converts the prompt, so shadowed or
skipped markers are not counted twice. One-hour controls must precede
five-minute controls. Auto fills only slots that preserve that order; it
never changes a caller's lifetime or upgrades its own five-minute default.
Invalid caller controls, a fifth effective caller breakpoint, or conflicting
lifetimes fail locally before HTTP. Controls must be plain own enumerable
data; accessors, inherited fields and custom serializers are refused because
they can serialize a different value from the one validated.

TopLevel selects the API's automatic last-block control, including a volatile
last block when the host chooses this mode. It does not select the earlier
stable cut. An existing caller top-level control takes precedence; a matching
explicit final-block lifetime shares its slot, while a different lifetime is
refused. Off adds nothing and still preserves and validates caller controls.
For a Messages gateway that cannot accept cache fields, set endpoint
`cacheControl: false`: it overrides framework caching, refuses non-null
caller controls and omits SDK-generated null cache fields. Application data
and tool-schema properties named `cache_control` are preserved.

Helper completions use the same per-model policy. These controls and tests
establish request behavior, not cache hits: live hits require a sufficiently
large identical prefix and positive provider cache-read usage. Aggregate
usage does not distinguish write lifetimes, so mixed-lifetime cost estimates
remain approximate. The slot and lifetime rules follow the
[provider caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
checked on 2026-10-31.

**Typed model failures.** `ModelFailureKind` names a failed model request
independently of its provider. The step loop exposes these framework codes:

| Kind | Failure code |
|---|---|
| `ContextOverflow` | `model.context-overflow` |
| `Authentication` | `model.auth` |
| `InvalidRequest` | `model.invalid-request` |
| `RateLimit` | `model.rate-limit` |
| `Quota` | `model.quota` |
| `Transient` | `model.unavailable` |
| `InvalidResponse` | `model.invalid-response` |
| `Timeout` | `model.timeout` |
| `Unknown` | `model.failed` |

`modelFailureOf(value)` accepts a native `AiError`, its reason, a response
part or a content array. It reads an explicit neutral failure stamp before
the known Effect AI reason families; `modelFailureCodeOf(kind)` returns its
framework code. It does not unwrap `HarnessError.cause`: read a returned
turn error's code with `harnessCodeOf`. `stampPartFailure`,
`stampResponseFailure` and
`stampAiErrorFailure` let an adapter preserve that meaning. Failure, model
and usage metadata coexist under `ENGINE_KEY`; outgoing prompts strip this
bookkeeping, apart from the temporary volatile-context marker consumed by
the provider adapter. Core does not search provider messages or arbitrary
causes. The models plugin interprets structured provider evidence before
generic status or message fallbacks. A bare HTTP 413 indicates request size,
not token-context overflow; an explicit context code or narrow context-window
evidence is needed to classify overflow.

The adapters preserve concrete `AiError` and reason classes, their getters,
HTTP context and provider metadata. An error-channel failure reaches the
turn in `HarnessError.cause`; a stamped response failure retains the failed
response as its cause. Native Anthropic HTTP 200 overflow stops and raw SSE
failures are intercepted before SDK finish normalization and framework tool
dispatch. Their causes retain the raw response/event, request id and known
usage, with request credentials omitted from the added diagnostic context.
Already published stream deltas cannot be retracted. Ordinary `max_tokens`
cuts retain the bounded output corrective and `loop.truncated`; content-filter
finish reasons remain cuts, while provider content-policy errors are invalid
requests. The provider documents the distinction between
[output-limit and context-window stops](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
and [HTTP errors, byte limits and errors after an SSE 200](https://platform.claude.com/docs/en/api/errors).

Context, authentication, invalid-request, quota and invalid-response failures
do not trigger provider retry, configured fallback or the loop's pre-content
stream fallback. Rate-limit, transient and timeout failures keep the existing
retry timings; a long `Retry-After` can make the current policy decline a
retry without proving exhausted quota. Unstamped malformed model output
keeps its corrective contract. The existing image-omission replan remains
available. Existing `TurnError` tags remain unchanged,
and unrelated unclassified loop failures still use `loop.failed`.

When a proxy applies, every call the models plugin makes (the provider SDKs,
the OpenAI-compatible client, OAuth token refreshes, the OpenAI subscription's
WebSocket) goes through one `ModelsTransport`, built from the plugin's `proxy`
option, else `https_proxy` / `HTTPS_PROXY` and `http_proxy` / `HTTP_PROXY`
(read through Effect's `Config`), with the `noProxy` option and `NO_PROXY`
hosts and loopback going direct. On Node it goes through undici with its own
agents (Node's own fetch ignores those variables unless `NODE_USE_ENV_PROXY`
is set, and the transport does not depend on it). On Bun it goes through
fetch's `proxy` option; Bun's fetch applies a proxy from the environment by
itself, so there only `NO_PROXY` exempts a host from that one. The routed
model provides the transport's fetch as `FetchHttpClient.Fetch` innermost on
every call, so an ambient one cannot route a call past the proxy. Without a
proxy the plugin adds no transport, and the calls use the runtime's fetch as
before. A host gives its own transport through `Agent.define({ services })`.
See the website's providers page, "Proxy".

## Evals

For typed datasets, reusable evaluators, task/journey composition and native prompt
examples, see [Composable evaluations](composable-evaluations.md).

A `Journey` is a fixture and an ordered list of actions whose payloads belong to
the application's codec. The application's runnable performs the actions against
a fresh, scoped environment and records each observation through the trial's
`TrialRecorder`; graders score the recorded outcome. Typed
`Dataset<Input, Reference>` cases become tasks (`tasksFromDataset`), with
reference labels kept out of execution and available only to evaluators.

`@xandreed/evals` supplies a generic Schema domain for tasks, trials, candidates, runnables, journeys, graders, grading contexts, outcomes, suites and grader calibrations. Apps implement execution adapters, scoped environments and per-grader evidence projections. The shared runner keeps references out of execution, persists partial transcripts and terminal outcomes, and grades stored evidence independently.

`@xandreed/evals-cli` is the local Node 24 command line. Langfuse and LangSmith are separate optional official SDK export packages; reports work without credentials or provider availability. Retrieval ranking and typed semantic graders are reusable. Ordinary model/prompt comparisons are suites; calibration specifically measures grader agreement.

See [evaluation-domain.md](evaluation-domain.md) for interfaces, lifecycle, commands and package ownership.

## Distribution

`@xandreed/core` publishes three entries. The root holds the entities, ports,
events, journal kinds, `define*` helpers, errors, model-text frames,
References and in-memory adapters (the turn's event bus and tasks among
them); `@xandreed/core/conformance` the port kits (`check` builds a kit's
check); and `@xandreed/core/internal` what the first-party packages share
with core: the provider mapping, stream fold, tool schemas and id helper,
and what the sdk's turn engine reads of core. The root and `./conformance`
are semver; `./internal` is not. The root does not repeat what a subpath
holds: a kit is imported from its entry. The turn engine is
`@xandreed/sdk`'s (`TurnLive` and the turn's lifecycle, from its root), and
so is the `ToolRegistry` kit, which runs its turns over that engine
(`@xandreed/sdk/conformance`). The credential and settings stores
(`AuthStore`, `SettingsStore`) are the models plugin's own ports:
`@xandreed/plugin-models` exports them, and
`@xandreed/plugin-models/conformance` their kits.

The sdk's root names each of its exports: `Agent` (`AgentConfig`,
`AgentPluginEntry`), `agentTaskExecutor`, the turn engine, and the names of
core a host writes beside `Agent`, re-exported so that defining an agent and
running its turns imports one package. Those are a turn's input
(`UserMessage`, `mediaFromBytes`, `mediaFromBase64`, `RunId`,
`ConversationId`, `SessionAddress`, `TurnInput`, `NewTurn`), the turn and its
result (`Turn`, `TurnPolicy`, `TurnOutcome`, `TurnResult`), the sessions
(`Sessions`, `SessionLog`, `SessionLogMemoryLive`, `TurnAdmission`,
`TurnAdmissionOpen`, `TurnRefused`), the host's capabilities and plugins
(`defineTool`, `defineSkill`, `definePromptSection`, `defineCapability`,
`Capability`, `definePlugin`, `publishToolProgress`, `Failure`, `Media`,
`SessionEnvironment`, `ActionPolicy`, `PermissionGrants`), the turn's events
(`TurnEvent`, `TurnEventOf`, `TurnEvents`, `TurnEventsService`, `onEvent`,
`onTool`, `subscribeAll`, `defineHostEvent`, `AssistantMessage`,
`TurnEndedData`, `turnEndedOf`), its errors (`HarnessError`, `isHarnessError`,
`harnessCodeOf`, `TurnBeginError`, `turnBeginCodes`, `TurnError`,
`isTurnError`, `turnEndingOf`) and the process's activity (`awaitIdle`,
`processActivity`). Everything else of core is imported from
`@xandreed/core`, the same values: there is one core.

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`, leaving test code out (`*.test.*`, `testing` modules and
folders). `bun run verify:packages` refuses a build that is not of `HEAD`, was made
from a tree with changes (unless `--allow-dirty`), holds test code, or whose published
entries export other names than `api/` records (`bun run api:update` rewrites it); it
packs them, installs them in a temporary external project through a temporary local npm
registry, checks it holds one copy of `@xandreed/core` and of `effect`, and exercises
SDK sessions, replacement plugins, persistence, forks and custom evals on Bun,
then imports every published entry of every Node-capable package on Node
(and checks a deep import of core is refused); before packing it checks that
each package's declarations import only itself, its dependencies and peers
and the runtime's modules. It also runs the `FileSystem`
and `Bash` kits over the packed `@xandreed/plugin-workspace` adapters, loads a
`SKILL.md` tree through the packed skills directory plugin, and runs an agent
turn in which a scripted model reads, edits and runs a command through the
workspace tools, and flushes a turn's `agent.turn` span and its usage and cost
metrics through the packed `@xandreed/plugin-telemetry` to a local OTLP
collector, on both Bun and Node. Publishing is a separate release action:
`bun run publish:packages` checks the build stamp (`.artifacts/packages/build.json`)
against the current commit and a clean tree, then publishes in dependency order; it is a
dry run unless `--publish` is passed (see [publishing](../CONTRIBUTING.md#publishing)).

## Traces and metrics

The packages record spans and metrics through Effect's own `Tracer` and
metric registry, outside evals too. Nothing is exported until the host
provides an exporter around its program: `@xandreed/plugin-telemetry`'s
`OtlpTelemetryLive({ baseUrl })` (or `OtlpTelemetryFromEnv()`, configured by
the standard `OTEL_EXPORTER_OTLP_*` variables) posts traces and metrics over
OTLP/HTTP with Effect's own exporters (`effect/observability`), and a
serverless host flushes before it responds (`flushTelemetry`). The same
package's `telemetryPlugin` records each turn's token usage by billed kind,
its cost at the host's prices, tool calls, refusals and durations, steps and
stream fallbacks as metrics, and the turn's usage and refusals as events on
its `agent.turn` span. See the website's
[observability](../packages/website/src/content/docs/concepts/observability.md)
page for the options, the environment variables and the metrics.

**The span tree.** Each turn `Agent.turn` runs is one trace subtree under the
caller's span, if any:

```text
agent.turn.begin                 Agent.turn beginning the turn: session plugins activated, Sessions.begin
agent.turn                       Agent.turn, or a host's composition with traceTurn(writer)
├─ engine.run                    one run of the step loop (turn.run)
│  └─ engine.turn                one step (engine.step is its one-based number)
│     ├─ LanguageModel.*         effect/ai's span of the model call
│     │  └─ providers.generate   the models plugin's call (model, usage, finish reason)
│     │     └─ models.credentials  the call's credential, a token refresh included
│     └─ loop.tool_call          one tool call the loop ran (engine.tool, engine.tool.call_id)
│        └─ tool.<name>          the tool registry's call, refused calls included
│           └─ (the handler's own spans)
└─ turn.persist_reply            the turn's reply recorded as it ends (guardTurn), failed or not
```

`agent.turn` starts once the turn is admitted (after `Sessions.begin`; a turn
that could not begin has no `agent.turn`) and encloses the turn-dependent plugins,
the host's layer, the tools opened, `use`, the reply and the end. It carries
`efferent.session.id`, `efferent.run.id`, `efferent.turn`,
`gen_ai.conversation.id` (the session), `efferent.origin` (user, inbox or task)
and, on a resume, `efferent.resumes` (the turn it resumes),
and ends with `efferent.outcome` (completed, partial, failed or interrupted,
`turnEndingOf` the turn's exit; a turn cancelled or reaped while it ran
shows as failed with `turn.closed`, its `TurnClosed`'s code), `efferent.failure.code` when the turn
failed or was interrupted (`turn.interrupted`), and the turn's usage as
`efferent.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`:
the `TurnResult`'s when it returned, what its provider calls spent before it
failed otherwise (`guardTurn` records that on the span it runs under).
Every span under it carries the first three, so a backend can find a turn's
spans by session, run or turn. The turn's metadata (`NewTurn.meta`) stays
out of the trace unless the agent names keys in `spanMeta`: each named key
the turn has becomes `efferent.meta.<key>` (a string, number or boolean as
is, anything else as JSON). A host composing its own turn wraps everything
after its begin in `traceTurn(writer, { spanMeta })` to get the same span.

`agent.turn.begin` is the turn's sibling under the caller's span: `Agent.turn`
opens it when it begins the turn itself (a turn the host began, its
`TurnWriter` passed in, has none), around the session-scoped plugins'
activation and `Sessions.begin`. It carries `efferent.session.id`,
`efferent.run.id` and `efferent.origin`, and ends with `efferent.turn` once
the turn begins, or with `efferent.failure.code` when it cannot: the
refusal's code as `harnessCodeOf` gives it (`session.busy`,
`turn.duplicate`, `session.missing`…), the code `agent.turn` would have
ended with (`turn.defect` or `turn.interrupted` otherwise). A host
composing its own turn wraps its begin in
`traceTurnBegin({ session, runId, origin })` (a `TurnBeginTrace`); the work it
wraps returns the writer, or a value holding the admitted turn under
`admitted`.

**Ids in logs.** Logs carry the ids as annotations, under the span
attributes' names (`turnAttributes(admitted)`, `sessionAttributes(session)`):
`Agent.turn` annotates everything after the begin with
`efferent.session.id`, `efferent.run.id` and `efferent.turn`, a line a tool
handler, a plugin or the host's `use` logs included, and the begin with the
first two.

Spans nest where their work runs, not where a context was captured. The
framework captures contexts to run work later (the services a tool handler
runs with, a policy's callbacks, a model layer's dependencies, the services
`Turn.run` replays, a bus subscriber's, the turn's `TurnInput.services`)
and drops the trace and log state of where it captured them before
providing them again (`replayableContext`): the parent span
(`Tracer.ParentSpan`), the span annotations and links, the log annotations
and log spans, the captured span's stack frame, and `CurrentTraceContent`
(`Agent.turn` keeps one the turn's `TurnInput.services` carry, see trace
content). A tool call stays
under its step, in its own `loop.tool_call` span, and a handler's spans under
its `tool.<name>`, a host span wrapped around `turn.run` is the parent of its
`engine.run`, a model layer built under a span does not pull its calls
there, and annotations the host set where it built a layer or captured the
turn's services (`Effect.annotateSpans`, `Effect.annotateLogs`) do not
replace the turn's ids. An
inline bus subscriber's spans nest under the publisher's. A parent span in
`TurnInput.services` or `AgentConfig.services` is ignored: to put a turn
under another span, wrap the `Agent.turn` call in `Effect.withParentSpan`.
The in-process task runner is the exception: it starts each piece of work
on a new fiber with the services it was built with, so the work nests under
the span current where the runner was built. Host code that captures a
context to provide it later passes it through `replayableContext` too.

The memory and tasks plugins add spans where their work runs: `memory.open`
(each memory session a turn opens), `memory.summarize` and `memory.digest`
(each call to the summarizer or the digester, failed when it fails or runs
out of time), `tasks.<op>` (each `Tasks` method) and `task.run` (a task's
work). The task spans and the tasks plugin's logs carry `efferent.session.id`
(the parent session's) and `efferent.task.id`; the ids stay out of the log
messages.

**Metrics** (Effect `Metric`s, exported with the spans' exporter):

| Metric | Attributes | Counts |
|---|---|---|
| `efferent.turns` | `efferent.outcome` | turns `Agent.turn` ran, once admitted |
| `efferent.turn.duration` | `efferent.outcome` | each such turn's time from admission to its end, in milliseconds; for a turn the host began (its `TurnWriter` passed in), from when `Agent.turn` took it to when `Agent.turn` returned, before the host ends it |
| `engine.runs` | `engine.outcome`, `engine.reason` | step-loop runs |
| `engine.tool_calls` | `engine.tool`, `engine.ok` | tool results in a whole response: the calls the loop ran, and any the provider ran itself (a cut response's, answered without running, are not counted) |
| `engine.corrections` | `engine.kind`: `malformed`, `reply-cut`, `degenerate-nudge`, `stream-fallback`, `media-rejected` | the loop's self-corrections (its answer to a reply cut at the output limit among them), a stream falling back and a step sent again without the images a provider refused included |
| `llm.requests` | `llm.model`, `outcome` (`ok`, `error`), `fallback` (`true` for the fallback model's call, `false` otherwise; non-streamed calls only) | the models plugin's calls, after retries, utility calls included |
| `llm.request.duration`, `llm.usage.*_tokens` | `llm.model` | the same calls' time and tokens |

No metric carries a session, run or turn id: those are on the spans.
`telemetryPlugin` adds `efferent.llm.tokens` (by `efferent.model` and
`efferent.token.kind`: `input`, `cache_read`, `cache_write`, `reasoning`,
`output`, summing to each response's total), `efferent.llm.cost`,
`efferent.steps`, `efferent.tool.calls`, `efferent.tool.duration`,
`efferent.tool.refused` and `efferent.stream.fallbacks` (`TelemetryMetrics`).

**Trace content.** Prompts and responses stay out of spans unless a run
captures them: `engine.step.input` (the exact prompt and the active tools)
and `engine.step.output` (the response content and usage) on each
`engine.turn`, and the models plugin's `llm.reasoning` (the model's
reasoning, first 500 characters; `[redacted]` otherwise). A run captures them
when its policy's `captureTraceContent` says so, else the agent's
(`AgentConfig.captureTraceContent`), else the `CurrentTraceContent`
reference where the run starts (provided around `Agent.turn`, inside `use`,
or in the turn's `TurnInput.services`; one in `AgentConfig.services` is
ignored); all are off by default. The step loop
provides the run's choice as `CurrentTraceContent` to everything the run
calls, and the models plugin reads it per call (`EFFERENT_TRACE_CONTENT=1`
still turns `llm.reasoning` on for the whole process). An image is never
traced: a prompt's `file` part keeps its media type and the length of its
data, a `Media` value its fingerprint. Hosts own consent, masking and
exporter retention. A tool call's parameters are the exception: effect/ai's
toolkit writes them, with the tool's name, on the span the call is handled
under (`tool` and `parameters` on its `loop.tool_call`), whatever the run
captures.

```ts
const agent = yield* Agent.define({ ...config, captureTraceContent: false, spanMeta: ["requestId"] })
yield* agent.turn(input, (turn) => turn.run({ captureTraceContent: true }).pipe(/* … */))
```

Capturing trace content does not modify the message buffer, tool arguments,
persistence callbacks or cancellation scopes. A timed-out evaluation awaits scoped
cleanup; browser/provider adapters must bound their own finalizers rather
than leave paid work running in disconnected fibers.

## Token usage

Every provider response the step loop handles is one `assistant.message`
event carrying a `TokenUsage` and why the response ended (`finishReason`),
and is stored as one `step.usage` record (step, model, usage, and the finish
reason since stored format 2; a record stored before has none):

| Field | Counts |
|---|---|
| `inputTokens` | the full input: uncached input, cache reads and cache writes |
| `cacheReadTokens` | input read from the provider's prompt cache |
| `cacheWriteTokens` | input written to the provider's prompt cache |
| `outputTokens` | the full output, reasoning included |
| `reasoningTokens` | output spent on reasoning |
| `totalTokens` | `inputTokens + outputTokens` |

The invariants: `cacheReadTokens + cacheWriteTokens <= inputTokens`,
`reasoningTokens <= outputTokens`, `totalTokens = inputTokens + outputTokens`,
no count below 0. `extractUsage` (the loop's reading of a response) and
`tokenUsage(counts)` (the constructor for hand-built usage, such as a
`UtilityCompletion`'s) hold them: an output reported below its reasoning is
raised to it, and an input below its cache counts likewise. The rest are
functions, not stored fields: `uncachedInputTokens(u)` is input minus both
cache counts; `usageBreakdown(u)` splits a usage into the five kinds a call
is billed by (`input` uncached, `cacheRead`, `cacheWrite`, `reasoning`, and
`output` without its reasoning), each at least 0 and summing to
`totalTokens`; `costOf(u, price)` prices them with a `ModelPrice`
(per million tokens; `reasoning` is optional and falls back to the output
price). `addUsage`, `sumUsage` and `zeroUsage` add usages up.

```ts
const result = yield* agent.turn(input, (turn) => turn.run({}).pipe(
  Effect.map((run) => ({ outcome: run.outcome, reply: Option.some(run.text) }))))
const cost = costOf(result.usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
```

Where the counts appear:

- `RunResult.usage`: one run of the step loop (`turn.run(policy)`), the sum
  of its `assistant.message` usage. A `StepLoop` must return exactly that sum
  (`stepLoopConformance` checks it).
- `RunContext.usage` and `Turn.usage`: the turn's running total, every run
  of it included.
- `TurnResult.usage`, returned by `Agent.turn` (and by `guardTurn` in a
  host's own composition): the turn's total. The bus `turn.ended` event
  carries the same total, but only a subscription still open when it is
  published sees it (see [the turn as services](#the-turn-as-services)).
- `turnUsageOf(events, turn)`: the same total read back from a session's
  stored events, the turn's `step.usage` records summed. `turnConformance`
  checks that it equals `TurnResult.usage`. The stored `turn.ended` record
  carries no usage.
- Spans: the `engine.turn` span of each provider step carries the call's
  usage under the OpenTelemetry GenAI names: `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
  `gen_ai.usage.cache_creation.input_tokens` and
  `gen_ai.usage.reasoning.output_tokens`. The `engine.run` span carries the
  run's sums under efferent's names,
  `engine.usage.{input,output,cache_read,cache_write,reasoning,total}_tokens`,
  so a backend that sums `gen_ai.usage.*` over a trace does not count a step
  twice. effect/ai's own `LanguageModel` span of each call carries the same
  input and output counts (the `anthropic` and `openai` providers set them;
  `@effect/ai-anthropic` names cache writes
  `gen_ai.usage.cache_write.input_tokens` there): sum one level, not both.
  The models plugin's `providers.generate` span carries
  `llm.usage.{input,output,cache_read,cache_write,reasoning}_tokens`, and
  the same names are counters per `llm.model`. It encloses the call's
  credential (`models.credentials`, a token refresh included) and the
  provider's build, which the counters leave out; a `UtilityLlm` completion
  is a `models.utility` span around it. Logs written during a call carry
  `llm.model` as an annotation, not in their text.

A turn's usage counts what the step loop received. It does not count calls
outside the loop: a memory digester's or summarizer's `UtilityLlm` calls
(their `UtilityCompletion.usage` goes to their caller; the models plugin's
counters do include them). Nor does it count a provider attempt the loop
did not take as its step's response: a malformed response the loop
corrects, or an attempt that failed (one the models plugin retried, a
stream cut off after its first part). A provider may bill those, so a
turn's usage can be below the provider's invoice. A response cut short is
counted: its step publishes its `assistant.message`.

Records written before 0.14.0 have no `cacheWriteTokens` or
`reasoningTokens`; they decode with 0 (`step.usage`, the usage stamp on a
stored assistant message, `assistantUsage`). Their `inputTokens` already
held any cache writes, so `uncachedInputTokens` of such a record counts the
writes as uncached input.

What each provider reports:

| Provider (route) | Input and cache reads | Cache writes | Reasoning |
|---|---|---|---|
| `anthropic` (Messages API) | `input_tokens` + both cache counts; reads: `cache_read_input_tokens` | `cache_creation_input_tokens` | not reported: 0 (thinking is inside `output_tokens`) |
| `openai`, `openai-codex` and OpenCode `gpt-*` models (Responses API) | `input_tokens`; reads: `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` when sent, else 0 | `output_tokens_details.reasoning_tokens` |
| OpenCode's other models (chat completions) | `prompt_tokens`; reads: `prompt_cache_hit_tokens`, `cached_tokens` or `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` when sent, else 0 | `completion_tokens_details.reasoning_tokens` |
| `google` (Gemini's OpenAI-compatible API) | as chat completions | as chat completions | 0: not read (Gemini's `completion_tokens` may leave its thoughts out) |
| configured chat endpoints and `local` credentials | as chat completions | as chat completions | `completion_tokens_details.reasoning_tokens`, whatever `standardOnly` says |

## Host-planned initial tool batch

`runLoop` accepts optional `initialStep: [{ name, params }]`. A host can classify
from a finite plan set or construct a structured plan, validate the whole batch
against its permissions and references, and persist its decision before calling
the loop. The loop uses an in-memory Effect AI response, ending `tool-calls`, to
dispatch the batch through the same check of every call and the same instrumented
toolkit as a provider's response, without a provider request. The initial batch
counts as step zero; completion, concurrency, events, errors and tail persistence
follow the ordinary loop path.

```ts
const result = runLoop({
  system: instructions,
  messages: history,
  toolkit,
  initialStep: [{ name: "search", params: { query: "example" } }],
  maxSteps: 5,
  onTail: persistTail,
})
```

The host must reject unsupported calls, dependencies on future results and unsafe
publication before execution. Initial planning attempts are the host's provider
measurements. The dispatch span marks `engine.step.host_planned` and
`engine.step.usage_available=false`; it does not stamp invented provider usage onto
persisted messages. Omitting `initialStep` preserves ordinary loop behavior.

### Inspectable host decisions and continuation models

`@xandreed/core` exports the `DecisionRecord` schema, and `recordDecision`
journals one on the current turn (`decision.recorded`). A record names the
finite candidates, context/candidate hashes, policy version, provider attempt
IDs, selection, host validation, applied fallback and optional reported
probabilities. Hosts own capture, redaction, storage, candidate eligibility and
validation.

`runLoop` accepts an optional `prepareModel` hook (a turn exposes it as the
`model` function of its `TurnPolicy`):

```ts
runLoop({
  system: baseInstructions,
  messages,
  toolkit,
  initialStep: acceptedCalls,
  prepareModel: ({ stepIndex, messages, activeTools }) =>
    chooseContinuation({ stepIndex, messages, activeTools }),
})
// chooseContinuation returns an Effect of
// { model: LanguageModel.LanguageModel, system: Prompt.Prompt }.
```

The hook runs at a provider step after any initial batch, with its actual tool
results in `messages`. It does not run when the batch completes the task. Both
settled and streaming execution use the selected model and native Effect prompt.
A host wanting one route per turn caches the result in its scoped service. The
loop still validates/adopts tools through its normal host-controlled toolkit.

Each step runs in two parts. It executes: the call, the tools and the tail,
which `onTail(messages, step)` persists under the step. It settles:
`onStepSettled(step, status)` runs exactly once, with that execution's exit
(`completed`, `failed`, `cancelled`, `malformed` or `truncated`). Then the
loop decides: `isComplete(step)`, a query that is never asked after a
malformed or a truncated step, the degenerate-loop breaker, compaction and
steering. A corrective, a nudge or an in-memory steer goes through `onTail`
under the next step, and only when that step runs: a run the step cap, the breaker or
completion ends records none. A `StepLoop`'s `RunResult` says the same as a
union: `completed` with the reason `completed`, or `partial` with
`step-cap` or `degenerate-loop`. Durable input has a separate probe and
take: `StepRequest.pendingSteers` checks after settlement, and
`StepRequest.steer(step)` commits exact user messages after that next
`step.started`, before its plan, including step zero. The returned messages
are already durable and are never passed through `onTail` again.
`runLoop` exposes the same pair as `durableInput: { pending, take }`.

`limits.degenerate` controls repeated-result protection. Its default is
`{ _tag: "Enabled", nudgeAfter: 3, breakAfter: 5 }`; choose
`{ _tag: "Disabled" }` to leave repeated results to the step cap. Enabled
thresholds are positive bounded integers, with the nudge before the break.
Pollable tools do not count. `limits.malformedLimit` defaults to 3: the third
consecutive unusable reply fails the run, so at most two corrective replies
are sent. Set it to 1 to fail on the first malformed reply. A cut reply and
a malformed reply reset each other's streak. These policies never bypass
`maxSteps`, and a final step appends no unread nudge or corrective.

**The step's response.** A provider's response ends with a finish reason
(`FinishReason`, effect/ai's list), which says whether it is whole: `stop`
(the model finished), `tool-calls` (it calls tools and waits for their
results) and `pause` (the provider paused a long reply) are; `length` (the
output limit), `content-filter`, `error` and `other` cut it short.
`unknown` (the provider gave no finish reason) cuts it short only when it
holds tool calls the loop would run (a call the provider ran itself,
`providerExecuted`, is not one): a reply of text alone, or an empty one,
without a finish reason completes as before. Every `assistant.message`
carries the reason as `finishReason`, and its `step.usage` stores it, since
stored format 2.

The loop runs a response's tool calls itself: the model call is made with
`disableToolCallResolution: true` and `toolCallValidation: "deferred"`, so
it returns the response with its calls neither run nor checked. Once the
response is whole, the loop checks every call it would run: it names a
tool the step has, and its parameters decode with that tool's schema (a
tool whose parameters are a JSON Schema, not an Effect Schema, checks its
own). Only when all of them pass do the calls run, through the step's
toolkit, up to `toolConcurrency` at once (`runLoop`'s default is 4; a
turn's `limits.toolConcurrency` defaults to 1), their results in call order. When one does not, none of them runs: the step ends
`malformed`, and the loop answers it with the corrective for the first call
that failed (a tool the model does not have, or parameters that do not
match, with what it wrote).

A response cut short runs none of its calls, and its calls are not checked:
each is answered, as the call's result, with a failure the model reads,
`{ error: "ReplyCut", message }`, whose message says how the reply ended and
that this call was not run (for a reply cut at the output limit, `Your reply
reached the output limit, so this call was not run. Call it again if you
still need it.`). The response and
those answers are recorded under the step, its `assistant.message` is
published, and it ends `truncated`, with no `completion.evaluated`.

A reply cut at the output limit (`length`) is answered with a corrective of
the loop's, a host note recorded under the next step, at most twice in a
row (any step not cut resets the count, and a cut step likewise resets the
loop's count of malformed replies in a row). A reply holding tool calls the
loop would run is told that the calls it made were not run, and to call the
tools it still needs again, fewer in one reply and with less text before
them; any other is told to continue from where it stopped, in replies short
enough to finish. The next step's input is then built as
after any step the run goes on from: within-run compaction (`compact`, over
the next messages and the cut step's usage, its plan applied only at an
assistant message, with a `compaction` event), then steering
(`pendingInput`, its message recorded under the next step). A third cut in
a row, or any other cut, fails the run with a `HarnessError` of code
`loop.truncated`. At the step cap, a reply cut at the output limit that
would be answered ends the run `partial` instead, with no corrective
recorded. A `pause` continues the run, as a call to tools does: the next
step carries on the reply.

A reply cut at the output limit while a tool call's arguments were still
being written reaches the gate only where the provider adapter keeps the
unfinished call: the models plugin's chat completions client does (with
empty parameters, never run). effect/ai's Anthropic and OpenAI adapters
fail such a reply before its finish part, with a
`ToolParameterValidationError` for the call, so on those routes the loop
answers it as a malformed reply, with its corrective, not as a cut one.

**The run's text across a continuation.** The run's text (`finalText`,
`RunResult.text`) is its last reply's. A reply the run continues, one cut
at the output limit holding no tool call the loop would run (answered with
the corrective to continue), or a paused one, is carried instead: the next reply that is
neither sets the run's text to the carried text followed by its own, and
the carry starts over (when both are empty, the run's text stays what it
was). A cut reply that held tool calls the loop would run carries nothing:
the model replies anew. When the step cap ends the run while text is
carried, the run's text includes the carried text.

**Finish reasons on the wire.** The models plugin's chat completions client
(OpenCode's models other than `gpt-*`, `google`, configured endpoints and
`local` credentials), settled and streamed, decides a response's finish
reason from the wire's `finish_reason` before it decodes its tool calls'
arguments. The word is read whatever its case: `stop`, `tool_calls`,
`function_call`, `tool_use`, `tool_call`, `end_turn`, `stop_sequence` and `eos`, or none at all
(`null`, or a stream that ended without one), mean the response ended on
its own, `tool-calls` when it holds tool calls and `stop` when it does not;
`length` and `max_tokens` are `length`; `content_filter` is
`content-filter`; `error` and `insufficient_system_resource` are `error`;
any other word is `other`. In a cut response, a tool call whose arguments
do not parse is kept, with `{}` as its parameters, since the loop runs none
of a cut reply's calls; in a whole one, such arguments still fail the
response with an `InvalidOutputError`, which the loop answers as a
malformed response.

The callbacks run with the caller's services and fail with its error:
`RunLoopOptions<Tools, E, R>`. A callback's failure fails the step it runs
in (the step settles `failed`), or the run once the step settled, as that
failure, typed; the run fails with `E`, a provider's `AiError` or a
`HarnessError` (`loop.truncated`, a reply cut short that the loop does not
correct). The step loop passes a turn's `TurnError` through them as it is,
and fails a turn's run with `loop.truncated` as it is too (a `HarnessError`
is a `TurnError`).

`@xandreed/evals` provides `DecisionTrial`, `SelectionObservation`,
`compareDecisionTrials` and `selectionMetrics`. Comparisons pair case/repetition,
bootstrap scenario groups, preserve infrastructure failures, and leave missing
costs/intervals unavailable. Choice Brier scores require a unique categorical gold
label; multiple acceptable options support accepted-error metrics but have no
unique Brier target. These helpers return evidence for a host report; they do not
promote a model or apply application-specific quality/cost policy.

## Composable agents: the host composes the turn

A composable agent is a plugin graph built once and a turn the host writes
as ordinary Effect code. Mechanisms are plugins; meaning (tools, views,
skills, step context, completion) is the host's.

| Concern | Port | Plugins |
| --- | --- | --- |
| Session storage | `SessionLog` (the host provides it) | `SessionLogMemoryLive` (core), `SessionLogSqliteLive` (`@xandreed/plugin-session-sqlite`), or the host's own |
| Sessions, turns and the inbox | `Sessions` | `@xandreed/plugin-sessions` |
| Turn admission (budgets) | `TurnAdmission` | `TurnAdmissionOpen` (core), or the host's |
| Background tasks | `Tasks` (over the host's `TaskRunner` and `TaskExecutor`) | `@xandreed/plugin-tasks` |
| Busy signal (optional) | `TurnActivity`, `TaskActivity` | `@xandreed/plugin-sessions`, `InProcessTaskRunnerLive` (`@xandreed/plugin-tasks`) |
| Memory strategy | `ConversationMemory` | `@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary` |
| Tool digests | `ResultDigester` (optional) | `@xandreed/plugin-memory-digest` |
| Tool registry and discovery | `ToolRegistry` | `@xandreed/plugin-tool-discovery` |
| Files and commands | `FileSystem`, `Bash` | `localSystemPlugin` from `@xandreed/plugin-workspace`, `FileSystemMemoryLive` (core), or the host's own |
| Step iteration | `StepLoop` | `stepLoopPlugin` from `@xandreed/plugin-agent-loop` |
| Host definitions | `Capabilities` (multi-provider) | `AgentConfig.capabilities`, or any plugin that `contributes` |
| Pre-turn skill selection | `IntentMatcher` (optional, per turn) | any matcher service |

**Defining the agent.** `Agent.define(config)` (from `@xandreed/sdk`) resolves
the graph and activates its runtime plugins once, in the caller's scope.
Session plugins, if any, are activated per turn with the turn's services.
Session plugins requiring `RunContext`, `TurnEvents`, `TurnTasks`,
`TurnMemory`, `TurnPrompt` or `TurnToolbox` activate after `TurnLive`, in a
scope of their own, before the host's layer (which can use their services)
and before the user's message is taken by memory: a context entry they
record at activation (`TurnMemory.context`) waits for the message. Their
dependent plugins activate in the same phase. They finalize once the turn's
body and the host's layer are done, while the turn's services are still
open. On success, work from the body, its finalizers, the host's finalizers and
the plugins' finalizers settles at each dependency boundary before the final
reply is recorded. Memory, registry and loop providers activate first: a plugin
requiring the services of an already-open turn cannot also provide those
foundations. Runtime plugins cannot require turn services. This lets a
capability ship a session plugin that installs its reactions without coupling
the loop to the capability's domain.
Swapping a strategy is swapping one entry. The host builds one `Sessions`
(see [Sessions](#sessions-one-log-per-session)) and gives the agent the same
instance its own code uses, in `services`.

```ts
const sessions = yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(
  Layer.provide(Layer.merge(SessionLogSqliteLive(".efferent/runtime/sessions.db"), TurnAdmissionOpen)),
))
const agent = yield* Agent.define({
  services: sessions,                      // Sessions: where every turn is begun and written
  plugins: [
    { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } },
    { plugin: toolDiscoveryPlugin, options: { grants: ["public"], maxCallsPerRun: 16 } },
    stepLoopPlugin,
    memoryDigestPlugin,                      // session scope: digests on the turn's UtilityLlm
  ],
  capabilities: [appTools],               // tools + views + skills + prompt sections
  turnServices: [LanguageModel.LanguageModel, UtilityLlm],
  cacheKeyPrefix: "app",                   // prompt-cache key `app:<conversation>`
  budgetTokens: 24_000,
})
```

**One turn.** `agent.turn(input, use)` opens memory and tools for one admitted
turn and hands `use` a `Turn`: `userMessage`, `admitted` (the turn as the
session admitted it, the host's `meta` included), `memory` (read-only), `events`,
`tasks`, `tools` (`match`, `apply`, `select`, `activate`, `active`),
`context(entry)`, `reply(text)`, `run(policy)`, `usage`, `flush` and
`write(op)`. The turn is scoped: subscriptions and tasks end with it. On
success, tasks and background subscriptions settle before the reply is
recorded. The reply is recorded exactly once, with a `failed` outcome when
`use` fails, is interrupted, or finalizer work fails. It is stored with the
turn's end, in one commit right before `turn.ended` (`TurnWriter.closing`),
so the journal never holds a reply without its end: a reaction to the reply
that fails, or a drain an interruption cuts, fails the turn and stores the
reply failed, its text kept. On failure or
interruption, the original cause is preserved and pending tasks are
interrupted when the turn's scope closes. Once `use` has returned, its reply
is recorded even when the turn is interrupted then; a cancelled turn does
not wait for the background reactions to its failed reply, and a failed one
waits for them ten seconds at most. On success `agent.turn` returns a
`TurnResult`: the `TurnOutcome` `use` returned (`outcome`, `reply`), the
turn's `usage`, every run's provider calls summed (see
[token usage](#token-usage)), and, for a turn it began and ended, `pending`:
the inbox items its end left waiting (a background task's result delivered
while it ran), which its caller drains (see [the inbox](#sessions-one-log-per-session)).

`input.turn` is either a turn the host already began (the `TurnWriter` from
`Sessions.begin`: the host ends it, after its own closing records) or a
`NewTurn` (`{ session, userMessage, runId, key?, command?, meta?, resumes? }`) that the agent
begins through the `Sessions` in its services and ends. With `resumes: n`
the turn resumes turn `n`, a turn that was cancelled or interrupted, and
its key defaults to `resume:<n>` (see [resuming a turn](#resuming-a-turn)). A
turn that cannot begin fails with the refusal itself, a `TurnBeginError`
(`SessionBusy`, `TurnDuplicate`, `KeyConflict`, `RunIdReused`,
`NotResumable`, `TurnRefused`, `AttachmentRejected` for an image the turn
cannot take, see
[Images and multi-part messages](#images-and-multi-part-messages),
`SessionMissing`, `SessionContended`, `SessionLogError`), before anything
is opened, run or counted: match one with `Effect.catchTag("SessionBusy", …)`,
and read what it names from its fields (the open turn, whether a duplicate
still runs, why a turn cannot be resumed). `harnessCodeOf` gives the code
each stands for (`session.busy`, `turn.duplicate`, `turn.key-conflict`,
`turn.not-resumable`, `turn.refused`, `turn.attachment-rejected`…; all of
them are `turnBeginCodes` from `@xandreed/core`, also exported by `@xandreed/sdk`, with suggested HTTP statuses
in the [event reference](event-reference.md#begin-codes)); a turn someone else
closes (a cancel, a reaped lease, a removed session) fails with that
`TurnClosed` (`Effect.catchTag("TurnClosed", …)`; its `reason` says which,
its code is `turn.closed`).

**The host's metadata.** `meta` is a JSON object the host attaches to a
turn: a request id, a client, a tenant. It is stored in the session's
`turn.started` (only when given, so turns without it are stored as before),
given to `TurnAdmission` (`TurnToAdmit.meta`), and shown on the writer's
`admitted`, on `RunContext.admitted` and `Turn.admitted` (with the turn's
number, key, origin, command, claimed inbox items and, on a background
task's turn, its `task`) and on the bus
`turn.started` event; it is `{}` when none was given. The model never sees
it, and it is not part of the idempotency key's fingerprint (the message,
the command and `resumes` are): a retry with the same key and other
metadata is still `TurnDuplicate`. `Sessions.drain(address, run, { meta })` begins its
inbox turns with it.

**How a turn ends.** A turn the agent began is ended with
`turnEndingOf(exit)` (from `@xandreed/core`), the turn's exit as the stored
`turn.ended`; the code of a failure is `harnessCodeOf` its error:

| The turn | `reason` | `failure.code` |
| --- | --- | --- |
| returned an outcome | `completed`, `partial` or `failed`, as `use` returned | none |
| failed with a `HarnessError`, or another tagged error with a string `code` (`AuthError`) | `failed` | the error's own code, with its message |
| failed with a begin refusal, `TurnClosed`, `ReservedKind` or a `SessionLogError` | `failed` | the code its tag stands for (`TAGGED_CODES`: `session.busy`, `turn.closed`, `events.reserved`, `session.log`, ...), message `<_tag>: <message>`, its fields as JSON when it has none (a `SessionLogError`: its own message) |
| failed with any other error, an untagged one with a `code` included | `failed` | `turn.failed`, message `<_tag>: <message>` (or the error as text) |
| died with a defect | `failed` | `turn.defect` (`Agent.turn` first turns a `TurnError` carried as a defect back into a failure, which keeps its own tag and code) |
| was interrupted, and nothing failed | `interrupted` | `turn.interrupted` |

An error wins over an interruption in the same cause, and messages are cut
to 500 characters. On success, a store failure while ending fails the turn,
so the caller never reports a turn completed that is not stored as ended;
on failure the end is tried once, its own failure ignored, and the turn
fails with its own cause. Either way, an end that could not be stored is
tried again by the writer's scope when it closes, with the same ending (so
the stored code stays the turn's own, not `turn.unended`). A turn whose
fiber is interrupted is ended by its writer's scope instead, as
`interrupted` with `turn.interrupted`. A host ending its own writer, or
composing a runner by hand, uses the same function:
`writer.end(turnEndingOf(exit))`, with `harnessDefectsAsFailures` applied
before taking the exit so a `TurnError` carried as a defect (`isTurnError`)
keeps its code.

A prompt is text sent to a model; the user's message is a `UserMessage` value
(`new UserMessage({ text, attachments })`: text, images or both, never
nothing), and every field or parameter holding it is named `userMessage`. The
memory log stores its text under the original `prompt` key and its images,
only when it has some, under `attachments`, so existing logs decode and their
fingerprints do not change. See [Images and multi-part
messages](#images-and-multi-part-messages).

**Per-turn host services.** `input.layer` is a layer the turn builds inside
its scope, after `RunContext`, `TurnEvents` and `TurnTasks` exist, so it may
require them. The turn provides the result to `use`, tool handlers, policy
callbacks, subscriptions and tasks: `yield* AnswerState` anywhere in the turn
gets the same per-turn instance. The type of `agent.turn` removes what the
turn provides from `use`'s requirements.

```ts
class AnswerState extends Context.Service<AnswerState, AnswerStateService>()("app/AnswerState") {}
const answerStateLayer = Layer.effect(AnswerState, RunContext.pipe(Effect.flatMap(makeAnswerState)))

const userMessage = new UserMessage({ text })
yield* agent.turn({ turn: { session, userMessage, runId }, services, layer: answerStateLayer }, (turn) => Effect.gen(function* () {
  const quick = yield* quickReply(turn.userMessage)              // no loop, still a recorded turn
  if (Option.isSome(quick)) return yield* turn.reply(quick.value)

  const state = yield* AnswerState                               // the same instance the tools see
  yield* subscribeAll(turn.events, [
    onTool(Search, ({ result }) => state.remember(result)),     // typed by the tool's own schemas
    onTool(Deliver, ({ input }) => state.deliver(input.text)),
  ])
  yield* turn.tools.select(turn.userMessage)                     // always-on skills + the matcher's choice
  const result = yield* turn.run({
    step: (step) => state.directive(step),                       // step context and tool choice
    completion: () => state.verdict,                             // { complete, awaiting, facts }
    limits: { maxSteps: 6, requireCompletion: true },
  })
  return { outcome: result.outcome, reply: yield* state.reply }
}))
```

`TurnPolicy` holds plain functions: `initial` (a host-planned first batch, run
without a provider call), `model` (a model and prompt variant per step),
`step`, `completion`, `limits`, `budgetTokens`, `stepContext` (`tail` or
`system`) and `correctives`. A verdict whose `awaiting` names task tags joins
those tasks and is evaluated once more. No provider call follows a complete
verdict.

A turn may run the step loop more than once (`turn.run` again, after the
first run's verdict). Each run takes the turn's next ordinal
(`TurnMemory.startRun`: 0 for the first, `RunRef` carries it with the
turn's run id and number), and its step contexts, request headers and step
events (`step.started`, `step.ended`, `assistant.message` and its stored
`step.usage`, `completion.evaluated`, `context.built`, `stream.fallback`)
carry it as `run`; a record written before runs were counted reads 0. A
run's request shows that run's own step context, never an earlier run's,
and each run's requests rebuild from their own headers. The ids the loop
mints for a provider's tool calls that come without one are
`<turn>.<ordinal>.<step>:<tool>:<n>` (`toolCallIdOf`), and those of a
host-planned batch `<turn>.<ordinal>.planned:<n>` (`plannedCallIdOf`), so
they differ across the runs and turns of a session.

**The token budget.** `budgetTokens` is the target memory keeps each request
under: the system prompt, the active tools' schemas and the messages,
estimated together. It is not a provider limit, and nothing is cut to fit a
model's context window. The agent's `budgetTokens` (64 000 by default) is
checked by `Agent.define` and fails with `config.budget` unless it is an
integer of at least 1 (`BudgetTokens`, `isBudgetTokens`); a policy's
overrides it for one run, checked when the run starts (`turn.budget`). At
the turn's start the memory strategy is given the whole budget. At each
step the system prompt and the tool schemas are reserved first, and the
memory strategy gets the rest for the messages; when they leave nothing,
the step fails with `context.budget`. What the strategy does with the
budget it is given is its own: the window strategy compacts older turns,
spills the current turn's largest results and drops the oldest turns to
fit, and fails with `context.budget` when the current turn alone does not;
the summary strategy summarizes once the messages pass its `triggerRatio`
of it and keeps its `keepRatio`; the digester ignores it. Every step's
`context.built` records the run's `budgetTokens` beside `reservedTokens`
and the messages' `estimatedTokens`.

**Events and tasks.** `TurnEvent` is one typed union: `turn.started`,
`step.started`, `tool.started`, `tool.refused` (a call the registry refused
before its handler ran: the tool is inactive, a permission is missing, the
host's `ActionPolicy` denied it, or a call limit is reached),
`tool.progress` (transient), `tool.completed` (decoded result and encoded
form), `step.ended` (the recorded results by entry id, refused calls
included), `completion.evaluated`, `skills.activated`, `context.built`,
`decision.recorded`, `assistant.message`, `assistant.delta` (transient),
`stream.fallback` (a streamed call failed before its first part, and the run
goes on without streaming; a refusal over an image is no stream failure: it
has no fallback, and the turn sends the step again without the images,
`onMediaRejected`), `turn.ended`, and host events from
`defineHostEvent`; the [event reference](event-reference.md) lists each
one's payload, who publishes it and how it is stored, and the
[events guide](events.md) shows how to use them: streaming a turn to a
client, which subscription sees `turn.started` and `turn.ended`, refused
calls, host events, and following a session over HTTP. Every call the
registry handles has its `invocationId` (`<runId>:call:<n>`), a refused one
too: its `tool.refused` carries it, and a call that runs shares it across
`tool.started`, `tool.progress` and `tool.completed`. A host event may not
take any of these names, nor a kind the journal stores (`RESERVED_KINDS`):
its publish fails with `events.reserved`. A tool handler reports progress with
`publishToolProgress(channel, text)` (`stdout` or `stderr` for a command's
output as it arrives, `status` for anything else): it reads
`CurrentToolInvocation`, which the tool registry sets around each call, so
the event carries the call's `step`, `invocationId` and `tool`, the ids of
its `tool.started` and `tool.completed`; outside a tool call it does nothing.
The invocation and every `tool.*` event also carry an optional `toolCallId`,
the provider's pairing key from the assistant's tool call and its result.
When the provider omits it, the loop assigns a deterministic id distinct
across the session's turns, runs and steps. A direct call through the
toolkit may omit it. `onTool` passes it to the subscriber too;
`tool.started`, `tool.refused` and `tool.completed` keep it in the journal.
Publication is inline
and ordered, depth-first up to a cap: every subscriber runs before `publish`
returns, so state a subscriber changes is visible to the next step, and a
subscriber failure fails the turn (one during a tool call, on `tool.progress`
or an event the handler publishes, also stops the handler; the model never
sees it as the tool's result). Within a step the order is `step.started`
< `assistant.message` < `tool.*` < `step.ended` < `completion.evaluated`.
The assistant response is durable before its event is published; each
`tool.started` is flushed before its handler runs. Each final tool result
is stored as it returns, while sibling calls may still be running. Each step ends once, when
its own call, tools and tail are done, with their status: `completed`,
`failed`, `cancelled`, `malformed` (a response the model could not form,
a tool that does not exist or parameters that do not decode, which the loop
answers with a corrective turn; none of its calls ran, and it has no
`assistant.message` and no `completion.evaluated`), or `truncated` (a
response cut short: its `assistant.message` says why in `finishReason`,
none of its calls ran, each answered as cut, and it has no
`completion.evaluated`). What the loop decides afterwards (the completion
verdict, compaction, steering) cannot change that status: a completion that
fails fails the run and leaves the step `completed`. Nothing is recorded
under a step after its `step.ended`: the loop's own messages, a corrective, a
nudge or a steer, are recorded under the next step, which reads them. Nothing
is recorded under a step that never starts: a run that the step cap or a
complete verdict ends records no corrective or nudge for a next step.
Background work goes to `turn.tasks.fork(tag, effect)`.

A subscription can instead run in the background:
`subscribe(select, handle, { mode: "background" })`, or the same option on
`onEvent`, `onTool` and a host event's `on`. It gets its own bounded queue and
fiber. `publish` returns once the event is queued, and the handler sees events
in publication order. When the queue is full (`capacity`, 256 by default),
`publish` waits for room, interruptibly wherever it runs; a background
handler's own publications (to its own subscription or another's, and what
it runs inline) never wait but are queued past the capacity, so a handler
that publishes what it takes cannot deadlock, its reaction chains bounded by
`maxEventDepth`. A failed background handler is latched: the next
delivery to it fails, and so does the drain before `turn.ended`, which fails
the turn. Use it for reactions whose effects the next step does not need,
and for forwarding events to a client: one background subscription keeps
them in order, and its handler must neither fail nor wait on the client
without a bound (the [events guide](events.md#handlers-must-not-fail-or-block)
has a push that does neither).

**Where it is stored.** The turn's `TurnWriter` is the bus's first
subscriber: every event except the transient ones (`assistant.delta`,
`tool.progress`) is stored in the session's
log under its own kind (see the vocabulary below), `tool.completed` keeps
neither the input nor the result, which memory holds, and `tool.refused`
keeps no input. Events and memory
entries go through the writer's one ordered write-behind queue. Producers
queue and go on; one writer fiber stores items strictly in queue order,
consecutive appends in one commit. The turn waits only at flushes:
`turn.flush` returns once everything queued before it is committed, and
`turn.write(op)` runs a host write in the same order and returns its result.
The first failed write is latched, so the turn fails at its next write.
Closing the turn's scope drains the queue before the writer stops, also on
interruption. Memory builds every request from the session's earlier turns
(read once, when the turn opens) and what this turn recorded, never by
reading the log back mid-turn.

**Memory.** Every message, tool result, turn context, step context, skill
activation, digest and compaction decision is an entry in the session's log
(a `memory.*` event, the turn's `turn.started` and its `turn.reply`) with its
own id (`<runId>:<n>`). Every request is a pure fold of that log, so
a request rebuilt later (another process, a restart) is byte-identical to the
one the model saw. A call's params, a provider-run tool's result and provider
options go out with their keys sorted at every depth (`toPromptMessages`,
core's canonical order), so a past call has the same bytes in the turn that
made it, in every later turn and in a rebuild, and a provider's cached prompt
prefix holds. A strategy decides compactions and digests (`maintain`)
and records them before they apply; it applies only its own compactions, so
a new strategy rebuilds from the full-fidelity entries.

- The window strategy keeps the current turn verbatim and shows earlier turns
  through each tool's compact view. Under budget pressure it spills the
  current turn's largest results to a preview plus a locator, then replaces
  the oldest turns with a ledger. `recall_context` reads a spilled result
  back a page (`RECALL_PAGE_CHARS`, 8,000 characters) at a time from an
  `offset`, each page ending with the offset of the next, and a recalled
  page is never spilled again. It fails
  with `context.budget` only when the current turn alone does not fit the
  budget it is given: the whole budget at the turn's start, and what the
  system prompt and tool schemas leave of it at each step.
- The summary strategy folds the oldest turns into one recorded summary once
  the render passes its trigger. It reads the `UtilityLlm` where its session
  is opened (the turn), so summaries run under the turn's budget, and fails
  with `memory.summary` without one. The summarizer is given the folded
  turns as a transcript of at most 120,000 characters (`digestTranscript`)
  and any earlier summary, each in its own tag and marked as data
  (`summaryPrompt`); the model is shown the summary inside
  `<conversation-summary>` tags after a host note that calls it a record of
  the earlier turns, not instructions (`handoffToMessage`). A summarizer
  call that fails or takes longer than `summaryTimeoutMs` (60 s) is logged
  and decides nothing: the turn goes on with what memory holds (an earlier
  summary still applies), and the summarizer is not asked again in that
  turn.

Digests of several results run concurrently (`MemoryPolicy.digestConcurrency`,
four by default) and are recorded in the order of their results.

A tool owns how its result appears: `render`, `compact`, `subjects`,
`artifacts` (image and file references by URL, always rendered as reference
lines), `media` (which of the `Media` values the result holds the model is
sent as images, every one by default; see [Images and multi-part
messages](#images-and-multi-part-messages)) and
an optional `digest`. A `Select` digest keeps whole items by key and
re-renders them, so every identifier an answer may cite survives. A
`Summarize` digest is accepted only when every `preserve`d identifier appears
in the summary; the `DigestTask` carries them (`preserve`), and
`@xandreed/plugin-memory-digest` lists them for its model. The strategy
decides when (on write above a size, or at compaction); the `ResultDigester`
runs the tool's own prompt for the latest `userMessage` (a log without one
digests nothing); the outcome is logged once as a `ToolDigest` entry and
never recomputed on replay. A digest that fails records nothing and the
result keeps its view; the digest plugin frames the request and the result
as data, keeps them within `maxSourceChars`, and logs a call that fails or
takes longer than `digestTimeoutMs` (30 s).

**Durable model requests.** Before each real provider step, the turn writes
and flushes `request.prepared`. This protocol record carries the complete
active tool declarations, tool choice, system text, public requested model
configuration, prompt cache key, call policy, the optional frozen stable-prefix
message count, the memory strategy's render
recipe/version and the build's memory cut (`through`, the last memory entry
the build folded). Messages remain in their original memory events. Each
header is self-contained, repeating the full system text and every active
tool's declaration at every step: a deliberate storage trade-off, so that one
header and the memory before it rebuild a request. A provider-defined tool's
args are kept only as their key names and the SHA-256 of their canonical
JSON, since they can carry credentials; a change of any value still
diverges. A dispatch reads what storage holds (the history memory was opened
over, then only the events stored since its last read, so a step's read
grows with that step, not the session), folds the memory entries up to the
cut with the saved recipe, and compares the resulting prompt and header with
the actual Effect AI request. A memory write after the build (a reaction to
`context.built`) is outside the cut: the next step sends it. Changes to the
system text, messages, schemas, tool choice or described model settings fail
with `request.diverged` before the provider runs; its message starts with the
first part that differs (`context`, `system`, `messages`, `tools`,
`toolChoice`, `model`, `cacheKey` or `callPolicy`). The header records the
turn's cache key and the `CurrentModelCallPolicy` where the turn runs (the
`StepRequest`'s `cacheKey` and `callPolicy`); the check compares them with
what the model call reads, `CurrentPromptCacheKey` and
`CurrentModelCallPolicy` where the loop dispatches, so a step loop that does
not provide the request's `cacheKey` and `callPolicy` to its calls fails the
step (the `stepLoopConformance` kit checks that it does). Prompt data is
frozen; a stream fallback checks the same contract again, and a failed check
fails the step, streamed or not, instead of falling back. Host-planned
batches make no provider request and create no request header.

`replayModelRequest(events, runId, step, run?)` reconstructs one historical
request, that of `step` in the run `run` of the turn (its ordinal: 0, the
default, for a turn's first run and for every request stored before runs
were counted), from the memory up to its header's cut, excluding later
responses. It uses
recorded tool schemas and render options, so changing installed plugins does
not rewrite historical requests, and fails with `request.diverged`
(`context`) when the events do not rebuild the context the header was
prepared from (a fork's own log without its parent's history). Retention must
preserve `request.prepared` and the memory facts it references; removing
optional `context.built`, trace content or usage diagnostics does not affect
this contract. A host that redacts memory, or exports or streams session
events, handles `request.prepared` the same way: it holds the full system
text (step context included in `"system"` mode) and the tool declarations.
Earlier logs without a header remain readable but cannot reconstruct this
additional metadata.

`BuiltContext.stableMessages` is the rendered prefix length before the
selected run's step-context tail, or the whole message count without that
tail. It is bounded by `messages.length` and is computed from the same render,
including interrupted-call repair and tool-message merging. New headers
freeze that count and mark only an outgoing copy; raw durable messages and
context fingerprints stay unchanged. Reconstruction uses the saved count,
while earlier headers without it replay without the marker. Stored format 8
adds this optional header field.

A streamed step stores the assistant message a non-streamed one stores: its
text and reasoning parts keep their provider metadata (Anthropic's thinking
signature and redacted thinking, the `itemId` and `encryptedContent` of an
OpenAI Responses reasoning item), so the later requests of the session, and
their replays, send that reasoning back either way. Claude Fable 5.1, and
Opus, Sonnet and Haiku 5.5 and later, bind each thinking block to the
conversation before it: a block sent back after an earlier part of the
conversation changed (the step context, a compaction, a tool activated
mid-run) is refused by an account that enforces the binding. The models
plugin's `thinkingPrefixMismatch` says what such a request asks for:
`drop_block` (the default for eligible adaptive thinking) has the provider
drop that block and the later ones for the request, counted as
`llm.thinking.dropped` and logged; `error` has it refuse the request.
`provider-default` sends no binding field. Models that do not bind, and Off
or BetweenTools modes, add neither binding nor its beta automatically. Explicit
endpoint beta flags are preserved. That metadata is stored
as JSON in `providerOptions` (`ProviderOptions`, keyed by provider), less
core's own `engine` key (`ENGINE_KEY`). Stored usage and model bookkeeping
stay out of requests. The recognized `requestVolatile` marker crosses the
in-memory Effect prompt boundary, then framework model adapters consume it
before provider serialization. Custom adapters that serialize prompt options
consume engine bookkeeping likewise. A model
that sends each call on to another, such as the settings-backed router,
stamps the model it resolved on the response's finish part under that key
(`stampResponseModel`, `stampPartModel` for a stream); `responseModelOf`
reads it, and the loop stores it with the turn's usage on the assistant
message (`assistantModel`). A tool the provider runs
(a provider-defined tool) keeps its call and its result in the assistant
message, in arrival order, the result marked `providerExecuted`; the
provider is sent both back as its own, and a chat-completions model is sent
neither. A preliminary tool result is not stored.

Effect AI models hide provider configuration inside adapters. Efferent's
provider adapters and routers describe their public options with
`describeModel(model, { provider, model, settings })`; hosts should do the
same for custom models, preserving the descriptor when wrapping a model
(`modelRequestDescriptorOf` reads it). `settings` is JSON
(`Schema.JsonObject`): a value JSON cannot hold, an `undefined` field
included, fails each dispatch with `request.descriptor`, so settings built
from optional fields go through `storedJson` first. An undescribed model is recorded as
explicitly opaque: its prompt/tools are checked, but its private provider
settings cannot be validated. Credentials never belong in `settings`.
For configured Messages endpoints the routed descriptor records resolved
thinking, effort and output caps plus the public endpoint protocol, version
and beta configuration. A builtin Anthropic selection records those defaults
as a requested `messagesProfile` candidate: a local credential can redirect
the actual call to chat completions. Per-attempt transport and credential
choices remain adapter behavior.
A model that reads its configuration per call, such as the settings-backed
router, is `resolvingModel(model, resolve)`: each step resolves it once
(`resolveModelRequest`), and the resolved model serves the step's header and
every attempt of the step, so a model switch applies from the next step.
The invariant covers the Effect AI request boundary; provider-specific HTTP
serialization, retry/fallback routing and transport transformations remain
adapter contracts. It does not claim to reproduce raw HTTP wire bytes.

`ConversationMemory.open({ conversation, runId, log })` opens a strategy over
the turn's `LogHandle` (the entries of earlier turns, and appends through the
turn's writer). It reads what a strategy
needs per turn (a `ResultDigester`, a summarizer's `UtilityLlm`) with
`Effect.serviceOption` from the environment it is opened in; provide them to
the open, not as an argument.

`MemorySession.record(bodies, step, commit?)` also supports an alternate
atomic commit, used for steering's memory entries and inbox acknowledgment.
The callback receives prepared entries under memory's allocation lock.
`true` commits the whole batch; `false` returns no entries and changes
neither the cache nor the next entry id. A failed acknowledgment triggers
a fresh durable snapshot before another allocation: a commit that landed
keeps its ids, a proven refusal consumes none, and an outcome that cannot
be read reserves its attempted ids. The original error is preserved.
Custom memory adapters implement this contract as well as ordinary appends;
`memoryConformance` checks it.

`ToolRegistry.open(session)` requires
`RunContext` and a scope, and its handlers run with the services of where it
is opened (captured at open); the `IntentMatcher`, `ActionPolicy` and
`PermissionGrants` there are used when present. Every service a tool
declares (`RegisteredTool.requires`, from `defineTool`'s `requires`) must be
there: a run lacking one fails to open with `requires.missing`, naming the
tool and the service, before its first step. The run's `handlers` (and a
`StepRequest`'s) are a `Context<ToolHandlers>`, what `toolkit.toHandlers`
returns: provided to the run's `toolkit`, they meet its requirement with no
cast. A custom `ToolRegistry` builds them the same way, with `toHandlers`.

A custom `StepLoop` provides each of `StepLoopReferences`, whatever its
caller's (an outer run's, for a run inside a tool): the request's `cacheKey`
as `CurrentPromptCacheKey` and its `callPolicy` as `CurrentModelCallPolicy`
to its dispatch checks and model calls; its `captureTraceContent` as
`CurrentTraceContent` to its model calls; `CurrentEmptyResponseTolerance`
to its model calls, false until the run has executed a tool call and true
after; and the current step as `CurrentAgentStep` to its tool handlers and
model calls. The caller's values can be in the request's `handlers` as well
(a turn's services capture the context the turn runs in), so the loop
provides its own inside `handlers`, never under them. `stepLoopConformance`
checks each, with the caller's values around the run and in `handlers`.

A custom `StepLoop` also reruns the kit's `model-failures` check. Inspect
semantic failures before output-cut handling, response persistence, malformed
correctives or tool admission. A known permanent failure ends its started
step once as failed, preserves its `model.*` code and cause, and does not
dispatch another request or a tool. Preserve writer `TurnError` failures
without relabeling them. Explicit protocol-failure stamps distinguish a
provider decode error from the model's ordinary malformed output.

`memoryConformance(memory, services)`, `stepLoopConformance(loop)`,
`turnConformance(runner, services)`, `sessionLogConformance(log)`,
`sessionLogRecoveryConformance(subject)`, `sessionsConformance(subject)`,
`taskRunnerConformance(make, { interruptsOnClose? })`,
`tasksConformance(make)`, `toolRegistryConformance(make)`,
`fileSystemConformance(subject)`,
`bashConformance(subject)`, `authStoreConformance(store, { refresh?, corrupt? })`,
`settingsStoreConformance(store, { writable, corrupt? })` and
`modelCatalogConformance(catalog, { includes? })` (from `@xandreed/core/conformance`;
the credential and settings store kits from `@xandreed/plugin-models/conformance`, and
`toolRegistryConformance`, which runs its turns over the sdk's `TurnLive`,
from `@xandreed/sdk/conformance`) are
the port contracts as runnable checks: each returns `ConformanceCheck`s
(`name`, and a `run` effect that fails with a `ConformanceFailure` naming the
broken check) that any test runner can run. Run them against a new strategy,
loop, turn composition, session store, `Sessions` backend, task runner,
tasks backend, tool registry, file system, shell, or credential, settings or
catalog store. The `Sessions` kit opens several instances over one store
(leased, and held by a process when the backend has process ownership) and
moves their clock with `advance` (`TestClock.adjust`); it checks the busy,
key, resume, image and inbox rules, the writer's endings, cancel and
removal, a write renewing a lease, a lease that ran out and a dead process
holder reaped, a leased turn held by a process-owned instance within its
lease (a turn is judged as it was taken), and, for an instance with a
`TurnActivity`, that it counts
each begin from the moment it is asked for and each turn per session and
turn until its scope closes. The Tasks kit gives the backend its own runner
and executor, and checks that the executor's turns run with the backend's
`Tasks`; the TaskRunner kit checks a runner the host makes. Both wait
up to two seconds on the live clock for background work, so run them
without a `TestClock`; so do the turn kit's checks that cancel a turn or
fill a background queue. The registry kit runs each turn over `TurnLive` and
checks every `tool.refused` reason, and that the model reads each refusal,
and `load_skill`'s, under a PascalCase name, never a host's code.
`@xandreed/plugin-sessions`
(over the memory log), `@xandreed/plugin-session-sqlite` (over SQLite),
`@xandreed/plugin-tasks` and `@xandreed/plugin-tool-discovery` run them, and
`verify:packages` runs all four on Node.

**Files and commands.** Agent tools reach the machine through two core ports,
`FileSystem` and `Bash`. Core ships the ports, the in-memory
`FileSystemMemoryLive` and their conformance kits.
`@xandreed/plugin-workspace` ships the local adapters, `FileSystemLive` (the
disk through `node:fs/promises`) and `BashLive` (commands through
`node:child_process`), both passing the kits on Bun and Node, and
`localSystemPlugin`, which provides both. A host with another backend (a
container, a remote machine) implements the ports and runs the kits against
its adapters.
`FileSystem` works on absolute POSIX paths: `read` (UTF-8) and `readBytes`
(a range), `write` and `append` (`createParents`), `rename` (over an existing
file; a link is moved, not its target), `stat` (kind, size, time; links followed unless
`followSymlinks: false`), `exists`, `list` (entries with their kind, sorted by
name), `glob`, `mkdir` (`recursive`), `realPath` and `remove` (a missing path
is a no-op; a directory with entries needs `recursive`; links in the parent
are followed but never the last name, so `link/` removes the link; the root
and a path ending in `.` or `..` fail with `Invalid`). Every failure is an
`FsError` with a `reason` that means the same on every backend (`NotFound`,
`Exists`, `IsDirectory`, `NotDirectory`, `NotEmpty`, `Permission`, `Invalid`,
`Io`). `glob(pattern, { cwd, exclude, dot, onlyFiles, limit })` is `walkGlob`
over the backend's own `list`: a depth-first walk with each directory's
entries by name, so results and a `limit` cut are the same everywhere; it
never enters a linked directory, prunes `exclude`d names before entering
them, skips dot entries unless `dot` (or the pattern spells the dot), and
reports `truncated`; a pattern whose braces stand for more than 1024
patterns fails with `Invalid`. `FileSystemMemoryLive` (or `makeMemoryFileSystem(seed)`)
keeps a tree in memory, for tests and for agents whose workspace never
touches disk.

`Bash` runs `bash -c` commands in a process group of their own:
`stream(command, options)` emits output chunks as they arrive (stdout and
stderr apart, UTF-8 decoded per stream) and then exactly one `BashExit`;
`exec` is `collectBashResult` over it, which keeps the whole output (no cap
or truncation yet). `stdin` is text or bytes. A non-zero exit, a signal and a
timeout are results (`exitCode` and `signal` are Options, `termination` is
`exit`, `signal`, `timeout` or `interrupted`); `BashError` means the command
could not run (`SpawnFailed`, `CwdMissing`, `ShellMissing`). A timeout or an
interrupted caller kills the whole group. The parent environment is not
passed through: `resolveBashEnv` keeps `BASH_ENV_ALLOWLIST` (`PATH`, `HOME`,
`USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM`, `SHELL`, `TMPDIR`, `TZ`) unless
`inheritEnv` says `true`, `false` or another allowlist (a trailing `*`
matches a prefix), then sets `env` over it, so provider keys never reach a
command by default.

`localSystemPlugin` accepts `parentEnv`, the host's base environment for
shell lookup and command inheritance. Its default, `null`, reads the agent
process's environment; an explicit map replaces it. Each command still goes
through `resolveBashEnv` and its requested inheritance policy. The workspace
plugin builds each child command's options through `bashEnvironment`, so
`bashEnv`, `bashEnvAllow` and the optional session variables share one path.

The local adapters are POSIX only (Linux and macOS; CI runs Linux): they
rely on `/`-rooted paths and process groups, so they do not work on
Windows. `BashLive(options)` runs `<shell> -c <command>` with the command
detached into a process group of its own. `shell` (default `bash`) is
resolved to an absolute path once, when the layer is built, from the parent
`PATH`, so a command whose environment has no `PATH` still runs; a shell
that is not installed fails the layer with `ShellMissing`. There is no
fallback: on a host without bash, set `shell: "sh"` (and write commands for
it). Each command's `cwd` is checked first (`CwdMissing`); its `stdin` is
written and closed, and a command that exits without reading it is not an
error. A timeout or a caller that stops reading kills the whole group; with
`killBackground` (the default) so does the command's return, so nothing it
started in the background outlives it. The stream ends once the command
has exited and its output has closed, or `exitGraceMs` (default 500) after
the exit when something it started still holds the output open; the output
pipes close then. So with `killBackground: false`, a background process
that should outlive the command must have its own output
(`npm run dev > dev.log 2>&1 &`): one still writing to the command's output
gets `EPIPE` or dies of `SIGPIPE`. Commands inherit from `parentEnv`
(default `process.env`) through `resolveBashEnv`. `FileSystemLive` maps
each error code to its `FsReason` (`fsReasonOf`), refuses relative paths
with `Invalid`, and resolves a `remove`'s parent before acting on its last
name, as the in-memory backend does.

`localSystemPlugin` provides both at runtime scope, with a flat
configuration, `shell`, `killBackground` and `exitGraceMs`:

```ts
import { localSystemPlugin } from "@xandreed/plugin-workspace"

const plugins = [{ plugin: localSystemPlugin, options: { killBackground: false } }]
```

**Workspace tools.** The tools an agent works on a workspace with (read,
write, edit, ls, find, grep and bash, over `FileSystem` and `Bash`) ship in
`@xandreed/plugin-workspace` beside these adapters as `workspaceToolsPlugin`
(see [Workspace tools](#workspace-tools)); the skills directory loader,
`skillsDirectoryPlugin`, is there too (see
[Skills from a directory](#skills-from-a-directory)).

**Tool discovery.** Hosts contribute tools (`defineTool`: handler, view,
annotations, and the services the handler reads as `requires`) and skills (`defineSkill`, `skillsFromFiles` over files the host
read, or directories of `SKILL.md` files through `skillsDirectoryPlugin`: see
[Skills from a directory](#skills-from-a-directory)). The registry keeps a
grow-only active set in memory:

1. Tier 1: the skill catalogue is a static system-prompt section.
2. Tier 2: `load_skill` returns a skill's instructions and appends its tools
   to the active set from the next step.
3. Tier 3: `read_skill_reference` serves a loaded skill's references. It is
   registered only when some skill has references.

An always-on skill (`always: true`) is active from every turn's first step,
is not in the catalogue and is never loaded, so nothing shows the model
instructions on it: `defineSkill` takes none for one (`instructions` does
not compile with `always: true`). Put what its tools need in their
descriptions or in a prompt section; the skills directory renders its file
skills' own in a section.

A tool's handler may read only the services its `requires` lists (a
Reference, which has a default, needs no entry): one that reads another does
not compile. The handler gets them from where the run's tools were opened,
and the registry checks every declared one when it opens them, so a turn
lacking one fails to open its tools with `requires.missing`, naming the tool
and the service, instead of failing the call mid-turn:

```ts
import { Tool } from "effect/ai"
import { Effect, Schema } from "effect"
import { defineTool, Failure, SessionEnvironment } from "@xandreed/sdk"

const Workspace = Tool.make("workspace", {
  description: "Name the workspace this conversation works in.",
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const workspace = defineTool({
  tool: Workspace,
  requires: [SessionEnvironment],
  handler: () => SessionEnvironment.pipe(Effect.map((environment) => environment.workspace)),
})
```

`turn.tools.select(userMessage)` activates the `always` skills and, when the
turn's services carry an `IntentMatcher`, the skills it selects (the matcher
receives `{ userMessage, skills, active, history }`). The choice is
recorded with `recordDecision` as a `skill-selection` decision; timeouts and
abstentions keep the always-on set. `select` is `match` then `apply`:
`turn.tools.match(userMessage)` only asks the matcher and returns a `SkillMatch`
(`userMessage`, `skills`, `probabilities`, a provisional `record`) without writing or
publishing anything. `turn.tools.apply(match)` activates the skills, records
and publishes the decision, and records the synthetic `load_skill` exchange.
A host can run the match alongside other work and apply it later, or drop
it. Probabilistic selection never
authorizes: `resolveCapabilities` checks every activation against the turn's
`PermissionGrants` (or the configured grants). Every call passes one wrapper
(active set, grants, `ActionPolicy`, per-turn budgets, read/write lanes): a
call that runs publishes `tool.started` and `tool.completed` before it
returns (its handler's `tool.progress` between them), and a refused call
publishes `tool.refused` instead. The model reads a refusal as the call's
result, `{ error, message }`, with a PascalCase name for what is wrong:
`ToolInactive`, `PermissionDenied` (a permission the turn lacks),
`PolicyDenied` (the host's `ActionPolicy`), `CallLimit`, `ToolCallLimit`,
`ToolTripped` or `ToolConcurrency`.
A handler that dies returns `ToolDefect`
to the model, with the first line of the defect's message only; the whole
cause, stack included, is logged at error level with the call's `tool` and
`invocationId`.

The tool discovery plugin accepts `toolPolicy`, keyed by registered tool
name. Unknown names fail configuration. For example:

```ts
{ plugin: toolDiscoveryPlugin, options: {
  toolPolicy: {
    search: { concurrency: 3, maxCallsPerRun: 20, breakAfter: 2, breakOn: "defects" },
  },
} }
```

Each field is optional. `concurrency` is a positive integer and limits that
tool across every turn and session using this agent's registry. Different
agents have separate permits. `toolPolicy[name].maxCallsPerRun` is a
nonnegative cap for one loop run, including concurrent calls; zero disables
that tool for the run. The existing top-level `maxCallsPerRun` option and
the tool annotation of that name retain their **per-turn** scope. Every cap
applies, so host policy cannot widen an author's annotation. Admissions are
atomic. Calls admitted before waiting for permits consume their slots even
if later refused for nested contention or a newly tripped breaker. A new
`Turn.run` resets its host budget and breaker, and the exact
`CurrentAgentRun` reference keeps overlapping runs separate. Direct toolkit
calls outside a loop share a separate turn-local budget and breaker bucket.

`breakAfter` enables a breaker after that many relevant handler failures
without a successful handler return. `breakOn` defaults to `"defects"`;
`"failures"` counts typed handler failures too. A typed failure is neutral
under the defects-only policy. Success resets the streak; framework write
or subscriber failures, interruption, policy denials and other admission
refusals do not count. A tripped breaker stays open for that run and tool;
there is no cooldown or automatic retry. The next call returns `ToolTripped`
and publishes `tool.refused` with reason `tripped`. Queued calls recheck the
breaker after acquiring permits and cannot slip past a new trip.

Within each turn, read-only handlers share `readConcurrency` permits and
writers exclude every other handler. A writer's turnstile prevents later
readers overtaking it. Per-tool permits are acquired before these turn-local
lanes. Nested tool calls inherit logical execution ancestry across toolkit
fibers and acquire permits only when immediately available; otherwise they
return `ToolConcurrency` with reason `concurrency`. In particular, recursive
calls at a one-call concurrency limit and read-to-write upgrades refuse
instead of deadlocking. No handler, policy hook or event subscriber bypasses
the configured limits.

The registry flushes `tool.started` before waiting for execution permits.
It proves durable admission, rather than handler execution. A queued call
whose breaker trips, or a nested call whose permits are occupied, may then
publish `tool.refused` without `tool.completed`; its invocation and provider
call ids stay the same. Initial admission refusals have no `tool.started`.

An activation is one step: what is new is worked out from the active set,
recorded and applied under one lock, so `load_skill` calls running at once
(a step's calls with `toolConcurrency` above 1) each keep the other's tools,
and each call's "Now available" names the tools it added. Only a refusal
(`skills.unknown`, `capability.forbidden`) turns an activation down:
`load_skill` returns it to the model as `UnknownSkill` or
`PermissionDenied` (the codes are the host's: `activate` fails with
them), and `apply` records the matcher's
decision as `rejected`. A failure to record the activation is not a
refusal: it fails the turn from `load_skill`, and fails `apply` without
recording the decision. Each decision of a run has its own id
(`<runId>:skill-selection:<n>`), and each `load_skill` exchange seeded
from one its own call id (`<runId>:matcher:<n>`).

Tools only grow within a conversation and are sent in activation order.
Restrict a step with a tool choice or a handler failure, never by removing a
schema: removing one rewrites the cached prefix.

**Capabilities and the system prompt.** `definePlugin({ contributes:
[Capabilities] })` marks a multi-provider key: the runtime concatenates every
contributor's array in graph order. A capability carries tools, skills and
prompt sections; per-turn host state comes from the turn's `layer`. The
system prompt is the configured prefix, then the `static`
sections, then the `session` sections, each tier by `order`, then by `id` in
code-unit order, so the prompt's bytes are the same on every machine. `turn`
sections are recorded as turn context when the first run starts.

A section renders where the turn renders its prompt, with the run's
services. A section written as a plain `PromptSection` reads none (its
`render` needs nothing); one that reads services is built with
`definePromptSection` and lists them in `requires`, like a tool: a `render`
that reads another does not compile, and one rendered without a declared
service fails with `requires.missing`, naming the section and the service:

```ts
import { Effect, Option } from "effect"
import { definePromptSection, SessionEnvironment } from "@xandreed/sdk"

const workspaceNote = definePromptSection({
  id: "app.workspace", version: "1", tier: "session", order: 100,
  requires: [SessionEnvironment],
  render: () => SessionEnvironment.pipe(Effect.map((environment) => Option.some(`The workspace is ${environment.workspace}.`))),
})
```

### Skills from a directory

A skill can be a directory with a `SKILL.md` in it, the Agent Skills
layout: frontmatter, then the instructions `load_skill` returns; every
other text file of the directory is a reference `read_skill_reference`
serves by its path there (`references/formats.md`, `scripts/check.sh`).
Core reads such trees without IO: `readSkillFiles(files, options)` returns a `SkillTree` (the
skills, each with its directory, and the issues met) and never fails, and
`skillsFromFiles` is the same made strict (`skills.files` naming every
issue). `collectSkillFiles(root, { maxFiles, maxBytes, maxFileBytes })`
reads a directory's text files through the `FileSystem` port's `glob`: links
are not entered, dot entries, `node_modules` and binary files are left out,
and more files or bytes than allowed fail with `skills.limit`. A file other
than a `SKILL.md` over `maxFileBytes` is not read: it is collected with its
`size`, and `readSkillFiles` leaves it out with a warning. Binary and unread
files do not count toward `maxBytes`.

- Every `SKILL.md`, at any depth, is a skill, and its directory is the
  skill's; a nested skill's files are its own, not its parent's. Files
  outside every skill directory are not read.
- Frontmatter: `description` (or `summary`, which wins) is required and is
  the catalogue line (made one line); `id` or `name` is the id, else the
  directory's path below the root (`release/checklist`), else, for a
  `SKILL.md` at the root itself, the root's name; `version` defaults to a
  fingerprint of the skill as read, so it changes whenever its `SKILL.md` or
  a reference it serves does; `tools` and `permissions` are lists (or text
  split on commas and whitespace, so an item with a space in it is written
  as a list); `always` is `true` or `false`, in any case. Other fields (`license`, `metadata`, `allowed-tools`)
  are ignored. The frontmatter is the YAML subset skill files use: quotes,
  `>` and `|` blocks, `- item` and `[a, b]` lists, ` #` comments, a
  byte-order mark and CRLF; keys indented under another (`metadata:`) are
  not read.
- An issue is an `error` that leaves a skill out (no frontmatter, no
  description, an id already used) or a `warning` that leaves out part of
  one (a reference over `maxReferenceBytes` or whose path is not a valid id,
  an unreadable value).

`skillsDirectoryPlugin` (`@xandreed/plugin-workspace`, runtime-scoped,
requires `FileSystem`) loads directories once per `Agent.define` and
contributes their skills as one capability, so tool discovery lists them
with the host's:

```ts
import { localSystemPlugin, skillsDirectoryPlugin } from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,                                                              // FileSystem (and Bash) on the local disk
  { plugin: skillsDirectoryPlugin, options: { roots: [".agents/skills", "/opt/team-skills"] } },
  memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin,
]
```

Its options are flat. `roots` (default `[".agents/skills"]`) are absolute or
relative to the agent's `workspace` (`SessionEnvironment`, else the working
directory); a missing root is skipped unless `required` (`skills.root`).
`tools` is `"ignore"` by default: a file skill is instructions and
references only, and activates no tool; with `"declared"`, its `tools` must
name registered tools or `Agent.define` fails with `skills.tools`.
`idPrefix` goes before every id. The first root wins an id two roots
define. With `strict`, any issue fails `Agent.define` with `skills.files`;
without it, each is logged as a warning and what it names is left out.
`maxReferenceBytes` (64 KiB) caps a reference (a larger file is not read
and does not count toward `maxBytes`), `maxFiles` (2000) and `maxBytes`
(8 MiB) each root, and `maxSkills` (200) all of them (`skills.limit`). Tool discovery activates `always` skills at each turn's
start but lists only the others, so the plugin renders the always-on
skills' instructions in a static section (`alwaysSection`, at
`sectionOrder` 850, before the catalogue at 900). A skill id the host or
another plugin also defines fails `Agent.define` with `skills.duplicate`:
give the directory an `idPrefix` (`"project."`). To read several
directories, give one instance several `roots`: the capability and the
always-on section have fixed ids (`SKILLS_CAPABILITY_ID`,
`ALWAYS_SECTION_ID`), which two instances would share. The skills are read
when the agent is defined; a changed file is seen by the next
`Agent.define`.

### Workspace tools

`workspaceToolsPlugin` (from `@xandreed/plugin-workspace`; runtime scope,
built once per agent) gives the model seven tools over the agent's
workspace, the `workspace` of `Agent.define` (`SessionEnvironment`). Each
call works through the `FileSystem`, `Bash` and `SessionEnvironment` of the
turn it runs in, so `localSystemPlugin` (the local disk and shell), an
in-memory `FileSystemMemoryLive` or a host's own adapters all serve them.
`workspaceTools(config)` builds the same capability for a host that stacks
layers itself. Each tool declares those services (`bash` adds `Bash`), so a
turn whose services lack one fails to open its tools with
`requires.missing`.

| Tool | Skill | Parameters | Result |
| --- | --- | --- | --- |
| `read` | `workspace.read` (always on) | `path`, `offset`, `limit` | a window of a text file's lines (`Text`); an image (`Image`, sent to the model as an image) or a note on one it cannot send (`ImageRejected`); or `Binary` with the media type its name suggests |
| `ls` | `workspace.read` | `path`, `limit` | a directory's entries and their kinds |
| `find` | `workspace.read` | `pattern` (a glob), `path`, `limit` | file paths relative to the root |
| `grep` | `workspace.read` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit` | matching lines with context |
| `write` | `workspace.edit` (`fs.write`) | `path`, `content` | bytes written, created or not |
| `edit` | `workspace.edit` (`fs.write`) | `path`, `edits: [{ oldText, newText }]` | blocks replaced, first changed line, a unified diff |
| `bash` | `workspace.shell` (`shell.exec`) | `command`, `timeout` (seconds), `stdin` | the output's tail, exit code, signal, termination, the spill file |

A failure is data the model reads in the same run (`{ error, message }`:
`NotFound`, `OutsideWorkspace`, `ReadOnly`, `Protected`, `NoMatch`, `AmbiguousMatch`,
`OverlappingEdits`, `WouldEmpty`, `FileTooLarge`, `InvalidPattern`,
`NotUtf8`, `NotAFile`, `AlreadyExists`, `AccessDenied`, `FileSystemError`,
…; a file-system failure's `FsReason` stays the port's, and the model reads
it under a name of its own); a non-zero
exit, a signal and a timeout are `bash` results, not failures. The
`workspace.environment` section (tier `session`, order `sectionOrder`) tells
the model where the workspace is and how the enabled tools behave; it reads
and declares the same services as the tools. The
skills have no instructions, since an always-on skill's instructions never
reach the model.

**Permissions.** `write` and `edit` need `fs.write` and `bash` needs
`shell.exec` (`WORKSPACE_PERMISSIONS`). Tool discovery grants nothing by
default: give the grants with its `grants` option or a turn's
`PermissionGrants`. Without them, `load_skill` refuses `workspace.edit` and
`workspace.shell` with `PermissionDenied` and the tools stay inactive (a
call returns `ToolInactive`); with `edit` or `shell` in `always` and no
grant, the turn fails with `capability.forbidden`. Without a `Bash` service
when the agent is defined, there is no `bash` tool and no `workspace.shell`
skill (a warning is logged). A coding turn reads and edits a lot: raise tool
discovery's `maxCallsPerRun` (64 by default) for such hosts, to 200 or more.

**A guardrail, not a sandbox.** With `confine` (the default), a path is
resolved against the workspace root and refused when its written or real
location is outside every allowed root (links resolved, through the nearest
ancestor that exists,
so a new file under a linked directory is checked too; a link to a missing
target is never written through). `workspaceAccess` is `write` by default;
set it to `read` to refuse workspace changes. `roots` adds directories as
`{ path, access: "read" | "write" }`, absolute or relative to the workspace.
The longest matching real root controls writes (`ReadOnly` when it permits
only reads); a later root wins an equal-path tie. An extra root that cannot
be opened as a directory is skipped and logged. `confine: false` disables
these root and access restrictions. They apply to the six file tools;
`bash` remains unconfined. `write` and `edit` refuse the `protect`
globs (`.git/**` and `.efferent/**` by default), relative to the workspace;
they do not protect a writable extra root's own `.git` or `.efferent`
directory. A path through an extra root into a protected workspace file is
still refused. Use read-only roots for external reference trees. `find` and builtin `grep` walk with
`walkGlob`, which never enters a linked directory and prunes the `exclude`
names (`node_modules`, `.git`, `.efferent`; an entry with a `/` is a path
relative to the workspace root, wherever the walk starts; such path globs
do not apply to a search outside it, while bare excluded names still do);
builtin `grep` resolves each file
again before reading it. The ripgrep engine resolves the target first and uses
`--no-follow`; the same workspace-relative exclusions apply. `read`, `write`, `edit` and `grep` refuse a pipe,
socket or device (`NotAFile`) rather than wait on it. These checks catch a
model's mistakes. They are not a security boundary: a path can change
between the check and its use, and `bash` runs any command the host process
may run, reading and writing anything it can reach.

`grepEngine: "auto"` (the default) probes for `rg` once over the supplied
`Bash` service and uses ripgrep when available. It runs on the same machine as
that service, including a container. The FileSystem and Bash services must see
the same file tree; choose `"builtin"` for an in-memory or different FileSystem.
`grepEngine: "ripgrep"` refuses activation
if the probe fails; `"builtin"` selects the synchronous JavaScript engine.
Ripgrep uses its default regular-expression syntax (no lookaround or
backreferences), receives patterns on stdin and runs with `grepTimeoutMs`
(30 000 ms by default). It ignores ripgrep configuration files and, unless
`grepIgnoreFiles: true`, searches files hidden by ignore files too. With that
option it honours `.gitignore`, `.ignore` and other ripgrep ignore rules.
A timeout returns partial results with `timedOut: true` and a note in grep view
version 4. Builtin `grep` is not time-bounded: its expression runs in the host
process and cannot be interrupted. It cuts lines before matching and refuses
nested repetition (`(a+)+`), but overlapping alternatives such as `(a|a)*` can
still hold the process on a hostile line.

Commands get the configured `bashEnv` over an
allowlist of the host's variables (`bashEnvAllow`, the same names as
`BASH_ENV_ALLOWLIST`), so provider keys stay out unless `bashInheritEnv`
passes everything; `bashSessionEnv` adds `EFFERENT_SESSION_ID`,
`EFFERENT_RUN_ID` and `EFFERENT_WORKSPACE`. For untrusted work, give the
agent a `FileSystem` and `Bash` that run inside a container or VM.

**Output.** `read` shows at most `maxLines` lines (2000) or `maxBytes`
(50 KB) and says which `offset` continues; a single longer line is shown cut.
`ls`, `find` and `grep` stop at `lsEntries` (500), `findResults` (1000) and
`grepMatches` (100), and what `find` and `grep` show the model is cut to
`maxLines` and `maxBytes` too; `grep` displays lines cut to `grepLineChars`
(500). Ripgrep searches the whole line; builtin cuts before matching. Searching
a directory takes at most a quarter of
its limit from one file. Files over `maxFileBytes` (32 MB) or with a NUL
byte in their first 8 KB are not read as text; a file that is not valid
UTF-8 is shown with U+FFFD and a notice (`lossy`). A binary file whose
bytes are a PNG, JPEG, GIF or WebP image (sniffed by core's
`sniffImageType`, whatever its name says, and built with `mediaFromBytes`)
is returned as an image with `readImages` (the default):
`{ _tag: "Image", path, image }`, `image` a `Media` named by the path. The
view's text is one line, `[Image docs/chart.png (image/png, 182 KB).]`, the
view sends the image with it, and memory stores the image once (see
[Images and multi-part messages](#images-and-multi-part-messages)). An
image over `MEDIA_LIMITS.imageBytes` (3.75 MiB) or `maxPixels` (8000) a
side, or one whose header gives no size, is an `ImageRejected` note
instead (its path, type, size, `reason` and `message`), without its bytes;
the model is told why, and, for a size, to read a smaller copy. A file over
`maxFileBytes` is refused (`FileTooLarge`) before any of this, unread; for
a file named as one of those images the refusal, too, says to read a
smaller copy, and the `read` description states the smaller of the two
limits. With `readImages: false` an image is `Binary` like any other binary
file. A host whose models read text only (routes that send a label line in
an image's place, or memory with `maxMediaChars: 0`) sets it: the model
would get a label line, and the session would still store the bytes.
Add `imageResizerPlugin` from `@xandreed/plugin-workspace` to fit larger
images automatically, or supply core's `ImageResizer` in `Agent.define.services`.
The service is optional at runtime activation: without it, the behavior and
`read` description above stay unchanged. With it, `imageMaxSide` (64–8000,
default 8000) sets the side limit; the byte limit remains
`MEDIA_LIMITS.imageBytes`. `maxFileBytes` still refuses a file before reading
or converting it. Fitting also works over read-only workspace roots: the
source file is only read. A successful result adds `original` with the
source's `mediaType`, byte count, width and height; the fitted image can
have another type. Its version-3 view says, for example,
`[Image chart.png (image/jpeg, 1.2 MB), scaled down from 9000x6000 (image/png, 14 MB).]`.
Only the fitted bytes are sent and stored. A fit failure logs a warning and
returns an `ImageRejected` note with the existing smaller-copy guidance.

The opt-in CLI plugin provides `ImageResizer` over the same `Bash` and
`FileSystem` tree. `ImageResizerConfig` has `tool` (`auto`, `magick`,
`convert`, `vips` or `sips`), `tempDir` (`null`, or an existing absolute
POSIX directory) and `timeoutMs` (30 000, up to 600 000). Auto probes once,
in that order (`vips` invokes `vipsthumbnail`); an explicit missing tool or
no available tool fails activation with `images.unavailable`. It adds no
native npm dependency. A null `tempDir` uses the Bash environment's
`TMPDIR`, falling back to `/tmp`. Each fit uses its own scoped directory,
removed after success, failure or interruption; the deadline covers the
conversion attempts and cleanup follows interruption. Commands use
`bashEnvironment`'s default allowlist over the host's `parentEnv` and run
with fixed relative filenames. Four bounded shrink attempts preserve
aspect and never upscale; JPEG inputs keep JPEG compression, GIF/WebP
conversion takes the first frame, and an opaque PNG may fall back to JPEG
when the backend can establish opacity. Results are checked again with
`mediaFromBytes`. This uses the host's converters with the shell's access;
file-tool confinement remains a guardrail, not a sandbox.

```ts
import { imageResizerPlugin, localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,
  { plugin: imageResizerPlugin, options: { tool: "auto", timeoutMs: 30_000 } },
  { plugin: workspaceToolsPlugin, options: { imageMaxSide: 1568 } },
]
```

`bash` keeps the tail of a command's output (stdout and stderr in the
order they came) within the same `maxLines` and `maxBytes`; once the
output is longer, it is written to `spillDir`
(`.efferent/runtime/tool-output`, inside the workspace, so `read` can open
it) up to `maxFileBytes`, past which nothing more is saved and the
result says `fullOutputCut`, and the result names the file; only the newest
`spillKeep` (50) files are kept. While a command runs, its output is
published as transient `tool.progress` events (`channel` `stdout` or
`stderr`): gathered over `progressMs` (250), then one event per run of
output from one stream. The timeout is the model's
`timeout` or `bashTimeoutMs` (120 s), at most `bashMaxTimeoutMs` (600 s); a
command that runs past it is killed with its process group.

**Edits.** `edit` applies several replacements at once, all matched against
the file as it was: each `oldText` must appear exactly once, the spans must
not overlap, and edits that change nothing fail with `NoChange`. With
`fuzzyEdit` (the default), text not found exactly is matched once more over
whole lines with whitespace, Unicode compatibility forms, curly quotes and
dashes normalised; that match must be unique too, and the result says
`normalized`; it covers the matched lines' last line break only when
`oldText` ends with one, as an exact match would. A byte-order mark and CRLF
line endings are kept. A file that is not valid UTF-8 is refused
(`NotUtf8`): writing its decoded text back would turn every byte that is
not into U+FFFD. The result carries a unified diff (effect's `TextDiff`, at
most 10 000 edits searched per change) for a host's UI; the model is shown
one line. `write` refuses to empty a non-empty file. Both write through a
temporary file and a rename, so a reader never sees half a file, except
when the rename would change the file's permissions: a file with execute,
setuid, setgid or sticky bits, or one whose mode the temporary file (made
under the process's umask) did not get, such as a private or read-only file
(or a group-writable one under umask 022), is written in place, keeping its
mode. Both hold a
per-file lock, so two sessions editing one file wait for each other.

`WorkspaceToolsConfig` is flat: `tools`,
`always` (`["read"]`; also `edit`, `shell`), `confine`, `workspaceAccess`
(`write`), `roots` (`[]`), `protect`,
`exclude`, `maxLines`, `maxBytes`, `lsEntries`, `findResults`,
`grepMatches`, `grepLineChars`, `grepEngine` (`auto`), `grepTimeoutMs`
(30 000), `grepIgnoreFiles` (`false`), `maxFileBytes`, `readImages` (`true`),
`imageMaxSide` (8000; used only with `ImageResizer`),
`fuzzyEdit`, `bashTimeoutMs`, `bashMaxTimeoutMs`, `bashEnv`,
`bashInheritEnv` (`false`), `bashEnvAllow`, `bashSessionEnv`, `spillDir`
(relative to the root; `null` saves nothing), `spillKeep`, `progressMs`,
`environmentSection` and `sectionOrder`. Hosts react to edits with
`onTool(workspaceToolSchemas.edit, …)`, which hands them the typed
`EditResult` with its diff.

```ts
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,
  { plugin: workspaceToolsPlugin, options: { always: ["read", "edit"], bashTimeoutMs: 300_000 } },
  { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write", "shell.exec"], maxCallsPerRun: 200 } },
]
```

### Typed plugin layers

`definePlugin` returns a `TypedPlugin`: the `Plugin` the graph loads, plus its
`config` schema, its typed `defaults` and `live(options?)`, the plugin's own
layer with the services it provides and requires in its type. Options merge
over the defaults and are decoded as the graph decodes them; an unknown key
fails with `config.options`. Each capability package exports its schema, its
defaults and its layer:

| Package | Layer | Provides | Requires |
| --- | --- | --- | --- |
| `@xandreed/plugin-sessions` | `SessionsPluginLive` | `Sessions`, `TurnActivity` | `SessionLog`, `TurnAdmission` |
| `@xandreed/plugin-session-sqlite` | `SessionLogSqliteLive(path)` | `SessionLog` | — |
| `@xandreed/plugin-tasks` | `TasksPluginLive` | `Tasks`, `Capabilities` (with `tools`) | `Sessions`, `TaskRunner`, `TaskExecutor` |
| `@xandreed/plugin-memory-window` | `MemoryWindowLive` | `ConversationMemory`, `Capabilities` (recall) | — |
| `@xandreed/plugin-memory-summary` | `MemorySummaryLive` | `ConversationMemory` | — at build; each turn's `UtilityLlm` (declared `optional`) |
| `@xandreed/plugin-memory-digest` | `MemoryDigestLive` | `ResultDigester` (build it per turn) | `UtilityLlm` |
| `@xandreed/plugin-tool-discovery` | `ToolDiscoveryLive` | `ToolRegistry`, `Capabilities` (catalogue) | `Capabilities` |
| `@xandreed/plugin-agent-loop` | `StepLoopLive` | `StepLoop` | — |
| `@xandreed/plugin-workspace` | `LocalSystemPluginLive` | `FileSystem`, `Bash` | — (fails with `ShellMissing` when the shell is not installed) |
| `@xandreed/plugin-workspace` | `ImageResizerPluginLive` | `ImageResizer` | `FileSystem`, `Bash` on the same file tree |
| `@xandreed/plugin-workspace` | `SkillsDirectoryPluginLive` | `Capabilities` (the directory's skills) | `FileSystem` (and `SessionEnvironment` when present) |
| `@xandreed/plugin-workspace` | `WorkspaceToolsPluginLive` | `Capabilities` (the workspace tools) | — at build (`Bash` and `ImageResizer` used when there); each call needs `FileSystem` and `SessionEnvironment`, `bash` also `Bash`, fitted `read` also `ImageResizer` |
| `@xandreed/plugin-telemetry` | `TelemetryPluginLive` | — (records metrics and span events) | `RunContext`, `TurnEvents` (build it per turn) |

The schemas are `SessionsConfig`, `TasksConfig`, `MemoryWindowConfig`,
`MemorySummaryConfig`, `MemoryDigestConfig`, `ToolDiscoveryConfig`,
`LocalSystemConfig`, `ImageResizerConfig`, `SkillsDirectoryConfig`, `WorkspaceToolsConfig` and
`TelemetryOptions`, with `sessionsDefaults`, `localSystemDefaults`, `imageResizerDefaults`,
`skillsDirectoryDefaults`, `workspaceToolsDefaults`, `telemetryDefaults` and
so on; plugin-render exports `renderSurfaceDefaults` and `renderFeedDefaults`.

`stackPlugins(next)(base)` composes them the way the graph activates plugins:
`next` is built over everything `base` provides, the two `Capabilities`
arrays concatenate base first, and any other service of `next` wins.
`CapabilitiesLive(...bundles)` is the host's own bundle at the bottom of the
stack.

```ts
const plugins = CapabilitiesLive(appTools).pipe(
  stackPlugins(MemoryWindowLive({ digestOnWriteChars: 4_000 })), // + the recall tool
  stackPlugins(ToolDiscoveryLive({ grants: ["public"] })),       // registry over [app, recall]; + the catalogue
  stackPlugins(StepLoopLive),
)
```

The order is load-bearing, as in the graph: the registry is built over the
capabilities below it (the host's tools, then recall), while the system
prompt sees all three bundles, and that order is the order of the tools sent
to the model. Never combine layers that contribute with `Layer.merge` or
`Layer.mergeAll`: a merge keeps one `Capabilities` array and silently drops
the other's tools, skills and sections, and neither layer sees the other's.

### The turn as services

The steps of a turn are public, over typed services, so a host composes the
turn it needs; `Agent.turn` is one such composition. `TurnLive(input)` (from
`@xandreed/sdk`, requiring `ConversationMemory` and `ToolRegistry`) builds,
over the admitted turn's `TurnWriter`, in this order, the event bus and the
tasks, with the writer as the bus's first subscriber, then the memory
session (opened where the layer is built, over the session's earlier turns)
and `RunContext` (which carries the turn's `session`). It provides:

- `TurnMemory`: the session, `pendingSteers` (a fresh read), `steer(step,
  run)` (atomic user-message recording before planning), the turn's `number`, `startRun` (the next run
  of the step loop, its ordinal counting from 0; `turn.closed` once the
  reply is recorded), `persistMessage` (the
  turn's TurnStarted, stored when the turn began, is shown to memory, then
  `turn.started` is published; once, but a message memory failed to record
  can be taken again), `context(entry)` (before
  `persistMessage` it waits, and is recorded right after the message:
  memory records nothing of the turn before its message, `turn.unstarted`),
  `persistReply(outcome)` (`turn.reply`, then `turn.ended` is published
  with the turn's usage; once, and a no-op when the message was never
  persisted; a failed outcome after a completed one downgrades the reply,
  publishing nothing again). The stored `turn.ended` is the writer's `end`,
  the turn's closing commit: the reply, and what memory records after it,
  are held for it (`TurnWriter.closing`) and stored in that one commit,
  right before `turn.ended`, never by a `flush`;
- `TurnToolbox`: `open` (once, but an open that failed can be retried; the
  handlers run with the opener's services) and `tools` (fails with
  `tools.unavailable` before `open`);
- `TurnPrompt`: `system(variant)` and `turnSections` (once, after
  `persistMessage`);
- `RunContext` (its `usage` is the turn's running total: a second bus
  subscriber, after the writer, sums every `assistant.message`; its
  `admitted` is the writer's admitted turn, the host's `meta` included),
  `TurnEvents` and `TurnTasks`.

The lifecycle is functions over them, from `@xandreed/sdk` too:
`openTurnTools`, `turnTools` (the
host's view), `settleTurn` (join the tasks, drain the reactions, until quiet),
`finishTurn(outcome)` (persist the reply, drain, flush; the reply and the
flush happen even when the fiber is interrupted meanwhile, only the drain is
cut; when the drain or the flush fails, or the drain is cut, the reply is
downgraded to failed before the failure goes on), `guardTurn(body)` (settle
on success, then `finishTurn`'s steps, else finish as failed keeping
the cause: the failed reply recorded, its reactions drained interruptibly
and for ten seconds at most, a failure of that finishing logged; on success
it returns the `TurnResult`, the outcome with `RunContext.usage`; on failure
it puts the usage so far on the current span), `turnOf(options)`
(the `Turn` a host's code gets), `stepRequestOf(policy, options)` and
`runTurnLoop(policy, options)` for one run of the step loop (over the
`TurnRunServices`), and `traceTurn(writer, { spanMeta })` (its options a
`TurnTraceOptions`; the turn's `agent.turn` span around everything after the
begin, see traces and metrics). `cacheKeyOf(prefix,
conversation)` builds the prompt-cache key.

`Agent.turn` is, in order:

```ts
const body = Effect.gen(function* () {
  yield* (yield* TurnMemory).persistMessage       // 4. the user's message
  yield* openTurnTools                            // 5. inside the host layer: its services reach the handlers
  return yield* use(yield* turnOf(runOptions))    // 6. the host's code
})
const run = body.pipe(
  Effect.tap(() => settleTurn),                   // body tasks finish before its scoped services close
  Effect.scoped,
  Effect.tap(() => settleTurn),                   // body finalizer work still has the host's services
  provideHostLayer(Option.fromNullishOr(input.layer)), // 3. built before the message; closes after the body
  Effect.tap(() => settleTurn),                   // host finalizer work still has its plugin dependencies
  provideTurnPlugins,                            // 2. turn-dependent plugins close next
  guardTurn,                                     // settle plugin finalizer work, then record the final outcome
  Effect.provide(TurnLive(live), { local: true }), // 1. writer first; stays open throughout teardown
  Effect.provideService(ConversationMemory, memory),
  Effect.provideService(ToolRegistry, registry),
  Effect.provideService(StepLoop, loop),
  Effect.provide(context),                        // the graph's services and the turn's
  untilClosed(writer),
  harnessDefectsAsFailures,
  Effect.exit,
)
const admitted = Effect.gen(function* () {
  const exit = yield* run
  if (own) yield* writer.end(turnEndingOf(exit))  // 9. a turn begun here (its failure ignored when the turn failed)
  return yield* exit
})
admitted.pipe(measureTurn, traceTurn(writer, { spanMeta: config.spanMeta ?? [] })) // 1. to 9. under agent.turn, counted and timed
```

The order matters. The message is persisted before the matcher runs, because
the matcher reads the reference transcript and a decision's context hash
includes its length. Anything built before `persistMessage` (the
turn-dependent plugins, the host's layer) sees only earlier turns. The
body closes before the host's layer, which closes before the turn-dependent
plugins. On success, tasks and background reactions settle before each
dependency scope closes; work forked by its finalizers settles before the next
scope closes. The outer `guardTurn` includes that teardown before recording
one final reply: a finalizer task failure produces a failed reply, rather than
following a completed reply. `TurnLive` remains open for that settlement and
flush, then closes; an agent-owned writer ends afterward, its end storing the
reply and `turn.ended` in one commit (a host that ends the writer itself
stores them the same way, and a scope closed without an end stores them too).

Subscriptions owned by the body, host or turn-dependent plugin scopes have
already closed when the final `turn.ended` event is published. An observer that
needs the final outcome subscribes in the caller's outer scope, using
`Scope.provide(observerScope)`, and uses services that remain open there.
A host composing by hand uses the same pieces over a
`stackPlugins` stack instead of a graph, builds session plugins such as
`MemoryDigestLive()` per turn over the turn's services, lets a begin
refusal through as the turn's failure (`TurnBeginError`, as `TurnRunner`
types it), ends a turn it
began with `writer.end(turnEndingOf(exit))`, taking the exit after
`harnessDefectsAsFailures` (failing the turn when that end fails on
success, as `Agent.turn` does), and wraps everything after its begin, that
end included, in `traceTurn(writer, { spanMeta })` for the turn's
`agent.turn` span, with `guardTurn` directly under it so a failed turn's
usage lands on that span; on success it returns the end's `pending` with the
result. `turnConformance`
checks a composition: the writer first, the message before the matcher's
history, the reply and the turn's end exactly once on success, failure and
interrupt, tasks joined before the reply, a model-driven turn's
`TurnResult.usage` equal to its stored `step.usage` records (`turnUsageOf`),
the user's attachments stored with the turn and reaching its first request
as image parts, the host layer seeing only
earlier turns, a turn it begins returning the inbox items its end left
waiting (`TurnResult.pending`), a turn begun while another is open
failing with that `SessionBusy` itself and running and storing nothing, an
interrupted turn ending at once while a background reaction to its reply
never returns, and a background reaction that publishes past its queue's
size not hanging the turn.

## Images and multi-part messages

A user's message can carry images: `new UserMessage({ text, attachments })`,
with at most `MEDIA_LIMITS.attachments` `Media` values. The text may be empty
when there is an image; a message with neither is refused. A `Media` is one
image, inline: `{ type: "media", mediaType, data, fingerprint, bytes, name?,
alt? }`, `data` being padded base64 without a `data:` prefix and
`fingerprint` a content hash of the bytes (not cryptographic). Build one with
the constructors, which check the bytes:

```ts
import { mediaFromBase64, mediaFromBytes, UserMessage } from "@xandreed/sdk"

const shot = yield* mediaFromBytes(bytes, { name: "form.png", alt: "the failing form" })
const pasted = yield* mediaFromBase64(dataUrl) // a data: URL, or base64 with line breaks
const userMessage = new UserMessage({ text: "What is wrong here?", attachments: [shot, pasted] })
yield* agent.turn({ turn: { session, userMessage, runId }, services }, use)
```

The media type is the one the bytes are (PNG, JPEG, GIF or WebP), whatever a
`data:` prefix or the caller says, and the image's size is read from its
header. A refusal is `AttachmentRejected` with a `reason`: `Empty`,
`InvalidBase64`, `UnsupportedType`, `TooLarge`, `TooManyPixels`,
`Unreadable` (a header without a size) or `TooLargeTogether`, and, when one
image is at fault, its `index`. More than `MEDIA_LIMITS.attachments` images
fail earlier, when the `UserMessage` is constructed or decoded (a schema
error); `TooMany` is only for a value that skipped that check. `Agent.turn`
fails with the `AttachmentRejected` itself (its code is
`turn.attachment-rejected`), so a host branches on its `reason` (to answer
413 for `TooLarge` and `TooLargeTogether`, say) with
`Effect.catchTag("AttachmentRejected", …)`.

| `MEDIA_LIMITS` | Value | What it bounds |
|---|---|---|
| `imageBytes` | 3 932 160 (3.75 MiB, 5 242 880 base64 characters) | one image's bytes |
| `maxPixels` | 8000 | either side of one image |
| `attachments` | 8 | images on one user message |
| `requestImages` | 8 | images one request sends as images, whatever `maxImages` says; the memory plugins' default `maxImages` |
| `requestChars` | 20 000 000 | base64 of one message's images together; the memory plugins' default (and largest) `maxMediaChars` |
| `toolResultImages` | 4 | images one tool result sends (more are label lines), within `requestChars` together |

**Begin.** `Sessions.begin` normalises the message before anything else
(`normalizeUserMessage`): each image's type, size and fingerprint are taken
again from its data, and the images together must stay within
`requestChars`. That value is what the session stores in `turn.started`, what
the turn's `admitted.userMessage` holds and what a retried key is compared
with: a retry with the same images is the same turn (`TurnDuplicate`), even
when the host's `Media` values were not normalised; other images under the
key are a `KeyConflict`. `Agent.turn` checks the attachments the same way
before it begins a turn, whatever `Sessions` the turn's services hold, and
fails with that `AttachmentRejected` (`turn.attachment-rejected`). A message without text gives the
session no title.

**Storage.** Images are stored inline, once: in the turn's `turn.started`,
under `userMessage.attachments` (the memory log's `TurnStarted` entry is
that event). A text-only message is stored exactly as before. A session
grows by up to about 5 MB per image, and each turn reads the session's
images back with its memory, so a long session of images is a heavy one. A
`SessionLog` must hold an event of `requestChars` base64 characters;
`sessionLogConformance` checks one.

**Images from tools.** A tool returns images as `Media` values anywhere in
its success value (build them with `mediaFromBytes` or `mediaFromBase64`;
effect/ai's `Tool.toModelOutput` is not used). Every image the result holds
is sent with it, or the ones its view picks:

```ts
import { Tool } from "effect/ai"
import { Effect, Schema } from "effect"
import { defineTool, Failure, Media, mediaFromBytes } from "@xandreed/sdk"

declare const capture: (url: string) => Effect.Effect<Uint8Array>

const Screenshot = Tool.make("screenshot", {
  description: "Take a screenshot of a page.",
  parameters: Schema.Struct({ url: Schema.String }),
  success: Schema.Struct({ url: Schema.String, image: Media }),
  failure: Failure,
  failureMode: "return",
})

const screenshot = defineTool({
  tool: Screenshot,
  handler: ({ url }) => capture(url).pipe(
    Effect.flatMap((bytes) => mediaFromBytes(bytes, { name: "page.png" })),
    Effect.map((image) => ({ url, image })),
    Effect.mapError((error) => ({ error: "Screenshot", message: error.message })),
  ),
  view: {
    version: "1",
    render: (result) => `Screenshot of ${result.url}.`,
    media: (result) => [result.image], // optional: every image of the result when omitted
  },
})
```

The workspace tools' `read` returns images this way: with `readImages` (the
default) a PNG, JPEG, GIF or WebP file of the workspace is an `Image`
result whose view's `media` selects it (see
[Workspace tools](#workspace-tools)).

Memory stores the result once, as the tool encoded it, images included, and
records where each image sent with it sits in that value (`MediaSlot`s, the
`media` of a `memory.tool-result`), so no image is stored twice. It checks
each image then, once (`toolResultMedia`): its data must be an image whose
type, size and fingerprint are the ones it states, as `mediaFromBytes` gives
them. An image that fails is an `[image unavailable: <why>]` line in the
stored view, one past `toolResultImages` (or past `requestChars` together)
its label line (the result keeps those lines as its `mediaNotes` too); a
failed call sends none. A result without a view (the raw
view, its encoded JSON) shows each image with its `data` replaced by its
fingerprint, and sends the images as images.

**What the model sees.** The memory plugins' `media` option decides, over a
user's attachments and the images tool results return alike. The current
turn's are sent as images first, while they fit: its attachments in order
(the images, then the text; an empty text part is left out), then its tool
results' images, newest result first and a whole result at a time. With
`inline`, the default, earlier turns' images are sent too, newest turn first
and a whole turn at a time (its attachments and its results' images
together), until one does not fit; with `none` an earlier turn's image is a
label line, `[image omitted: image/png, 182 KB, form.png: the failing form]`.
A result shown through a compaction, a digest or a spill's preview shows its
`mediaNotes`, then its images as label lines. All of them stay within `maxImages` images (never more than
`MEDIA_LIMITS.requestImages`) and `maxMediaChars` base64 characters; an image
that does not fit is a label line. With the defaults (`maxImages` and
`attachments` both 8, `maxMediaChars` the same `requestChars` a message's
images are held to) a message's own images always fit; `maxMediaChars: 0`
sends no image at all, for a host whose models read text only. Earlier
turns' images change only when a turn starts, or when the current turn's no
longer leave them room, so a provider's prompt cache mostly holds within a
turn. An image counts as `IMAGE_TOKEN_ESTIMATE` (1 600) tokens in memory's
estimates, and the context fingerprint hashes its fingerprint, not its data.
A request's render recipe records the budget (`media.maxChars`; a header from
before reads `requestChars`), so replays and dispatch checks rebuild the same
images.

The step loop sends a user's image as an effect/ai `file` part, and a tool
result's images as its `modelOutput` (the result's text, left out when empty,
then a `file` part per image):

| Route | A user's images | A tool result's images |
|---|---|---|
| `anthropic` and configured Messages endpoints (unless `images: false`) | image blocks | image blocks inside the `tool_result` |
| `openai`, `openai-codex`, OpenCode `gpt-*` (Responses API) | `input_image` | `input_image` inside the `function_call_output` |
| `google` (Gemini's chat completions), a configured chat endpoint with `images: true` | `image_url` parts (`data:` URLs) | one user message after the batch's tool messages, each result's images captioned `Images returned by <tool> (call <id>):` (merged with a user message that follows, captioned `The user's message:` when it has images of its own) |
| OpenCode's other models, `openai-codex:gpt-5.3-codex-spark`, configured chat endpoints without `images`, a `local` credential's URL | a label line per image | a label line per image |

`imageInputFor(selection)` (`@xandreed/plugin-models`) says whether a
built-in route reads images, and the model catalog states it per model
(`ModelCatalogEntry.input`, `["text", "image"]` or `["text"]`) for a host's
attach button, for the route the model is sent through: a configured
endpoint of a built-in provider's name by its protocol and `images`, a `local`
credential's URL as text only. On a route that does not, the models plugin sends every image
as its label line (`promptWithImageLabels`) instead of a provider error.

**A refused image.** A provider may still refuse an image (a size it reads
differently, an image it cannot decode). When a request fails with an
`InvalidRequestError` whose message names an image, the step loop calls the
turn's `StepRequest.onMediaRejected(reason)`: it records an `OmitMedia`
compaction naming every entry whose images that request sent, with the
provider's message as its reason, and the step is planned again and sent
once more, those images as label lines from then on. That plan keeps the
model choice, system prompt and directive of the refused one (no second
`policy.model` or `policy.step` call, no second step context). An
`OmitMedia` applies whatever memory strategy renders the log, so one bad
image cannot break a session. A request refused again fails the step; so
does a refusal when the request sent no image, and one that arrives after
the first part of a streamed response (its deltas went out, and tool
handlers may have run). The streaming path does not fall back to a settled
call over such a refusal. The rebuilt step publishes `context.built` and
stores a `request.prepared` again; the dispatch check reads the latest. On
`openai-codex`, an `error` event that refuses the request before any other
event fails it with a 400, as the HTTP Responses endpoint does, so a refused
image is an `InvalidRequestError` there too.

**Text views.** Transcripts (`raw`, `reference`), digests, ledgers and
summaries read a message as `userMessageText`: its text, then one label line
per image; the raw transcript shows a tool result's images with their data
elided. `queryLog` searches with each image's data elided
(`elideMediaData`). The bus and stored `turn.started` carry a user's images'
base64; a taken steer keeps its images in the inbox-marked
`memory.message`, with the receipt holding only ids. The bus's `tool.completed` (the stored one leaves the result out) and
the stored `memory.tool-result` (its `encoded` result) a tool's: elide them
before streaming events to a browser. The skill
matcher's decision hash adds the images' fingerprints only when there are
some.

**Compatibility.** Logs written before decode unchanged, a whitespace-only
message included; a result without images is stored and rendered exactly as
before. A 0.13 reader of a newer log drops the images it does not know (a
result's `media` slots included), fails on a message without text and on an
`OmitMedia` compaction, and a replay of a request with images diverges there
(`request.diverged`).

An `ArtifactRef` stays a reference by URL, a reference line in both modes.

## Sessions: one log per session

A session is one conversation's append-only event log: every turn's
message, memory, events and host records, the inbox, and the records of
background tasks. Two layers split the work:

- **`SessionLog`, the storage a host provides** (a core port). It is dumb on
  purpose: per session a head (`header`, `seq`, `revision`, an opaque
  `state` the sessions plugin owns, `updatedAt`, and `now`, the storage's
  clock) and the events (`{ session, seq, turn, kind, at, data }`).
  `meta`, `state` and `data` are `JsonObject`s (`Schema.JsonObject`: every
  value is JSON), so a reader decodes them; a store writes them as JSON
  text, which drops an `undefined` field, and `storedJson` turns any object
  into the `JsonObject` a store gives back.
  `create`, `head`, `list` (an owner's sessions, newest first, keyset
  paged), `read` (after a cursor, by kinds), `remove` (with its children)
  and `commit`. A commit is one compare-and-swap: it applies only when
  `revision` still equals `expect` (else `RevisionConflict`, told by its
  tag with `isRevisionConflict`: nothing was written, so a writer reads the
  head again and retries at once, `Effect.retry({ times, while:
  isRevisionConflict })`) and, with `notAfter`, only while the
  storage's clock has not passed it; events get dense `seq`s and the
  storage's time; a commit may carry state and no events. The storage's
  clock is whatever the backend reads: the memory and SQLite logs read the
  committing process's Effect `Clock` (SQLite once it holds the write lock),
  so instances sharing them need clocks in step; a host's own store may read
  its database server's clock instead.
  `sessionLogConformance(log)` checks all of it, including that one of many
  concurrent commits wins, that data with an `undefined` field commits and
  reads back without it, and that an event as large as a message's images
  at their limit (`MEDIA_LIMITS.requestChars` base64 characters) comes back
  whole. `sessionLogRecoveryConformance({ open,
  callerClock })` checks, inside one process, what must survive handles,
  reopening and interruption: `open` opens
  a new handle on the same data each time (scoped), and the kit checks that
  commits are there after closing and reopening, that two open handles see
  each other's commits and race with one winner per revision, that an
  interrupted commit is stored whole or not at all, and that a handle whose
  scope never closed blocks nobody; with `callerClock` (the backend stamps
  time with the caller's Effect `Clock`) a commit at exactly `notAfter` is
  accepted and one a millisecond later refused. An in-memory log passes only
  when every `open` returns the same store. Core ships `SessionLogMemoryLive`;
  `@xandreed/plugin-session-sqlite` ships `SessionLogSqliteLive(path)` and
  `makeSessionLogSqlite(path)` (the scoped log itself, a recovery subject's
  `open`); a host writes its own over its database. The SQLite log reads the
  clock once its transaction holds the write lock, so a commit that waited
  for another connection past its `notAfter` is refused and events carry the
  time they were written. A call waits for another connection's lock between
  tries in Effect, never on the thread (the connection's `busy_timeout` is
  0), and fails with `SessionLogError` code `store.busy` (`isStoreBusy`;
  SQLite's error is its `cause`) after 5 s;
  processes opening one new file at once wait for each other rather than
  fail. The file is WAL with `synchronous = NORMAL` (a power loss may drop
  the last commits, never tear one), and a row that does not decode fails
  with code `store.decode`. The file records its schema version
  (`PRAGMA user_version`): opening it applies the migrations it lacks, under
  the write lock, and a file a newer release wrote fails to open with code
  `store.version`, neither read nor written; a 0.14.0 file, without a
  version, opens as it was.
  `@xandreed/plugin-session-files` ships `SessionLogFilesLive(path)` and
  `makeSessionLogFiles(path)`, the log as files in a directory, on Node 24 and
  Bun, local or on a network mount (NFS): one immutable file per commit,
  written to a temporary file, flushed, then published by an exclusive hard
  link to its revision's name, so exactly one writer wins each revision and
  no handle ever waits on a lock (a stopped process blocks nobody). A commit
  file ends with its length and CRC-32: one at a session's tail that is not
  whole is moved to `quarantine/` with its bytes kept and the commit before it
  is the head; damage before the tail fails with `store.decode`. At most two
  file system calls are in flight per handle, each bounded by `stallMs`
  (10 s): one that does not answer fails with `store.stalled`, and so does
  every call after it until one, let through a `stallMs` later, answers (a
  stalled commit's outcome is known once the head is read again). Like the
  SQLite log it stamps time with the caller's `Clock`. A directory whose
  layout a newer release wrote fails to open with `store.version`; one
  without hard links (some SMB mounts), with `store.open`.
- **`Sessions`, consumption through a plugin** (`@xandreed/plugin-sessions`,
  requiring `SessionLog` and `TurnAdmission`). Hosts and `Agent.turn` both
  read and write sessions only through it.

**The stored format.** `STORED_FORMAT` (from `@xandreed/core`) is the version
of every shape the framework keeps in a session log: each journal kind's
payload, the log's own rows (`SessionHeader`, `SessionLogEvent`), the tasks
plugin's records and the sessions plugin's state in the head. It goes up by
one with each change to one of them that a reader can tell (a key, a type,
an optionality, a check; a description is not one), and `bun run
docs:generate` fails on a change that does not bump it: it fingerprints the
shapes into `docs/stored-format.json`, which keeps every format's
fingerprint. Every commit the sessions plugin makes stamps the session with
its release's format, raised from a lower one (or none: an earlier release
wrote none). A session a newer release stamped is refused before anything is
planned, with a `SessionLogError` of code `session.version`, by `begin`,
`deliver`, `drain`, `cancel`, `transact` and `fork`: this release cannot tell
what that release's records mean, and writes nothing beside them. `get`,
`list` and `read` still read it. A backend keeps its own marker for its own
layout: the SQLite file's `user_version` (`store.version`).

```ts
const view = yield* sessions.create({ owner })                 // SessionView: header, turns, title, open, pending
const address = { id: view.header.id, owner }                  // another owner's address finds nothing
yield* Effect.scoped(Effect.gen(function* () {
  const writer = yield* sessions.begin(address, { _tag: "User", userMessage, runId, key, command: {} })
  yield* agent.turn({ turn: writer, services }, use)              // the agent runs it; the host ends it
  yield* writer.append([{ kind: "answer.delivered", data: { text } }])
  const { pending } = yield* writer.end({ reason: "completed", failure: Option.none() })
  if (pending > 0) yield* sessions.drain(address, react)       // inbox items that arrived meanwhile
}))
// Or a turn the agent begins and ends: its result counts what its end left waiting.
const result = yield* agent.turn({ turn: { session: address, userMessage, runId }, services }, use)
if ((result.pending ?? 0) > 0) yield* sessions.drain(address, react)
```

**One turn at a time.** `begin` opens a turn with its `turn.started` (the
user's message, the host's `command`, the idempotency `key`, and the host's
`meta` and the turn it `resumes` when given) in one commit;
a second begin while a turn is open is `SessionBusy` (a host answers 409).
The same key again is `TurnDuplicate` with that turn, and the same key with
another message, command or `resumes` is `KeyConflict`: keys are found in the log, so
the check holds across restarts. A run id (`RunId`, minted per begin:
`RunId.make(crypto.randomUUID())`) names one turn's run (memory numbers
the turn's entries `<runId>:<n>` from it): a begin under a run id an earlier
turn of the session, or of the history a fork inherits, was begun with is
`RunIdReused` (code `turn.run-reused`), checked right after the key,
and opens nothing. The writer (`TurnWriter`) is the turn's one
way to write: `append`, `write(op)` in queue order, `transact(decide)`
(check, then append: decided again with the events others wrote when
someone commits first), `flush` (committed to storage), `closing(drafts)`
(drafts held for the end: stored only by its commit, right before
`turn.ended`, a later call replacing them; a flush stores none, a close
from elsewhere drops them; the framework's turn holds its reply there),
`end` (the closing
commit; it returns how many inbox items wait, and after a store failure a
later end tries again, the drafts still held) and `closed` (completes when someone else closed the
turn). A writer whose scope closes unended ends the turn, its held drafts
stored, as its held reply implies (completed or partial), else as failed
(`turn.unended`), or as interrupted (`turn.interrupted`) when the scope was
interrupted; a begin interrupted after its opening commit ends it as
interrupted (`turn.interrupted`) too. An append the store fails, or whose
commit dies with a defect (`session.defect`, logged with its cause), fails
the writer's every later write and flush with that error, so nothing waits
on it. The writer refuses a draft under a reserved kind (below) with
`ReservedKind` (`events.reserved`), storing nothing of that call, unless the framework's turn
wrote it (`frameworkDraft`: memory's events, the bus's and
`request.prepared`). Outside a turn, `Sessions.transact(address,
decide)` is the same check-then-append (a page action, a setting); the
framework's journal kinds (`JOURNAL_KINDS`; among them `request.prepared`
holds each request's full system text and tool declarations, see durable
model requests) and every bus event's name are refused there
(`RESERVED_KINDS`). A `Sessions` call whose commit keeps losing to other
writers (planned again from the new head each time, `retries` times, 8 by
default) fails with `SessionContended` (`session.contended`; a host answers
503) and stores nothing. `SessionLogError` is the store's own failure only:
unreachable, busy, or data that does not decode (`session.state`,
`session.decode`), with what failed underneath as its `cause`; a log that
answers what its contract rules out is a defect.

The writer's methods fail with `TurnError` (`@xandreed/core`): `TurnClosed`
once it takes no more writes (its `reason`: `cancelled`, `interrupted` for a
reaped lease, a stopped holder or a shutdown, `removed`, `timed-out` past
its time limit, or `ended` once its own end is stored or under way, or its
scope closed), `ReservedKind`,
`SessionContended` (`retries` conflicting commits in a row), the store's
`SessionLogError`, or a `HarnessError` (`session.defect`, and
`session.encode` or `session.state` for the writer's own state). So do the
turn's ports that write through it (`RunContext.flush`, `write` and
`activate`; the bus's `publish` and `drain`; memory's records; the step
loop's `run`; the tool registry's `open`, `activate`, `apply` and `select`;
`Turn.run`, `context`, `flush` and `write`; `TaskExecutor`) and
`Agent.turn`, which fails with `TurnError` or the host layer's error. Match
the tags with `Effect.catchTag("TurnClosed", …)`, never by comparing a
code; `harnessCodeOf` gives the code each stands for (`turn.closed`,
`events.reserved`, `session.contended`, `session.log`), the one a turn
failing with it stores. One carried as a defect behind a `never` error
channel (a subscriber's `Effect.orDie`) is restored as the failure it is
by `harnessDefectsAsFailures` (`isTurnError`, from any copy of core).
Plugin API version 3 marks this contract: a `Sessions` implementation
raises the tags, not `HarnessError`s of their codes, and
`sessionsConformance` checks it; plugins of API versions 1 and 2 still
load.

**Ownership** is configured:

- `{ mode: "lease", ttlMs, renew }`: several instances over one log. A turn
  is held until the storage's `now + ttlMs`; each of its commits carries that
  as `notAfter`, and the storage refuses a write that arrives later by its
  own clock. For the memory and SQLite logs that clock is the committing
  process's Effect `Clock`, read under the write lock, so instances sharing a
  lease over them need clocks in step; a host's store that reads its server's
  clock judges every instance by that one. `renew: "none"` fixes the lease
  at begin, `"on-commit"` extends it with each write, `{ everyMs }` also
  renews from a keep-alive (which notices a remote cancel within `everyMs`).
  This is the default: `{ mode: "lease", ttlMs: 60_000, renew: { everyMs:
  20_000 } }`.

  **The keep-alive** is what lets a step write nothing for longer than the
  lease: a provider call that streams for two minutes, or a tool that runs
  for five, would otherwise lose its turn under `"on-commit"` (the step's
  first write after it is refused, the turn closes with `TurnClosed`, and
  the next begin reaps it as `turn.lease`). While the turn's writer is
  open, every `everyMs` it commits the state alone with the lease extended,
  in order with the turn's writes; the first renewal comes one interval
  after the begin, whose own commit set the lease, so a turn shorter than
  `everyMs` costs no extra commit. Being in order, a renewal cannot pass a
  `write` (`RunContext.write`) or a `transact` still running: keep those
  shorter than the lease, and do slow work outside them. `everyMs` must be at most half of
  `ttlMs`, so a renewal lands before the lease runs out even when one is
  late: a slower keep-alive is refused when the layer is built
  (`config.options`, from `SessionsLive` and from the plugin's options).
  Each renewal is a commit, so it bumps the head's `updatedAt` (an owner's
  `list` orders by it: a session with an open turn moves up every
  `everyMs`) and, on SQLite, costs a write. A turn whose process hangs
  stays held while the keep-alive runs: the lease protects against a
  holder that stopped, not one that stalled; `Sessions.cancel` closes it,
  and its time limit does at the latest (below).
  `renew: "on-commit"` restores the behaviour before the keep-alive was the
  default.
- `{ mode: "process" }`: a turn is held without expiry for as long as the
  process that began it runs. The turn names its holder's host, pid and
  start time: a turn left open by a process of this host that has stopped
  is closed as interrupted when this one next touches the session, and a
  live process's turn is busy to `begin` and shown open. A holder on another
  host cannot be asked and
  stays held, so several hosts over one log use a lease; a holder that
  names no process (an older version) is reaped as before. How a process is
  named and asked is `SessionsLive(config, { liveness })`'s. The default detects
  a reused pid when it is the inspecting process's own pid and the recorded
  start time differs. Other pids are checked only with `kill(pid, 0)` (EPERM
  counts as running), so another live process reusing a holder's pid can keep
  the turn held. Hosts needing stronger identity checks can supply `liveness`
  or use lease ownership.

**A turn's time limit.** Whatever its ownership, a turn may run for
`turns.timeLimitMs` (6 hours by default, at most a week) from when its
writer is handed over, or for the `timeLimitMs` its begin gives
(`BeginTurn`, `NewTurn` for `agent.turn`, the `drain` options). Past it,
the instance that holds the turn closes it: its end is stored as
interrupted with the code `turn.time-limit` (resumable; its inbox items
wait again, an attempt counted), and its writer is closed with
`TurnClosed` of reason `timed-out`, so `Agent.turn` interrupts the turn's
body and fails with that `TurnClosed`. The limit is the holder's: a turn
whose holder stopped is reaped by its lease or its process as before, and
a hung turn the keep-alive keeps held ends at its limit at the latest.

**A turn is judged as it was taken.** It keeps how it was held, a lease end
or none and its holder's process, and every instance judges it by that,
whatever its own ownership: changing the ownership between restarts, or
instances that differ in it, neither holds a turn forever nor reaps one that
is still held. A process-owned instance leaves a leased turn alone until its
lease runs out; a leased instance holds a process-held turn while its
process runs, asked through its own `liveness` (a holder on another host
holds, one that names no process holds nothing). A writer whose closing
commit the store refuses, even when its scope closes, is logged (with
`efferent.session.id` and `efferent.turn`) and let go of by its instance:
the turn reads closed there at once, and the next `begin`, `deliver` or
`drain` there reaps it as interrupted (`turn.lease`), rather than the
session answering `SessionBusy` until the lease runs out or the process
exits.

A turn nobody holds any more reads as not open, and is closed as
`interrupted` by the next `begin`, `cancel`, `deliver` or `drain`: never by
a read, so loading or following a session runs nothing. `cancel(address,
turn)` ends exactly that turn as cancelled, durably, while it is held:
every reader sees `turn.ended`, a holder on this instance is interrupted at
once, and a holder elsewhere is refused at its next commit. A turn nobody holds any
more (its lease ran out, its process stopped) is not open: the cancel reaps
it, as the next begin or delivery would, as interrupted (`turn.lease`, its
inbox items waiting again), and answers `cancelled: false`, so a cancel and
a reap end it the same way whichever comes first; a cancelled or interrupted
turn can be continued by the next user's turn ([resuming a
turn](#resuming-a-turn)). `fork(parent, { inherit })`
makes a child session (a background task's): with `inherit` its history is
the parent's up to its last closed turn, and its turns count on from there.
`changes(address)` signals the session's followers at least once after each
commit this instance makes, the signals a follower has not taken merged into
one (a feed polls for the others' commits), and `lookup(address, key)` finds
a key's turn.

**Admission.** `TurnAdmission.admit(turn, open)` runs around the one commit
that opens every turn (a direct or queued user's, the inbox's, a task's),
never around the turn's later writes, so a host can count and open in one transaction: a
duplicate, a key conflict, a busy session or a turn that cannot be resumed
(`NotResumable`) fails inside it and counts nothing, and a refusal
(`TurnRefused`) opens nothing. `TurnAdmissionOpen` admits all.

**The vocabulary.** Each kind has one durable producer (the generated
[event reference](event-reference.md) has every kind's payload, its
sensitive content, the exact `RESERVED_KINDS` and the begin codes;
`journalSchemaOf(kind)` gives each framework kind's schema). The kinds the
framework writes are `JOURNAL_KINDS`; `RESERVED_KINDS` adds every bus
event's name (`TURN_EVENT_NAMES`), the ones never stored as themselves
included (`assistant.message`, `assistant.delta`, `tool.progress`,
`skills.activated`, `host`), and a host record may take none of them:

| Kind | Written by |
| --- | --- |
| `turn.started` (`runId`, `key`, `origin`: user, inbox or task; `userMessage`, `command`, `claimed`, and `meta`, `resumes`, queued `input` and a task's `task` when given) | `Sessions.begin`; memory reads it as the turn's TurnStarted |
| `turn.reply` | memory (`persistReply`), held for the turn's closing commit: stored right before its `turn.ended` |
| `turn.ended` (`reason`: completed, partial, failed, cancelled, interrupted; `failure`: the failing error's code; otherwise one of the framework's codes, `turn.failed`, `turn.defect`, `turn.interrupted`, `turn.unended`, `turn.lease`, or a code the closer passes to `end` itself, such as plugin-tasks' `task.turn` and `task.deadline`) | the writer's `end` (`turnEndingOf` the turn's exit), its scope, a cancel or a reap |
| `memory.system`, `memory.section`, `memory.step`, `memory.message`, `memory.tool-result`, `memory.tool-presentation`, `memory.digest`, `memory.skills`, `memory.compaction` | memory (`{ entry, runId, step, at, body }`) |
| `step.started`, `step.ended`, `step.usage`, `tool.started`, `tool.refused`, `tool.completed`, `completion.evaluated`, `context.built`, `decision.recorded`, `stream.fallback` | the turn's bus |
| `request.prepared` (the request's header: system text, tool declarations, model, cache key) | the turn, before each provider call (`TurnMemory.prepareRequest`) |
| `inbox.queued`, `inbox.dropped` | `deliver` or `enqueue`; a notice claim that failed too often |
| `inbox.taken` (`id`, `entry`) | `TurnWriter.take`, atomically with its user `memory.message` and queue removal |
| `task.started`, `task.cancelled`, `task.result` | `@xandreed/plugin-tasks` |
| anything else | the host, through the writer or `transact` |

Memory is rebuilt from `MEMORY_KINDS` by `entriesOfEvents`, which reads JSON
back with sorted keys, and requests send params, results and provider options
with sorted keys: the requests a model sees do not depend on the store (a
JSON column may reorder keys), and the SDK checks this over the memory,
SQLite and key-reordering stores against the golden requests.

A record is read by its fields only once decoded. `readStored(kind, events)`
decodes the events of one of the kinds in `StoredData` (`turn.started`,
`turn.ended`, `inbox.queued`, `inbox.dropped`, `inbox.taken`, `step.usage`,
`request.prepared`) with that kind's schema and fails with the first
`SchemaError`; a lookup by key goes through `readStoredKeys`, which decodes
a `turn.started`'s `runId`, `key`, `entry` and optional `input` and `resumes`
(`TurnStartedKeys`) or a `request.prepared`'s `runId`, `run` and `step` (`RequestPreparedKeys`), never a
user's message and its images. The framework's readers fail on a row that
does not decode (plugin-sessions and plugin-tasks with `session.decode`, a
turn with `memory.log` or `request.decode`) rather than skip it or read it
as something else.

**The inbox.** `deliver(address, { id, source, content })` stores a legacy
notice once per id, up to `inbox.maxPending` (20 pending notices and queued
inputs together). `begin(address, { _tag: "Inbox", runId })` claims every
waiting notice in its opening commit. Its `userMessage` joins their
contents, and `admitted.claimed` holds the notices; queued user input is
left for its own turn. With no notices, this begin fails with
`NothingPending`.

A notice is done when its turn ends completed, partial or cancelled. A
failed or interrupted claim returns it until `inbox.attempts` (2) turns
have tried and failed, then records `inbox.dropped`. A turn interrupted
before it wrote anything through its writer (`append`, `write`, `transact`
or `closing`) never tried its notices: they wait again with no attempt
counted. A turn reaped because its holder stopped counts as an attempt;
a takeover or shutdown does not.

**Queued user input.** `Sessions.enqueue(address, { id, userMessage,
delivery, source })` stores one `QueuedInput` for a later user turn.
`userMessage` is a `UserMessage`, including attachments, normalized before
storage exactly as for a direct begin. Each input keeps its own message;
inputs are never joined into one message. `source` is host metadata and is
never added to the model's message. `delivery` is `next` or `steer`; both
are eligible for an input drain. A running turn takes waiting steers
between steps, as described below; an untaken steer can still start its
own queued user turn.

Enqueue returns `{ enqueued, pending }`. Repeating the same id with the
same normalized message, delivery and source returns `enqueued: false`,
even after completion. Another payload under that id, or an id already
used by a notice, fails with `InputConflict` (`inbox.input-conflict`) and
writes nothing. An invalid attachment fails with `AttachmentRejected`;
a full pending queue fails with `InboxFull`. An identical repeat is still
acknowledged when the queue is full. Notice and input ids share the
session's namespace; a notice delivered under an existing input id changes
nothing.

`begin(address, { _tag: "Queued", input: id, runId })` atomically claims
that input and starts one turn with origin `user`, its exact stored
message and `claimed: []`. `admitted.input` holds the full queued input;
`turn.started.input` stores its id. The first attempt is keyed `input:<id>`;
a later attempt uses `input-retry:` followed by canonical JSON of the array
`[id, previousAttemptTurn, newRunId]`. Every attempt
needs a fresh run id. A missing input is `NothingPending`; an input already
acknowledged is `TurnDuplicate`. A direct `User` begin still refuses a
busy session; enqueue is the explicit way to save work while a turn runs.

Untaken queued input remains pending after failed, partial or interrupted turns,
across reopenings and regardless of the notice attempt ceiling. A
completed turn acknowledges it. Explicit cancellation also acknowledges
it, so a later drain does not undo the user's stop request. A user turn
that explicitly resumes an interrupted queued turn (`User` with
`resumes: n`) reclaims the same pending input in its opening commit.
Successful completion acknowledges it once, so a later drain cannot run
it again. Failed resumes leave it pending. A manual resume after an
explicit cancellation does not recreate an acknowledged queue slot.
The ordinary [resume rules](#resuming-a-turn) still apply; a queued retry
after failure or a partial reply starts a fresh user turn.

Every enqueue and begin uses the owner's `SessionAddress`; another owner
gets `SessionMissing`. The host's `TurnAdmission` sees the actual attempt
key and input id before the opening commit. A refusal leaves the input
pending. Queue claims obey the same one-open-turn rule and explicit
`takeOver` option as direct user turns.

**Durable steering.** Enqueue with `delivery: "steer"` to add user input to
the running turn. Before each step's plan, including step zero after a
resume, the loop takes every waiting steer, each as its own exact user
message. The take runs after `step.started` and before the request is
built. `delivery: "next"`, notices and the input already claimed as this
turn's initial message stay untouched.

`TurnWriter.steers` reads the fresh pending steers, including inputs
another instance enqueued. `TurnWriter.take(entries)` validates prepared
inbox-marked user messages against the immutable queue records, then makes
one compare-and-swap commit: the `memory.message` entries, one
`inbox.taken` receipt per input, and removal of those pending slots.
`memory.message.body.inbox` holds the input id, and the receipt holds only
`{ id, entry }`; the message's run ordinal and step stay on the raw memory
entry. Receipts copy no message or image bytes. A stale or ineligible
selection returns `false` and records nothing; invalid entries fail.

A taken steer is acknowledged by its stored message. If the turn fails or
the process stops before the next provider call, replay includes the
message and the input is not delivered again. `enqueue` of the same input
still returns false. A queued begin for an input already taken returns
`TurnDuplicate`, anchored to the receipt's consuming turn, without
fabricating a `turn.started.input` for it.

After each step settles, the loop checks pending durable steering; for a
whole reply this follows the host's completion verdict, including a true
verdict for a final response. Waiting steering requests another step when
the hard limits allow it. At the step cap, the run returns partial and the
steers remain queued: nothing is consumed or recorded under a step that
never starts. The degenerate-loop breaker and unrecoverable failures also
leave waiting input queued. An empty final probe is the completion
boundary. An input committed after that probe waits for the next turn,
even if the current turn has not stored its end yet.

Steering images use the same request budgets and omission labels as the
initial user's attachments. An `OmitMedia` compaction can name their
message entries; image refusal recovery and replay use the same selection.
Raw and reference transcripts show image labels rather than base64.
Summaries and condensed ledgers include actual inbox-marked user messages,
with continuation lines indented, while keeping host correctives out of
user intent. Result digests use the newest actual user message, including
a durable steer.

`TurnInput.steering` remains an in-memory effect returning optional text.
It is consulted only on a continuing path and is not durable; use enqueue
for input that must survive a restart. `agentTaskExecutor` uses the child's
or reaction's writer for durable steering and forwards its optional
`steering` effect to both turns.

**Draining selected work.** `drain(address, run, { take, maxTurns, meta })`
executes pending work while the session is free and the host admits it,
at most `maxTurns` (three) turns, each begun with `meta`. `take` defaults
to `all`; `inputs` selects queued user inputs, and `notices` selects legacy
notices. Each input starts a separate user turn, in enqueue order. With
`all`, the oldest waiting item's kind chooses the next turn: one queued
input, or a batch of all waiting notices. Notice batches preserve notice
order; they can include notices delivered after a queued input.

A successful `run` preserves its held reply's completed or partial
outcome, and ends completed when it held no reply. A failed one ends as
`turnEndingOf` gives: its error's code (a `TurnError` carried as a defect
included), else `turn.failed`, `turn.defect` or `turn.interrupted`.
A callback that interrupts itself counts a notice attempt even without a
write; a drain interrupted from outside counts one only if its turn wrote
something. Queued input is retained under either interruption. The drain
continues while selected work waits, including deliveries during a turn,
until no selected work remains, the session becomes busy, admission
refuses or its turn limit is reached.

Hosts can arrange execution after enqueue or after the active turn closes,
using `drain` or a queued begin followed by `Agent.turn` with that writer.
`TurnResult.pending` and each writer's end report all waiting notices and
inputs, even when a drain selects only one kind. A delivery commits before
the active turn's closing commit and is included in its pending count, or
after it and finds the session free. Task result reactions use
`take: "notices"`; hosts whose reaction callback handles notices only
should select it too.

**Automatic draining.** `InboxDrainLive` from `@xandreed/plugin-sessions`
executes work for explicit `owners`. Build it beside the agent with
`agentInboxRunner` from `@xandreed/sdk`, using the same `Sessions` instance.
The runner executes the borrowed writer through `Agent.turn`; the drainer
begins and ends it. The default runner selects skills, runs the loop once,
and preserves its completed, partial or failed outcome. A custom `use`
can choose the turn's execution.

```ts
import { Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { processActivity } from "@xandreed/core"
import { InboxDrainLive, SessionsPluginLive } from "@xandreed/plugin-sessions"
import { Agent, agentInboxRunner, SessionLogMemoryLive, TurnAdmissionOpen } from "@xandreed/sdk"

declare const agent: Agent
declare const model: LanguageModel.LanguageModel
const sessionServices = yield* Layer.build(SessionsPluginLive().pipe(
  Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
))
const sharedSessions = Layer.succeedContext(sessionServices)
const runner = agentInboxRunner(agent, { services: Context.make(LanguageModel.LanguageModel, model) })
  .pipe(Layer.provide(sharedSessions))
const draining = yield* Layer.build(InboxDrainLive({ owners: ["account"] }).pipe(
  Layer.provideMerge(runner), Layer.provideMerge(sharedSessions),
))
const activity = yield* processActivity.pipe(Effect.provide(draining))
```

Keep this layer's scope open while the host accepts input. It performs a
startup sweep, consumes `Sessions.waiting`, and sweeps every second for
foreign-process commits. That stream broadcasts a post-subscription signal
and coalesced local commits without disclosing an address. Discovery pages
through each owner's sessions and their children. Four fixed workers by
default run at most one attempt per session, with fair turns between
sessions. Busy, refused or unfinished work retries with bounded exponential
backoff (250 ms to 30 s); unrelated wakes preserve that deadline. Input is
never discarded because execution failed repeatedly.

`resume: { _tag: "Before" }` is the default: finish the oldest eligible
interrupted user root before starting queued work, with `Continue.` as the
resume message. Supply `userMessage` to change it, or select
`{ _tag: "Never" }` for queued work only. An intentional cancellation stops
automatic resumption of that branch. `takeOver` defaults to false; true
asserts the previous holder is gone and grants takeover only to an initial
startup attempt, never to a later retry or newly discovered session. Scope
closure stops the drainer's fibers. A provided `TurnShutdown` stops new
attempts when the host starts shutting down.

**Background tasks** (`@xandreed/plugin-tasks`). A task is one turn of a
child session, a fork of the conversation or an empty spawn, whose id is the
task's. `Tasks.start(parent, { instructions, mode })` records `task.started`
in the parent, checked against the tasks stored (a task does not start
tasks: a session whose origin is `task` is refused with `TaskRefused`
`depth`, while a host's own fork of a conversation may start them; a
session runs `maxRunning`, two, at once), creates the child once
that record is stored (a start refused or not stored leaves none), and
hands the work to the host's `TaskRunner`: `InProcessTaskRunnerLive` forks
it on this process (its own fiber, interrupted with the layer, counted by
the `TaskActivity` the layer also provides), and a serverless host
registers it with its `waitUntil`. Starting a `taskId` again starts it
once, and also creates the child a start that stopped half way left
without one; the same id with other instructions or another mode is
`TaskConflict`, and an id naming a session that is not the parent's task
child (the parent itself, another conversation) is `SessionExists`.
`status(parent, taskId)` and `cancel(parent, taskId)` take that id, a
`ConversationId`; the model's `task_status` answers a string that is not
one as it answers any unknown task. A
store failure while the child's result is stored is logged as a warning,
and the task then reads as interrupted (`task.lost`). The work begins the
child's turn once (its key is the task's) as a task's turn
(`BeginTurn.Task`: origin `task`, its `task` the `TaskRef` of the task's
and the parent's ids, the instructions its message, stored in its
`turn.started` and shown on `admitted` and to `TurnAdmission`; it cannot be
resumed), runs it through the host's `TaskExecutor.turn` until the runner's
deadline, records `task.result` before the turn closes, delivers the result
to the parent's inbox (`task:<id>`, once) and drains the parent, whose
`TaskExecutor.react` answers it after the turn in flight. The notice says
how the task ended in words (`completed`, `stopped before it finished`,
`failed`, `was cancelled`, `was interrupted`), then frames the task's words:

```text
[Background task <taskId> completed]
<task-output>
…the task's reply…
</task-output>
```

The runner's absolute deadline bounds admission, reads, delivery and parent
reactions as well as the child model call. Execution stops `closingReserveMs`
(2 s, at most half the budget) before it, leaving that time to store the
child's result and ending, deliver it and close the parent's turn; work the
deadline itself cuts is logged with the task and how long it ran. A
finite-budget runner admits at most one parent reaction and interrupts it at
the execution cutoff: a reaction cut after it recorded its answer
(`turn.reply`, held for the reaction's end, which stores it) ends partial, so its notice is done and never answered twice,
and one cut before ends interrupted, so the notice waits again. A parent turn
admitted past the cutoff ends interrupted without reacting, and its notices
wait with no attempt counted. A notice whose reaction cannot begin stays in
the inbox; an undelivered result remains in the child for `reconcile`.
Serverless hosts also leave invocation headroom for interrupted scope
finalizers to close their writers.

The first of a child's `task.result` and `task.cancelled` ends the task.
`cancel` stops a waiting or running task (its turn is cancelled, nothing is
delivered); `status` and `list` read where tasks stand; `reconcile(parent)`
runs tasks a lost runner never ran and delivers results it never delivered
(its caller drains). A child the host will not admit fails with the host's
reason, a turn past its deadline ends interrupted, and an abandoned turn is
delivered as interrupted. The `meta` given to `start` goes with the task:
the child's turn and the parent's reactions to its result are begun with
it, so a `TurnAdmission` that counts by tenant or quota key counts them as
the starter's. `startedBy` (a run id and a turn number) records in
`task.started` the turn whose run started the task. With `tools`, the model
gets `start_task` and `task_status` (off by default); `start_task` starts
the task with the turn's own `meta`, unchanged, and the turn as
`startedBy`, and tells the model that a fork sees the conversation up to
the user's latest message, not that message or what the turn did since. A
task's turn stored before tasks had an origin of their own reads as a
user's, its task id in `command.task`, and a task started before
`startedBy` may carry its run's id in `meta.runId`.

The executor runs the turns the tasks plugin begins and ends, with `Tasks`
in context (`TaskExecutor`'s methods require it): the tasks plugin
provides its own around the turns it hands over, and a host that drains a
parent through the executor's `react` itself provides one. The sdk's
`agentTaskExecutor(agent, { services, child?, react? })` is one over an
agent (`Agent.turn`, or any `TurnRunner`): it runs the child's turn with
`child(turn, task)` and the parent's reaction with `react(turn)`, each by
default the turn's skills selected, then one run of the step loop, whose
text is the reply, with `services` and that `Tasks` as the turns'
services, so their `start_task` and `task_status` (which declare `Tasks`)
open: a task's own `start_task` is refused (`depth`), and a reaction's may
start another task. Build `Tasks`
beside the agent rather than as one of its plugins (the executor needs the
agent first):

```ts
const agent = yield* Agent.define({ plugins, turnServices: [LanguageModel.LanguageModel] })
const tasks = TasksLive(tasksDefaults).pipe(Layer.provide(Layer.mergeAll(
  sessionsLayer,
  InProcessTaskRunnerLive(),
  agentTaskExecutor(agent, { services: Context.make(LanguageModel.LanguageModel, model) }),
)))
```

**Following a session.** plugin-render's `SessionsJournalTailLive` is a
`JournalTail` over `Sessions`: the render feed replays a session's events
after a cursor, then follows `changes` and polls. The events guide
[serves it over SSE](events.md#serving-turns-over-http) with a projection
that keeps prompts and tool input and output on the server, and shows
[what another process needs to follow a session](events.md#reading-the-journal)
(the same `SessionLog`, and polling).

### Busy signal and graceful shutdown

A process that serves turns needs to say whether it is busy (a `/ping` a
load balancer or a deploy reads) and to stop without cutting turns in half
(a SIGTERM before a restart). Three optional ports in `@xandreed/core` count
what this process has in flight and stop it:

- `TurnActivity`: the turns its `Sessions` has in flight, read at one
  moment (`current`). A begin counts from the moment it is asked for,
  through the host's admission (which may queue it) and the opening commit
  (which may wait on the store), until its writer is handed over or it
  fails (`beginning`, a count). The turn then counts as open, with its
  `session`, `turn` and `since` (this process's Clock time once its begin
  was stored), oldest first, until its writer's scope closes (a turn ended
  but whose scope is still open still counts, beside the session's next
  turn). A begin that failed after storing its turn counts until its scope
  has closed that turn. `SessionsLive` and `SessionsPluginLive` provide it.
  A turn held by another process over the same log is that process's; with
  several `Sessions` instances in one process, each counts its own.
- `TaskActivity`: the background work its `TaskRunner` runs, counted from
  the moment `run` hands it over until it ends. `InProcessTaskRunnerLive`
  provides it; a runner that hands work elsewhere (a serverless
  `waitUntil`) has none unless the host provides one.
- `TurnShutdown`: how that `Sessions` stops. `refuse` makes every begin on
  it fail from then with `TurnRefused` of reason `shutdown`
  (`isShutdownRefusal`; code `turn.refused`, a host answers 503), a user's,
  an inbox's or a task's, while the turns already open run on and
  deliveries are still stored. `interrupt` refuses too, then closes every
  turn the instance holds: each end is stored while the log is open, as
  interrupted with the code `turn.shutdown`, its inbox items waiting again
  with no attempt counted, and its writer is closed, so `Agent.turn`
  interrupts the turn's body (it races `TurnWriter.closed`) and the turn
  fails with `TurnClosed`. A begin whose opening commit landed before the
  interrupt is closed the same way as soon as its writer is handed over.
  `SessionsLive` and `SessionsPluginLive` provide it.

`SessionsLive` also provides `WaitingInput`: fresh owner-checked counts of
unclaimed queued user inputs in sessions this instance has observed, plus
cached knowledge and an idle wait. Notices do not count. Reading, getting,
creating or listing a session establishes that knowledge; it does not
enumerate other owners. Its idle wait polls foreign changes at
`inbox.pollIntervalMs` (100 ms by default). `InboxDrainLive` supplies
`DrainActivity`, which counts active attempts from admission through end,
excluding scans and backoff.

`processActivity` reads available probes into `ProcessActivity`:
`{ openTurns, beginningTurns, runningTasks, waiting, queuedInput, inFlight,
busy, stopping }`. `waiting` contains positive per-session counts;
`queuedInput` sums them. `inFlight` includes open or beginning turns, tasks
and drain attempts; `busy` also includes queued input, even without a
drainer. A missing probe contributes nothing. A storage failure from an
installed queue probe remains a typed `SessionLogError`; it cannot report
false idle. These counts cover the instance's known sessions. A restarted
instance discovers backlog as its owner-scoped sweep observes sessions.

`awaitIdle({ timeout })` waits for running work and queued user input,
then returns activity. `awaitIdle({ queued: false, timeout })` waits only
for running work and performs no queue storage I/O. A timeout reports local
work with cached queue knowledge. `agent.activity` reads the agent's captured
runtime services, including probes passed in `Agent.define.services` or
provided by runtime plugins. A drainer built beside the agent or services
passed only to a turn are observed with `processActivity` over the composed
host context. `stopping` becomes true once shutdown begins, for a `/ping`
to answer 503 so a load balancer sends the process no more turns.

**A shutdown within a deadline.** `shutdownGracefully({ deadline, reserve
})` stops this process's turns while its services are still open, in
three steps: refuse every new begin (`TurnShutdown.refuse`); wait until
idle (`awaitIdle({ queued: false })`) for the deadline less its reserve; then, if anything is
still running, close those turns (`TurnShutdown.interrupt`) and wait out
the reserve for their scopes to close and for the tasks they stop to end.
`deadline` is the whole time from the call; `reserve` is the part kept for
the last step (`DEFAULT_SHUTDOWN_RESERVE`, 2 s, and never more than the
deadline). It returns a `ShutdownReport`: whether the process was `idle`
in time, the turns it `interrupted`, and what was still in flight when it
returned (`left`). Queued input remains durable for restart and may keep
`left.busy` true even when `idle` is true; `left.inFlight` identifies work
still running. Shutdown uses cached queue knowledge and stays infallible. A
`Sessions` without `TurnShutdown` is waited for and never interrupted.
`agent.shutdown(options?)` is `shutdownGracefully` over the agent's runtime
services, the same ones `agent.activity` reads; its options default to
`AgentConfig.shutdown`, else a deadline of `DEFAULT_SHUTDOWN_DEADLINE`
(25 s). Give `AgentConfig.shutdown` and closing the scope `Agent.define`
ran in shuts the agent down first, before its plugins close (a sessions
plugin in its graph, and the log under it). Begins stay refused once a
shutdown started: it is for a process about to stop.

A turn the shutdown closed is resumable like any interrupted turn: the next
process begins it again with `resumes` (below) at once, without waiting for
a lease to run out. A background task refused by the shutdown before its
turn began stays pending, its child untouched, and the next process's
`Tasks.reconcile` runs it; a task whose turn was closed ends interrupted
(`task.lost`) and its notice waits in the parent's inbox. A task that
finishes while the process stops still stores its result and delivers it,
where it waits (its parent's reaction is refused) until the session is
next drained.

```ts
// Inside the host's Effect.gen, in the scope the process closes last.
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, isShutdownRefusal, TurnAdmissionOpen } from "@xandreed/sdk"
import type { TurnBeginError } from "@xandreed/sdk"

const sessions = SessionsPluginLive().pipe(Layer.provide(Layer.merge(SessionLogSqliteLive(".efferent/runtime/sessions.db"), TurnAdmissionOpen)))
// The runner on top of the sessions, not beside them: closing interrupts its tasks while the log is still open.
const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(sessions)))
const agent = yield* Agent.define({
  services, plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel],
  // Closing this scope shuts the agent down first (keep it below the platform's grace period).
  shutdown: { deadline: "25 seconds" },
})

// GET /ping: 200 with the counts (a session id is the host's to show or not).
const ping = agent.activity.pipe(Effect.map((now) => ({ busy: now.busy, openTurns: now.openTurns.length, runningTasks: now.runningTasks })))

// A turn that could not begin: 503 while the process stops, so the client retries against the next one.
const statusOf = (refused: TurnBeginError) => refused._tag === "TurnRefused" && isShutdownRefusal(refused) ? 503 : 409

// On SIGTERM: stop the turns within the deadline; then the host stops its server, then closes the services' scope.
const onSigterm = agent.shutdown().pipe(Effect.tap((report) => report.left.busy
  ? Effect.logWarning(`stopping with ${report.left.openTurns.length} turns and ${report.left.runningTasks} tasks in flight`)
  : Effect.log(`stopped: ${report.interrupted.length} turns interrupted, resumable`)))
```

What stops a turn is its writer closing under it (`Agent.turn` races it),
so the host's request fibers end soon after the interrupt, each with its
turn's `TurnClosed`; stop them (an HTTP server's shutdown) before closing
the services. A turn begun outside `Agent.turn` stops at its next write
unless the host races `TurnWriter.closed` the same way (the tasks plugin
does). A turn's writer lives in the turn's own scope, not in the services'
scope, and `SessionsLive` holds no finalizer over it: closing the services
without a shutdown first does not stop that turn, it closes the log under
it (`SessionLogSqliteLive` closes its database). A turn still running when
its log closes cannot store its end: the next process reaps it as
interrupted with `turn.lease`, under a lease once the lease runs out (until
then a begin on that session fails with `SessionBusy`, unless it takes the
session over), under process ownership at the first touch after the
process is gone. Build the task runner on top of the sessions with
`Layer.provideMerge`, as above, so it closes first; `Layer.mergeAll` closes
its layers at the same time, and a task's end may then race the log's
close.

A host may still drain by hand: a `TurnAdmission` that refuses while
draining (its own `TurnRefused`), `awaitIdle({ timeout })`, then stop the
request fibers and close the services. `packages/sdk/src/activity.test.ts`
runs both, including a drain that times out and a shutdown that interrupts
a request's turn and a task's turn at its deadline.

### Resuming a turn

A turn that was cancelled or interrupted can be continued by a new user's
turn that names it: `begin(address, { _tag: "User", userMessage, runId, key,
command, resumes: n })`, or with the agent `agent.turn({ turn: { session,
userMessage, runId, resumes: n }, services }, use)`. Turn `n` must be the
session's last turn begun by a user and must have ended `cancelled` or
`interrupted`. Two kinds of turn may have run since: inbox turns (a task
result delivered meanwhile is answered first and does not stand in the
way), and earlier resumes of turn `n` that failed, were cancelled or were
interrupted, so a resume that did not complete can be tried again (see
keys, below). A turn reaped because its holder stopped (`turn.lease`)
counts as interrupted, including one the resuming begin reaps itself, and
so does one taken over (`turn.takeover`, below).
Otherwise the begin fails with `NotResumable` (`session`, `turn` and a
`reason`) and opens nothing: `missing` (no such turn in this session's own
log; a fork's inherited turns are its parent's), `inbox` (an inbox turn),
`task` (a background task's turn), `superseded` (another user's turn began
after it, a resume of it that completed or ended partial included) or
`finished` (it ended completed,
partial or failed, a `turn.unended` scope included); its code is
`turn.not-resumable`. The check runs in the commit that opens the
turn, after the key's (`TurnDuplicate`, `KeyConflict`) and after
`SessionBusy`. `resumes` is typed as a number: one that is not a whole
number of at least 1 names no turn, and is refused as `missing` before
anything else, the host's admission included. `resumeRefusal(n, turns)`
from `@xandreed/core` is the rule, for a host that checks before it asks.

The new turn is an ordinary user's turn (origin `user`, numbered next) whose
`turn.started` carries `resumes: n`; `resumes` is shown on `admitted`
(`RunContext.admitted`, `Turn.admitted`), on `TurnToAdmit` and on the bus
`turn.started`, only when given, and it is part of the key's fingerprint.
Memory is not rewritten: the new turn's requests are rebuilt from the log as
always, so the model sees turn `n`'s message and every step it stored,
then the new turn's message. A plain new turn, without `resumes`, sees
exactly the same memory: `resumes` records which turn the new one
continues, and refuses to continue one that has been answered since; it
changes nothing the model is sent. Send the original message again to
re-run the request, or a short instruction such as "Continue where you
stopped.".

**Taking a session over.** A turn whose holder stopped (its process was
killed, its machine restarted) stays open until its lease runs out, or,
under process ownership, until its process is seen to be gone: until then a
begin fails with `SessionBusy`. A host that knows the holder is gone (it
restarted the process that held it, or moved the session) begins with
`takeOver: true` (`BeginTurn`, `agent.turn({ turn: { …, takeOver: true } })`,
`drain(address, run, { takeOver: true })`): the opening commit closes the
open turn at once, whatever its lease, as `interrupted` with code
`turn.takeover`, its inbox items waiting again with no attempt counted, and
the same begin may resume it (`resumes: n`). A turn no longer held is reaped
as any begin reaps it (`turn.lease`). The framework does not judge whether
the holder is really gone: that is the host's word. A holder still running
is fenced at its next write, which fails with `TurnClosed` (`interrupted`)
and stores nothing (on the taking instance, its writer is closed at once);
what it did before, a tool's side effects included, is not undone.

**What is durable after a cancel or an interrupt** is what the turn's
writer committed before the turn was closed:

- `turn.started`;
- every whole step: a step's assistant message is recorded before its
  tools run, and each result as it returns (`memory.message`,
  `memory.tool-result`), beside its `step.*`, `tool.*`, `step.usage` and
  `context.built` events and its `request.prepared`;
- of the step in flight, only what was already stored: its `step.started`,
  `context.built` and `request.prepared` (flushed before the provider call),
  its assistant message once the complete response passed the gate, each
  `tool.started` before its handler runs, and every tool result already
  stored. Calls run one after another or concurrently (`toolConcurrency`),
  so one result can be durable while another call is still running;
- `turn.ended`: `cancelled` with no failure after a cancel; `interrupted`
  with `turn.interrupted` after an interruption, or `turn.lease` when reaped.

A cancelled or reaped turn has no `turn.reply`: the reply is stored only
with the turn's own end, and a close from elsewhere drops it. An interrupted
turn may keep a failed `turn.reply` with no text (the turn recorded its
reply as failed before its end), which the model never
sees. For each non-provider call with no recorded result, memory renders a
failed `ToolInterrupted` result in the resumed request. It says the call
may have run and to check the current state before deciding whether to call
it again. This repair is only rendered, never stored as an actual result.
What a tool did is not undone: a tool with side effects makes them safe to
repeat, for example keyed by its input.

The raw encoded result is committed before host view rendering or a
digester runs. A later `memory.tool-presentation` references that result's
entry and adds its view, subjects, artifacts and image selection, without
copying its encoded value or image bytes. If presentation fails or the
process stops during it, the result still replays through its raw view.
Messages and results carry the run ordinal when recorded by the step
request, so concurrent runs of one turn retain separate result identities.
Rendering keeps each request beside its own results even when concurrent
runs interleave or reuse a provider call id. Views, digests and compact
views use that request's input; `toolInputOf(entries, result)` exposes the
same lookup to hosts.

`toolCallStatesOf(events)` reads the durable per-call evidence: `Requested`,
`Started`, `Returned` (a handler completion without its stored result),
`Completed`, or `Refused`. A missing result alone never proves that a call
did not run. Older lifecycle records without a pairing id cannot establish
which request they belong to.

**Keys.** `Agent.turn` keys a resume `resume:<n>` unless the host gives a
key, and each try needs a new run id (`RunIdReused` otherwise). A
retry of the same resume is `TurnDuplicate` once its turn has begun,
however that turn ended (`lookup(address, "resume:<n>")` finds it), and
the same key with another message or no `resumes` is
`KeyConflict`; a begin refused before it opened anything
(`NotResumable`, `SessionBusy`, `TurnRefused`) stored nothing and can be
retried with the same key. A resume whose turn failed (a provider error,
say) does not stand in the way of turn `n`: resume turn `n` again with a
new key, such as `resume:<n>:2`. A resume that was itself cancelled or
interrupted can be tried again the same way, or resumed in its turn
(`resumes: m`, the resuming turn's own number, on `admitted.turn`; its
default key, `resume:<m>`, is new). A host that passes its own keys needs
a new key for each attempt.
