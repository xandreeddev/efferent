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
Two providers of a service require a `bindings` entry selecting the instance
id. Runtime plugins cannot require session services. Dependencies are checked
before activation. An agent whose turns would have no `ConversationMemory`,
`ToolRegistry` or `StepLoop` (none provided by a plugin, none in `services`,
none declared in `turnServices`) is refused by `Agent.define` with
`config.graph`, naming the missing service, rather than failing its first turn.
A `HarnessConfig` given to `resolveGraph` with `profile` or `profiles` is
refused (`config.profile`): the graph does not select profiles, so a host
folds the selected profile's plugins, bindings and system into the
configuration first.

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

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`, leaving test code out (`*.test.*`, `testing` modules and
folders). `bun run verify:packages` refuses a build that is not of `HEAD`, was made
from a tree with changes (unless `--allow-dirty`) or holds test code; it packs them, installs them
in a temporary external project through a temporary local npm registry, and exercises
SDK sessions, replacement plugins, persistence, forks and custom evals on Bun,
then imports every Node-capable package on Node; it also runs the `FileSystem`
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
agent.turn                       Agent.turn, or a host's composition with traceTurn(writer)
└─ engine.run                    one run of the step loop (turn.run)
   └─ engine.turn                one step (engine.step is its one-based number)
      └─ LanguageModel.*         effect/ai's span of the model call
         ├─ providers.generate   the models plugin's call (model, usage, finish reason)
         └─ tool.<name>          the tool registry's call, refused calls included
            └─ (the handler's own spans)
```

`agent.turn` starts once the turn is admitted (after `Sessions.begin`; a turn
that could not begin has no span) and encloses the turn-dependent plugins,
the host's layer, the tools opened, `use`, the reply and the end. It carries
`efferent.session.id`, `efferent.run.id`, `efferent.turn`,
`gen_ai.conversation.id` (the session), `efferent.origin` (user or inbox)
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

