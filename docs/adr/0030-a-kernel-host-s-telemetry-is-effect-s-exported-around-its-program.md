# ADR 0030: A kernel host's telemetry is Effect's, exported around its program

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (`Sessions.turn` is the span `kernel.turn`, `callTool` the span
  `kernel.tool.call`; `planned` marks each attempt on the span it runs under; the metrics `kernel.model.calls`,
  `kernel.model.tokens` and `kernel.tool.calls`), `@xandreed/sdk/kernel/node` (new: `otlpTelemetry`,
  `otlpTelemetryOver`, `otlpTelemetryFromEnv`, `otlpTelemetryFromEnvOver`, `flushTelemetry`, `OtlpTelemetryOptions`,
  `OtlpSpanPolicy`, `OtlpProtocol`, `OtlpCompression`, `OtlpTemporality`; `openAiCompatibleModel` takes `provider`
  and sets the `gen_ai.*` attributes; the metric `kernel.model.cost`)
- **Amends:** ADR 0015 (each attempt of a plan is marked on the span it runs under), ADR 0026 (the OpenAI-compatible
  provider names its calls as Effect AI's Anthropic provider does; the charge counts what it settles)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine and every `plugin-*` package are removed before the next release. `@xandreed/plugin-telemetry` is
how a host of the old engine sees what its agent did: OTLP/HTTP export of traces and metrics from the standard
`OTEL_*` variables, a span policy that keeps or drops spans and redacts attributes, usage, token and cost metrics
per model call, and a LangSmith mapping. The kernel had spans of its own (`kernel.session.begin` and `.end`,
`kernel.<memory>.context`, `knowledge.curate`, `kernel.session.recover_turns`, the stores' and the workspace ports'),
no export, no policy and no metrics. A kernel host must see its turns, model calls and tool calls in an OTLP backend
(Langfuse, Jaeger, Honeycomb, LangSmith's OTLP endpoint) and decide what of a conversation leaves the process.

## Decision

### The span tree a host gets without writing a span

```
kernel.turn                       Sessions.turn: efferent.session.id, gen_ai.conversation.id, efferent.turn, efferent.outcome
├── kernel.session.begin
├── kernel.<memory>.context       the host's memory, each step
├── POST                          Effect's HttpClient: the model's request
├── LanguageModel.streamText      Effect AI's span of the call: gen_ai.* set by the provider; one per attempt
├── kernel.tool.call              callTool: gen_ai.operation.name execute_tool, gen_ai.tool.name, gen_ai.tool.call.id,
│   └── a tool's own spans        efferent.outcome (succeeded or failed)
└── kernel.session.end
```

- **A model call is Effect AI's span, and the kernel opens none beside it.** `LanguageModel.streamText` (and
  `generateText`) opens `LanguageModel.<method>` (kind `client`) and hands it to the provider as `options.span`. The
  streamed one is `makeSpanScoped` in the stream's own scope, so it ends when the stream ends, whole, cut or
  interrupted (`model-openai-compatible` and `model-anthropic` tests hold each). `modelAnswer` adds no span: one
  around it would be a second span for the same call, and a backend that counts usage per span would count it twice.
- **Both providers carry the same `gen_ai.*` attributes.** Effect AI's Anthropic provider sets them; the
  OpenAI-compatible provider, on its own wire, now sets the same keys: `gen_ai.provider.name` (`openai` unless
  `provider` names another, `gcp.gemini` for Gemini's endpoint), `gen_ai.operation.name` (`chat`),
  `gen_ai.request.model` and `.max_tokens` before the request is sent, then `gen_ai.response.model`,
  `.finish_reasons`, `gen_ai.usage.input_tokens` (the cache's shares in it), `.output_tokens` and
  `gen_ai.usage.cache_read.input_tokens` / `.cache_write.input_tokens` as the parts arrive, so they are on the span
  before it ends. Only `gen_ai.response.id` is Anthropic's alone: the chat-completions wire gives an id on each chunk,
  and the answer's parts do not carry it.
- **A plan's attempts.** Each attempt `planned` runs is a call of the model, so a span of its own. The plan cannot
  reach those spans, so it marks each attempt (`started`, `succeeded`, `failed` with its reason; its number and its
  step) as a span event `kernel.model.attempt` on the span current where it runs, the turn's, beside them. No span is
  opened for the plan.
- **The model's HTTP request is a sibling of its call's span**, under the turn: Effect AI passes the call's span to
  the provider as an option and does not make it the current span of the provider's stream. It is left as Effect makes
  it, alike for both providers, rather than re-parented by one of them.
- **A turn is `Sessions.turn`'s span.** It wraps the begin, the body and the end: the session at once (so a policy's
  `keep`, asked at the first child, sees it), the turn's number once it opened, how it ended at its end (`completed`,
  `failed`, `interrupted`). `Sessions.open` opens no span: a turn opened in the current scope cannot be the parent of
  the work that follows it there, which runs under the caller's span. A host that opens its turns with `open` (the
  lessons do) wraps its own `Effect.withSpan` around the scope.