Spans nest where their work runs, not where a context was captured. The
framework captures contexts to run work later (the services a tool handler
runs with, a policy's callbacks, a model layer's dependencies, the services
`Turn.run` replays, a bus subscriber's, the turn's `TurnInput.services`)
and drops the trace state of where it captured them before providing them
again (`replayableContext`): the parent span (`Tracer.ParentSpan`), the
span annotations and links, and `CurrentTraceContent` (`Agent.turn` keeps
one the turn's `TurnInput.services` carry, see trace content). A tool call stays
under the model call that made it and a handler's spans under its
`tool.<name>`, a host span wrapped around `turn.run` is the parent of its
`engine.run`, a model layer built under a span does not pull its calls
there, and annotations the host set where it built a layer or captured the
turn's services (`Effect.annotateSpans`) do not replace the turn's ids. An
inline bus subscriber's spans nest under the publisher's. A parent span in
`TurnInput.services` or `AgentConfig.services` is ignored: to put a turn
under another span, wrap the `Agent.turn` call in `Effect.withParentSpan`.
The in-process task runner is the exception: it starts each piece of work
on a new fiber with the services it was built with, so the work nests under
the span current where the runner was built. Host code that captures a
context to provide it later passes it through `replayableContext` too.

**Metrics** (Effect `Metric`s, exported with the spans' exporter):

| Metric | Attributes | Counts |
|---|---|---|
| `efferent.turns` | `efferent.outcome` | turns `Agent.turn` ran, once admitted |
| `efferent.turn.duration` | `efferent.outcome` | each such turn's time from admission to its end, in milliseconds; for a turn the host began (its `TurnWriter` passed in), from when `Agent.turn` took it to when `Agent.turn` returned, before the host ends it |
| `engine.runs` | `engine.outcome`, `engine.reason` | step-loop runs |
| `engine.tool_calls` | `engine.tool`, `engine.ok` | tool results the loop received |
| `engine.corrections` | `engine.kind`: `malformed`, `degenerate-nudge`, `stream-fallback`, `media-rejected` | the loop's self-corrections, a stream falling back and a step sent again without the images a provider refused included |
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
exporter retention.

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
event carrying a `TokenUsage`, and is stored as one `step.usage` record
(step, model, usage):

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
  the same names are counters per `llm.model`.

A turn's usage counts what the step loop received. It does not count calls
outside the loop: a memory digester's or summarizer's `UtilityLlm` calls
(their `UtilityCompletion.usage` goes to their caller; the models plugin's
counters do include them). Nor does it count a provider attempt whose
response never reached the loop as a decoded response: a malformed response
the loop corrects, or an attempt that failed (one the models plugin retried,
a stream cut off after its first part). A provider may bill those, so a
turn's usage can be below the provider's invoice.

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
| configured endpoints and `local` credentials | as chat completions | as chat completions | `completion_tokens_details.reasoning_tokens`, whatever `standardOnly` says |

## Host-planned initial tool batch

`runLoop` accepts optional `initialStep: [{ name, params }]`. A host can classify
from a finite plan set or construct a structured plan, validate the whole batch
against its permissions and references, and persist its decision before calling
the loop. The loop uses an in-memory Effect AI response to dispatch the batch
through the ordinary argument decoder and instrumented toolkit without a provider
request. The initial batch counts as step zero; completion, concurrency, events,
errors and tail persistence follow the ordinary loop path.

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

`@xandreed/core` exports `DecisionRecord` and `DecisionOutcome` schemas. A record
names the finite candidates, context/candidate hashes, policy version, provider
attempt IDs, selection, host validation, applied fallback and optional reported
probabilities. The outcome links the decision to a run's tool invocations, model
attempts and delivered journal sequences. Downstream links describe chronology;
they do not prove that a selector caused an improvement. Hosts own capture,
redaction, storage, candidate eligibility and validation.

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
`use` fails, is interrupted, or finalizer work fails. On failure or
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
number, key, origin, command and claimed inbox items) and on the bus
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
Publication is inline
and ordered, depth-first up to a cap: every subscriber runs before `publish`
returns, so state a subscriber changes is visible to the next step, and a
subscriber failure fails the turn (one during a tool call, on `tool.progress`
or an event the handler publishes, also stops the handler; the model never
sees it as the tool's result). Within a step the order is `step.started`
< `tool.*` < `step.ended` < `completion.evaluated`. Background work goes to
`turn.tasks.fork(tag, effect)`.

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
one the model saw. A strategy decides compactions and digests (`maintain`)
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
configuration, prompt cache key, call policy, the memory strategy's render
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
turn's cache key and the `CurrentModelCallPolicy` where the turn runs; the
check compares them with what the model call reads, `CurrentPromptCacheKey`
and `CurrentModelCallPolicy` where the loop dispatches, so a step loop that
does not stamp the request's `cacheKey` on its calls fails the step (the
`stepLoopConformance` kit checks that it does). Prompt data is frozen; a
stream fallback checks the same contract again, and a failed check fails the
step, streamed or not, instead of falling back. Host-planned batches make no
provider request and create no request header.

`replayModelRequest(events, runId, step)` reconstructs one historical request
from the memory up to its header's cut, excluding later responses. It uses
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

Effect AI models hide provider configuration inside adapters. Efferent's
provider adapters and routers describe their public options with
`describeModel(model, { provider, model, settings })`; hosts should do the
same for custom models, preserving the descriptor when wrapping a model
(`modelRequestDescriptorOf` reads it). An undescribed model is recorded as
explicitly opaque: its prompt/tools are checked, but its private provider
settings cannot be validated. Credentials never belong in `settings`.
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
the open, not as an argument. `ToolRegistry.open(session)` requires
`RunContext` and a scope, and its handlers run with the services of where it
is opened (captured at open); the `IntentMatcher`, `ActionPolicy` and
`PermissionGrants` there are used when present.

`memoryConformance(memory, services)`, `stepLoopConformance(loop)`,
`turnConformance(runner, services)`, `sessionLogConformance(log)`,
`sessionLogRecoveryConformance(subject)`, `sessionsConformance(subject)`,
`taskRunnerConformance(make, { interruptsOnClose? })`,
`tasksConformance(make)`, `toolRegistryConformance(make)`,
`fileSystemConformance(subject)`,
`bashConformance(subject)`, `authStoreConformance(store, { refresh?, corrupt? })`,
`settingsStoreConformance(store, { writable, corrupt? })` and
`modelCatalogConformance(catalog, { includes? })` (from `@xandreed/core`) are
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
and executor; the TaskRunner kit checks a runner the host makes. Both wait
up to two seconds on the live clock for background work, so run them
without a `TestClock`; so do the turn kit's checks that cancel a turn or
fill a background queue. The registry kit runs each turn over `TurnLive` and
checks every `tool.refused` reason. `@xandreed/plugin-sessions`
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
annotations) and skills (`defineSkill`, `skillsFromFiles` over files the host
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
publishes `tool.refused` instead. A handler that dies returns `ToolDefect`
to the model, with the first line of the defect's message only; the whole
cause, stack included, is logged at error level with the call's `tool` and
`invocationId`.

An activation is one step: what is new is worked out from the active set,
recorded and applied under one lock, so `load_skill` calls running at once
(a step's calls with `toolConcurrency` above 1) each keep the other's tools,
and each call's "Now available" names the tools it added. Only a refusal
(`skills.unknown`, `capability.forbidden`) turns an activation down:
`load_skill` returns it to the model, and `apply` records the matcher's
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
layers itself.

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
`NotFound`, `OutsideWorkspace`, `Protected`, `NoMatch`, `Ambiguous`,
`Overlap`, `WouldEmpty`, `FileTooLarge`, `InvalidPattern`, `NotUtf8`,
`NotAFile`, …); a non-zero
exit, a signal and a timeout are `bash` results, not failures. The
`workspace.environment` section (tier `session`, order `sectionOrder`) tells
the model where the workspace is and how the enabled tools behave; the
skills have no instructions, since an always-on skill's instructions never
reach the model.

**Permissions.** `write` and `edit` need `fs.write` and `bash` needs
`shell.exec` (`WORKSPACE_PERMISSIONS`). Tool discovery grants nothing by
default: give the grants with its `grants` option or a turn's
`PermissionGrants`. Without them, `load_skill` refuses `workspace.edit` and
`workspace.shell` with `capability.forbidden` and the tools stay inactive (a
call returns `ToolInactive`); with `edit` or `shell` in `always` and no
grant, the turn fails with `capability.forbidden`. Without a `Bash` service
when the agent is defined, there is no `bash` tool and no `workspace.shell`
skill (a warning is logged). A coding turn reads and edits a lot: raise tool
discovery's `maxCallsPerRun` (64 by default) for such hosts, to 200 or more.

**A guardrail, not a sandbox.** With `confine` (the default), a path is
resolved against the root and refused when it is written outside it or its
real location is (links resolved, through the nearest ancestor that exists,
so a new file under a linked directory is checked too; a link to a missing
target is never written through). `write` and `edit` refuse the `protect`
globs (`.git/**` and `.efferent/**` by default). `find` and `grep` walk with
`walkGlob`, which never enters a linked directory and prunes the `exclude`
names (`node_modules`, `.git`, `.efferent`; an entry with a `/` is a path
relative to the root, wherever the walk starts); `grep` resolves each file
again before reading it. `read`, `write`, `edit` and `grep` refuse a pipe,
socket or device (`NotAFile`) rather than wait on it. These checks catch a
model's mistakes. They are not a security boundary: a path can change
between the check and its use, and `bash` runs any command the host process
may run, reading and writing anything it can reach. Nor do they bound
`grep`'s time: its regular expression runs synchronously in the host
process, and interrupting the turn cannot stop it. Cutting lines to
`grepLineChars` bounds patterns that match in linear time, and a pattern
that repeats a repeating group (`(a+)+`, the usual exponential form) is
refused with `InvalidPattern`, but other backtracking patterns (overlapping
alternatives such as `(a|a)*`) can still hold the process for a long time
on a hostile line. Commands get the configured `bashEnv` over an
allowlist of the host's variables (`bashEnvAllow`, the same names as
`BASH_ENV_ALLOWLIST`), so provider keys stay out unless `bashInheritEnv`
passes everything; `bashSessionEnv` adds `EFFERENT_SESSION_ID`,
`EFFERENT_RUN_ID` and `EFFERENT_WORKSPACE`. For untrusted work, give the
agent a `FileSystem` and `Bash` that run inside a container or VM.

**Output.** `read` shows at most `maxLines` lines (2000) or `maxBytes`
(50 KB) and says which `offset` continues; a single longer line is shown cut.
`ls`, `find` and `grep` stop at `lsEntries` (500), `findResults` (1000) and
`grepMatches` (100), and what `find` and `grep` show the model is cut to
`maxLines` and `maxBytes` too; `grep` cuts lines to `grepLineChars` (500)
before matching them, and, searching a directory, takes at most a quarter of
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
`always` (`["read"]`; also `edit`, `shell`), `confine`, `protect`,
`exclude`, `maxLines`, `maxBytes`, `lsEntries`, `findResults`,
`grepMatches`, `grepLineChars`, `maxFileBytes`, `readImages` (`true`),
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
| `@xandreed/plugin-memory-summary` | `MemorySummaryLive` | `ConversationMemory` | — |
| `@xandreed/plugin-memory-digest` | `MemoryDigestLive` | `ResultDigester` (build it per turn) | `UtilityLlm` |
| `@xandreed/plugin-tool-discovery` | `ToolDiscoveryLive` | `ToolRegistry`, `Capabilities` (catalogue) | `Capabilities` |
| `@xandreed/plugin-agent-loop` | `StepLoopLive` | `StepLoop` | — |
| `@xandreed/plugin-workspace` | `LocalSystemPluginLive` | `FileSystem`, `Bash` | — (fails with `ShellMissing` when the shell is not installed) |
| `@xandreed/plugin-workspace` | `SkillsDirectoryPluginLive` | `Capabilities` (the directory's skills) | `FileSystem` (and `SessionEnvironment` when present) |
| `@xandreed/plugin-workspace` | `WorkspaceToolsPluginLive` | `Capabilities` (the workspace tools) | — at build (`Bash` used when there); each call needs `FileSystem` and `SessionEnvironment`, `bash` also `Bash` |
| `@xandreed/plugin-telemetry` | `TelemetryPluginLive` | — (records metrics and span events) | `RunContext`, `TurnEvents` (build it per turn) |

The schemas are `SessionsConfig`, `TasksConfig`, `MemoryWindowConfig`,
`MemorySummaryConfig`, `MemoryDigestConfig`, `ToolDiscoveryConfig`,
`LocalSystemConfig`, `SkillsDirectoryConfig`, `WorkspaceToolsConfig` and
`TelemetryOptions`, with `sessionsDefaults`, `localSystemDefaults`,
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
`@xandreed/core`, requiring `ConversationMemory` and `ToolRegistry`) builds,
over the admitted turn's `TurnWriter`, in this order, the event bus and the
tasks, with the writer as the bus's first subscriber, then the memory
session (opened where the layer is built, over the session's earlier turns)
and `RunContext` (which carries the turn's `session`). It provides:

- `TurnMemory`: the session, the turn's `number`, `persistMessage` (the
  turn's TurnStarted, stored when the turn began, is shown to memory, then
  `turn.started` is published; once), `context(entry)` (before
  `persistMessage` it waits, and is recorded right after the message:
  memory records nothing of the turn before its message, `turn.unstarted`),
  `persistReply(outcome)` (`turn.reply`, then `turn.ended` is published
  with the turn's usage; once, and a no-op when the message was never
  persisted). The stored `turn.ended` is the writer's `end`, the turn's
  closing commit;
- `TurnToolbox`: `open` (once; the handlers run with the opener's services)
  and `tools` (fails with `tools.unavailable` before `open`);
- `TurnPrompt`: `system(variant)` and `turnSections`;
- `RunContext` (its `usage` is the turn's running total: a second bus
  subscriber, after the writer, sums every `assistant.message`; its
  `admitted` is the writer's admitted turn, the host's `meta` included),
  `TurnEvents` and `TurnTasks`.

The lifecycle is functions over them: `openTurnTools`, `turnTools` (the
host's view), `settleTurn` (join the tasks, drain the reactions, until quiet),
`finishTurn(outcome)` (persist the reply, drain, flush; the reply and the
flush happen even when the fiber is interrupted meanwhile, only the drain is
cut), `guardTurn(body)` (settle on success, else finish as failed keeping
the cause: the failed reply recorded, its reactions drained interruptibly
and for ten seconds at most, a failure of that finishing logged; on success
it returns the `TurnResult`, the outcome with `RunContext.usage`; on failure
it puts the usage so far on the current span), `turnOf(options)`
(the `Turn` a host's code gets), `stepRequestOf(policy, options)` and
`runTurnLoop(policy, options)` for one run of the step loop, and
`traceTurn(writer, { spanMeta })` (the turn's `agent.turn` span around
everything after the begin, see traces and metrics). `cacheKeyOf(prefix,
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
flush, then closes; an agent-owned writer ends afterward.

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
import { mediaFromBase64, mediaFromBytes, UserMessage } from "@xandreed/core"

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
import { defineTool, Failure, Media, mediaFromBytes } from "@xandreed/core"

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
| `anthropic` (Messages API) | image blocks | image blocks inside the `tool_result` |
| `openai`, `openai-codex`, OpenCode `gpt-*` (Responses API) | `input_image` | `input_image` inside the `function_call_output` |
| `google` (Gemini's chat completions), a configured endpoint with `images: true` | `image_url` parts (`data:` URLs) | one user message after the batch's tool messages, each result's images captioned `Images returned by <tool> (call <id>):` (merged with a user message that follows, captioned `The user's message:` when it has images of its own) |
| OpenCode's other models, `openai-codex:gpt-5.3-codex-spark`, configured endpoints without `images`, a `local` credential's URL | a label line per image | a label line per image |

`imageInputFor(selection)` (`@xandreed/plugin-models`) says whether a
built-in route reads images, and the model catalog states it per model
(`ModelCatalogEntry.input`, `["text", "image"]` or `["text"]`) for a host's
attach button, for the route the model is sent through: a configured
endpoint of a built-in provider's name by its `images`, a `local`
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
base64; the bus's `tool.completed` (the stored one leaves the result out) and
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
  `revision` still equals `expect` and, with `notAfter`, only while the
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
  with code `store.decode`.
- **`Sessions`, consumption through a plugin** (`@xandreed/plugin-sessions`,
  requiring `SessionLog` and `TurnAdmission`). Hosts and `Agent.turn` both
  read and write sessions only through it.

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
the check holds across restarts. A run id names one turn's run (memory numbers
the turn's entries `<runId>:<n>` from it): a begin under a run id an earlier
turn of the session, or of the history a fork inherits, was begun with is
`RunIdReused` (code `turn.run-reused`), checked right after the key,
and opens nothing. The writer (`TurnWriter`) is the turn's one
way to write: `append`, `write(op)` in queue order, `transact(decide)`
(check, then append: decided again with the events others wrote when
someone commits first), `flush` (committed to storage), `end` (the closing
commit; it returns how many inbox items wait, and after a store failure a
later end tries again) and `closed` (completes when someone else closed the
turn). A writer whose scope closes unended ends the turn as failed
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
reaped lease or a stopped holder, `removed`, or `ended` once its own end is
stored or under way, or its scope closed), `ReservedKind`,
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
  holder that stopped, not one that stalled; `Sessions.cancel` closes it.
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
`changes(address)` signals each commit this instance makes (a feed polls
for the others), and `lookup(address, key)` finds a key's turn.

**Admission.** `TurnAdmission.admit(turn, open)` runs around the one commit
that opens every turn (a user's, the inbox's, a task's), never around the
turn's later writes, so a host can count and open in one transaction: a
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
| `turn.started` (`runId`, `key`, `origin`, `userMessage`, `command`, `claimed`, and `meta` and `resumes` when given) | `Sessions.begin`; memory reads it as the turn's TurnStarted |
| `turn.reply` | memory (`persistReply`) |
| `turn.ended` (`reason`: completed, partial, failed, cancelled, interrupted; `failure`: the failing error's code; otherwise one of the framework's codes, `turn.failed`, `turn.defect`, `turn.interrupted`, `turn.unended`, `turn.lease`, or a code the closer passes to `end` itself, such as plugin-tasks' `task.turn` and `task.deadline`) | the writer's `end` (`turnEndingOf` the turn's exit), its scope, a cancel or a reap |
| `memory.system`, `memory.section`, `memory.step`, `memory.message`, `memory.tool-result`, `memory.digest`, `memory.skills`, `memory.compaction` | memory (`{ entry, runId, step, at, body }`) |
| `step.started`, `step.ended`, `step.usage`, `tool.started`, `tool.refused`, `tool.completed`, `completion.evaluated`, `context.built`, `decision.recorded`, `stream.fallback` | the turn's bus |
| `request.prepared` (the request's header: system text, tool declarations, model, cache key) | the turn, before each provider call (`TurnMemory.prepareRequest`) |
| `inbox.queued`, `inbox.dropped` | `deliver`; a claim that failed too often |
| `task.started`, `task.cancelled`, `task.result` | `@xandreed/plugin-tasks` |
| anything else | the host, through the writer or `transact` |

Memory is rebuilt from `MEMORY_KINDS` by `entriesOfEvents`, which reads JSON
back with sorted keys: the requests a model sees do not depend on the store
(a JSON column may reorder keys), and the SDK checks this over the memory,
SQLite and key-reordering stores against the golden requests.

A record is read by its fields only once decoded. `readStored(kind, events)`
decodes the events of one of the kinds in `StoredData` (`turn.started`,
`turn.ended`, `inbox.queued`, `inbox.dropped`, `step.usage`,
`request.prepared`) with that kind's schema and fails with the first
`SchemaError`; a lookup by key goes through `readStoredKeys`, which decodes
a `turn.started`'s `runId`, `key` and `entry` (`TurnStartedKeys`) or a
`request.prepared`'s `runId` and `step` (`RequestPreparedKeys`), never a
user's message and its images. The framework's readers fail on a row that
does not decode (plugin-sessions and plugin-tasks with `session.decode`, a
turn with `memory.log` or `request.decode`) rather than skip it or read it
as something else.

**The inbox.** `deliver(address, { id, source, content })` puts an item in
the session's inbox, once per id, up to `inbox.maxPending` (20). Items wait
for the next inbox turn: `begin(address, { _tag: "Inbox", runId })` claims
every waiting item in its start commit (its `userMessage` is their contents)
and fails with `NothingPending` when there are none. An item is done when its
turn ends completed, partial or cancelled; a failed or interrupted claim
returns it, up to `inbox.attempts` (2), and then it is dropped
(`inbox.dropped`). A turn interrupted before it wrote anything through its
writer (no `append`, `write` or `transact`) never tried its items: they wait
again and no attempt is counted. A turn reaped because its holder stopped
counts. User messages never queue. `drain(address, run, { maxTurns, meta })` runs
inbox turns while items wait, the session is free and the host admits them,
at most `maxTurns` (three), each begun with `meta`. Each ends completed
when `run` succeeds, and otherwise as `turnEndingOf` gives for its failure:
the error's own code (a `TurnError` carried as a defect included),
`turn.failed`, `turn.defect` or `turn.interrupted`. A `run` that interrupts
itself (an `Effect.interrupt`, or joining an interrupted fiber) ends
`interrupted` but counts an attempt even when it wrote nothing, so an item
whose run keeps interrupting itself is still dropped after
`inbox.attempts`; a drain interrupted from outside ends its turn through
the writer's scope, and counts one only if the turn wrote something.
Whoever closes a turn and whoever delivers drains: the
delivery either commits before the turn's closing commit (whose `pending`
counts it) or after it (and finds the session free), so nothing waits
unnoticed. `Agent.turn` ends a turn it began and hands that count to its
caller as `TurnResult.pending`; a drain ends its own inbox turns, and goes
on while the end of its last one counts items waiting (ones delivered
during it included), stopping at the end that counts none.

**Background tasks** (`@xandreed/plugin-tasks`). A task is one turn of a
child session, a fork of the conversation or an empty spawn, whose id is the
task's. `Tasks.start(parent, { instructions, mode })` records `task.started`
in the parent, checked against the tasks stored (a task does not start
tasks; a session runs `maxRunning`, two, at once), creates the child once
that record is stored (a start refused or not stored leaves none), and
hands the work to the host's `TaskRunner`: `InProcessTaskRunnerLive` forks
it on this process (its own fiber, interrupted with the layer, counted by
the `TaskActivity` the layer also provides), and a serverless host
registers it with its `waitUntil`. Starting a `taskId` again starts it
once, and also creates the child a start that stopped half way left
without one; the same id with other instructions or another mode is
`TaskConflict`, and an id naming a session that is not the parent's task
child (the parent itself, another conversation) is `SessionExists`. A
store failure while the child's result is stored is logged as a warning,
and the task then reads as interrupted (`task.lost`). The work begins the
child's turn once (its key is the task's), runs it through the host's `TaskExecutor.turn` until the runner's
deadline, records `task.result` before the turn closes, delivers the result
to the parent's inbox (`task:<id>`, once) and drains the parent, whose
`TaskExecutor.react` answers it after the turn in flight. The notice frames
the task's words:

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
(`turn.reply`) ends partial, so its notice is done and never answered twice,
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
the starter's. With `tools`, the model gets `start_task` and
`task_status` (off by default); `start_task` starts the task with the
turn's own `meta` and its `runId`, and tells the model that a fork sees the
conversation up to the user's latest message, not that message or what the
turn did since.

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
(a SIGTERM before a restart). Two optional ports in `@xandreed/core` count
what this process has in flight:

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

`processActivity` reads both from the current services into a
`ProcessActivity`: `{ openTurns, beginningTurns, runningTasks, busy }` (a
port that is not there counts nothing). `awaitIdle({ timeout })` waits
until nothing is open, beginning or running at the same moment (a task that
opens its parent's inbox turn before it ends is waited for too) and returns
that activity; with a `timeout` it stops waiting then and returns what is
still in flight, with `busy: true`. `agent.activity` is `processActivity`
over the agent's runtime services: the `Sessions` and task runner given in
`Agent.define`'s `services` (built from the layers above, so their ports
come along), or a runtime-scoped sessions plugin in its graph. A `Sessions`
passed only in a turn's services is not the agent's to see; read
`processActivity` over the host's own services instead.

The drain is four steps: stop admitting new turns, wait (bounded) until
idle, stop the host's own request fibers, then close the scope the
services live in. Admission is the host's: a `TurnAdmission` that refuses
while draining makes every new turn, user's or inbox's or task's, fail to
begin with `TurnRefused` (code `turn.refused`, a host answers 503). A request that got past the admission just before the flag
was set is a begin in flight, so the wait covers it. A task that finishes
while draining still stores its result and delivers it to its parent's
inbox, where it waits (its reaction is refused) until the session is next
drained.

```ts
// Inside the host's Effect.gen, in the scope the process closes last.
import { Effect, Layer, Ref } from "effect"
import { LanguageModel } from "effect/ai"
import { awaitIdle, TurnAdmission, TurnRefused } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const draining = yield* Ref.make(false)
const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
  admit: (turn, open) => Effect.gen(function* () {
    if (yield* Ref.get(draining)) return yield* Effect.fail(new TurnRefused({ session: turn.session.id, reason: "draining", message: "shutting down" }))
    return yield* open
  }),
}))
const sessions = SessionsPluginLive().pipe(Layer.provide(Layer.merge(SessionLogSqliteLive(".efferent/runtime/sessions.db"), admission)))
// The runner on top of the sessions, not beside them: closing interrupts its tasks while the log is still open.
const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(sessions)))
const agent = yield* Agent.define({ services, plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel] })

// GET /ping: 200 with the counts (a session id is the host's to show or not).
const ping = agent.activity.pipe(Effect.map((now) => ({ busy: now.busy, openTurns: now.openTurns.length, runningTasks: now.runningTasks })))

// On SIGTERM: stop admitting, wait at most 25 s; then the host stops its server, then closes the services' scope.
const drain = Effect.gen(function* () {
  yield* Ref.set(draining, true)
  const left = yield* awaitIdle({ timeout: "25 seconds" }).pipe(Effect.provide(services))
  if (left.busy) yield* Effect.logWarning(`stopping with ${left.openTurns.length + left.beginningTurns} turns and ${left.runningTasks} tasks in flight`)
})
```

What is still running when the wait ends needs the last two steps in that
order. A turn's writer lives in the turn's own scope (`Agent.turn`'s, in
the fiber serving the request), not in the services' scope, and
`SessionsLive` holds no finalizer over it: closing the services does not
stop that turn, it closes the log under it (`SessionLogSqliteLive` closes
its database). So stop the host's request fibers first, interrupting or
awaiting them (an HTTP server's shutdown, for one): a turn whose scope
is interrupted while the log is open ends interrupted (`turn.interrupted`)
and can be resumed. Then close the services. The task runner's layer
interrupts its tasks when it closes and waits for them, and a task whose
fiber is interrupted ends its child's turn the same way, provided the log
is still open: build the runner on top of the sessions with
`Layer.provideMerge`, as above, so it closes first. `Layer.mergeAll` closes
its layers at the same time, and a task's end may then race the log's
close. A turn still running when its log closes cannot store its end: the
next process reaps it as interrupted with `turn.lease`, under a lease once
the lease runs out (until then a begin on that session fails with
`SessionBusy`), under process ownership at the first touch after the
process is gone. Keep the wait below the platform's grace period (a
container's stop timeout, say), with time left for those two steps.
`packages/sdk/src/activity.test.ts` runs this recipe, including a drain
that times out.

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
counts as interrupted, including one the resuming begin reaps itself.
Otherwise the begin fails with `NotResumable` (`session`, `turn` and a
`reason`) and opens nothing: `missing` (no such turn in this session's own
log; a fork's inherited turns are its parent's), `inbox` (an inbox turn),
`superseded` (another user's turn began after it, a resume of it that
completed or ended partial included) or `finished` (it ended completed,
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

**What is durable after a cancel or an interrupt** is what the turn's
writer committed before the turn was closed:

- `turn.started`;
- every whole step: a step's assistant message and its tool results are
  recorded together, once the step's tools have returned (`memory.message`,
  `memory.tool-result`), beside its `step.*`, `tool.*`, `step.usage` and
  `context.built` events and its `request.prepared`;
- of the step in flight, only what was already stored: its `step.started`,
  `context.built` and `request.prepared` (flushed before the provider call),
  and possibly the `tool.started` and `tool.completed` events (and the
  host's own events) that were queued before the close: a step's tool
  calls run one after another or concurrently (`toolConcurrency`), so one
  may have returned while another still runs. Never its assistant message
  or its tool results, so
  memory holds no tool call without its result;
- `turn.ended`: `cancelled` with no failure after a cancel; `interrupted`
  with `turn.interrupted` after an interruption, or `turn.lease` when reaped.

A cancelled turn has no `turn.reply`: its writes are refused once it is
closed. An interrupted turn may keep a failed `turn.reply` with no text (the
turn recorded its reply as failed before its end), which the model never
sees. What a tool did in the step in flight is not undone, and the resuming
turn may call it again: a tool with side effects makes them safe to repeat,
for example keyed by its input.

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