- **What runs in no turn.** `curate` is `knowledge.curate`: the source stored in a `kernel.turn` under it, the
  curator's model calls under it (no turn is open then), what passed stored in another `kernel.turn`. It is a trace
  of its own, or a child of the span current where the host calls it (`telemetry.test.ts` holds both). A turn a
  plugin runs on a fiber of its own (a background task's, the inbox's) is under the span current where that fiber
  was forked, as Effect gives every forked fiber a parent; this cut tests no such tree.
- **Names.** New spans are `kernel.`-prefixed (skill `effect-idioms`, §7); ids are attributes, a session under both
  `efferent.session.id` (the old engine's key) and `gen_ai.conversation.id` (OpenTelemetry's, which backends group a
  conversation's traces by).

### Content is off by default; the export's option turns it on

What was said (a model call's prompt and answer, a tool call's parameters and result) reaches an exported span's
attributes only when the host turns it on: `content: true` on the export's options. Two facts decide the shape:

- Effect AI's toolkit puts a call's `parameters` on the span current where it is handled, whatever the host wants
  (`Toolkit.handle` annotates it unconditionally); under `callTool` that span is `kernel.tool.call`. So the switch
  must sit where spans leave the process: the export leaves out every attribute of `CONTENT_ATTRIBUTES`
  (`parameters`, `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) before the host's policy is asked. A host on another
  exporter filters `parameters` there.
- Neither `modelAnswer` nor `callTool` reads a switch: an optional contract a part uses when present is what ADR
  0020 rules out and the kernel's skill does not add.
  With `content` on, the export also provides Effect AI's own `CurrentSpanTransformer`, which runs as each call's
  stream ends, before its span does: it writes the system text, the conversation sent (a tool's result among it,
  under the call's id, which `kernel.tool.call` carries as `gen_ai.tool.call.id`) and the answer, in OpenTelemetry's
  message shape. The transformer is not provided with content off, so nothing is serialized. The layer's type names
  the `Flusher` alone; a host's own transformer, provided inside, wins.
- No variable turns content on, not even OpenTelemetry's capture-content one: what a conversation said leaves the
  process only when the host's code says so.
- The rule is over attributes. A span's name, its status and the `exception` event a failed span gets from its exit
  are sent as they are (the policy's own rule), so a span that fails with words quoting what it was given (a tool's
  own span over a path that is not there, say) sends those words with content off. The kernel's own spans do not fail
  that way: `callTool` stores a tool's failure as its result and its span ends well.

### The export is a layer around the program, on the Node entry

The OTLP export, its `OTEL_*` resolution and the span policy are the old plugin's files, moved with their tests and
renamed (`otlpTelemetry`, `otlpTelemetryOver` over the host's `HttpClient`, `otlpTelemetryFromEnv`,
`otlpTelemetryFromEnvOver`, `flushTelemetry`): Effect's `OtlpTracer` and `OtlpMetrics` sharing one flusher, the
standard variables read through the `ConfigProvider` only when they can matter (`OTEL_SDK_DISABLED`, per-signal
endpoints and headers, compression, protocol, intervals, temporality). The `Tracer` and the metric registry are fiber
references, which a layer around the program reaches and a kernel plugin does not. A failed post is retried three
times a second apart, then the signal is off for a minute; it never fails the program, and a `flushTelemetry` waits
for the retries (a host with a deadline bounds it with `Effect.timeoutOption`).

It imports no runtime module, and still lives on the Node entry, for ADR 0026's reason: an OTLP endpoint's headers
hold a key (a tenant's API key, a basic-auth pair), which a page would show to every script on it, and the standard
variables are a process's. The browser entry's bundle also stays free of `effect/observability`. Moving it is an
export, not a rewrite.

### The span policy

`OtlpSpanPolicy`, as the old plugin had it: `keep` asked once per span (its first child or its end), a dropped span
never sent and its children sent under the nearest kept ancestor; `attribute` asked as each span or span-event
attribute is set, so a value it leaves out never reaches the exporter; a hook that throws drops what it was asked
about. The export now always runs Effect's OTLP tracer behind it, since the content rule is a policy too.

### Metrics

| Metric | Where | Attributes |
|---|---|---|
| `kernel.model.calls` | `modelAnswer`, as a call's reading ends | `efferent.model` (the model the stream named, `unknown` when none did), `efferent.outcome` (`answered`, `failed`, `cut`, `interrupted`) |
| `kernel.model.tokens` | `modelAnswer`, for a call whose provider reported usage | `efferent.model`, `efferent.token.kind` (`input` not read from the cache, `cache_read`, `output`: apart, so they sum to the call's) |
| `kernel.model.cost` | the Node entry's charge, once the ledger settled a hold | `efferent.model` (the model priced) |
| `kernel.tool.calls` | `callTool` | `efferent.tool` (`unknown` for a name the toolkit has not), `efferent.outcome` (`succeeded`, `failed`) |

- **Cost has one source**, the ledger (ADR 0020): `kernel.model.cost` counts what `settle` took, only after it took
  it, for a held call or an uncapped model's bill (`metredCostOf`). A call that is released counts nothing, and so
  does an uncapped model's call with no bill, which the ledger settles at 0 for want of a price: never a cost of 0. A
  call through a model with no ledger (`scriptedModel`, a browser's) reports its tokens and no cost.
- **Tokens and calls are counted where every host's loop reads a model**, `modelAnswer`, whatever the model. A call a
  plan tried again counts once, as the answer it made; each attempt is on the trace. Calls outside `modelAnswer` (a
  curator's, a summarizer's) are traced and charged, not counted as calls or tokens.
- **No metric names a session or a turn**: a series per conversation would grow without end.

### LangSmith: left out

No package that stays imports the old plugin's LangSmith tracer. Its run-type rules are keyed to the old engine's
span names (`agent.`, `engine.`, `providers.generate`, `loop.tool_call`, `engine.step.input`), it rewrites span
attribute maps behind their read-only view, and it needs old core's `traceParentOf` and `harnessError`. In the
kernel's tree each model call is one span with the `gen_ai.*` attributes LangSmith's OTLP endpoint reads as an LLM
run, so a host sends its traces there with the generic export:

```ts
otlpTelemetry({
  tracesUrl: "https://api.smith.langchain.com/otel/v1/traces",
  headers: { "x-api-key": key, "Langsmith-Project": "my-agent" },   // and "X-Tenant-Id" for a key of several workspaces
  metrics: false,                                                  // LangSmith takes traces
  spans: { keep: (span) => span.name !== "POST" && !span.name.startsWith("kernel.session.") },
})
```

The old mapping also named the priced model (`langsmith.metadata.ls_model_name`), so LangSmith priced each run; that
would be a second price table beside the ledger, so it is not ported. Live LangSmith ingestion is unverified.

## Consequences

- A kernel host gets a trace of each turn, model call and tool call, and the four metrics, by providing one layer
  around its program; with no exporter, Effect's spans and metrics stay in the process and nothing a turn stores or
  sends changes (`telemetry.test.ts` compares the journal and the requests, the learn tests and the goldens pass).
- `parameters` is dropped by key from every exported span with content off, a host's own attribute of that name
  included.
- The old plugin keeps its copy of the moved files until the old engine is removed with it.

## What would reopen this

- Effect AI making the call's span the current span of a provider's stream, or opening a span for a tool call
  itself: the HTTP request would move under the call, or `kernel.tool.call` would be a second span.
- A host that needs content on for some calls and not others, which a per-attribute policy cannot tell apart.
- A second source of cost, or a backend that prices runs the host must match.
