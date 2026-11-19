# ADR 0030: A kernel host's telemetry is Effect's, exported around its program

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk` (every kernel span renamed by one rule; `Sessions.turn` is the span
  `session.turn`, `callTool` the span `tool.call`; `planned` marks each attempt on the span it runs under; the inbox's
  worker and a task's turn run as traces of their own; the metric `efferent.tool.calls`), `@xandreed/sdk/node`
  (new: `otlpTelemetry`, `otlpTelemetryOver`, `otlpTelemetryFromEnv`, `otlpTelemetryFromEnvOver`, `flushTelemetry`,
  `OtlpTelemetryOptions`, `OtlpSpanPolicy`, `OtlpProtocol`, `OtlpCompression`, `OtlpTemporality`;
  `openAiCompatibleModel` takes `provider` and sets the `gen_ai.*` attributes; the charge counts
  `efferent.model.calls`, `efferent.model.tokens` and `efferent.model.cost`)
- **Amends:** ADR 0015 (each attempt of a plan is marked on the span it runs under), ADR 0026 (the OpenAI-compatible
  provider names its calls as Effect AI's Anthropic provider does; the charge counts what it settles)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine and every `plugin-*` package are removed before the next release. `@xandreed/plugin-telemetry` is
how a host of the old engine sees what its agent did: OTLP/HTTP export of traces and metrics from the standard
`OTEL_*` variables, a span policy that keeps or drops spans and redacts attributes, usage, token and cost metrics
per model call, and a LangSmith mapping. The kernel had spans of its own (`kernel.session.begin` and `.end`, each
memory's `context`, `knowledge.curate`, `kernel.session.recover_turns`, the stores' and the workspace ports'), no
export, no policy and no metrics. A kernel host must see its turns, model calls and tool calls in an OTLP backend
(Langfuse, Jaeger, Honeycomb, LangSmith's OTLP endpoint) and decide what of a conversation leaves the process.

## Decision

### The span tree a host gets without writing a span

```
session.turn                       Sessions.turn: efferent.session.id, gen_ai.conversation.id, efferent.turn, efferent.outcome
├── session.begin
├── flat_memory.context           the host's memory, each step (window_memory, summary_memory)
├── POST                          Effect's HttpClient: the model's request
├── LanguageModel.streamText      Effect AI's span of the call: gen_ai.* set by the provider; one per attempt
├── tool.call                     callTool: gen_ai.operation.name execute_tool, gen_ai.tool.name, gen_ai.tool.call.id,
│   └── a tool's own spans        efferent.outcome (succeeded or failed)
└── session.end
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
  step) as a span event `model.attempt` on the span current where it runs, the turn's, beside them. No span is
  opened for the plan.
- **The model's HTTP request is a sibling of its call's span**, under the turn: Effect AI passes the call's span to
  the provider as an option and does not make it the current span of the provider's stream. It is left as Effect makes
  it, alike for both providers, rather than re-parented by one of them.
- **A turn is `Sessions.turn`'s span.** It wraps the begin, the body and the end: the session at once (so a policy's
  `keep`, asked at the first child, sees it), the turn's number once it opened, how it ended at its end (`completed`,
  `failed`, `interrupted`). `Sessions.open` opens no span: a turn opened in the current scope cannot be the parent of
  the work that follows it there, which runs under the caller's span. A host that opens its turns with `open` (the
  lessons do) wraps its own `Effect.withSpan` around the scope.
- **What runs in no turn.** `curate` is `knowledge.curate`: the source stored in a `session.turn` under it, the
  curator's model calls under it (no turn is open then), what passed stored in another `session.turn`. It is a trace
  of its own, or a child of the span current where the host calls it (`telemetry.test.ts` holds both).
- **A turn a plugin runs on a fiber of its own is a trace of its own.** A forked fiber keeps the span current where
  it was forked as its parent: the inbox's worker, forked in the first message's `inbox.enqueue`, put every turn it ran
  under that ended span, and a task's turn sat under `tasks.start` inside the `tool.call` that asked for it. Both are
  forked with no parent span (`ownTrace`, the inbox's announcements too), so each such turn is a root `session.turn`
  (`fibers-trace.test.ts`: three messages queued together and three one after the other; a task started in a turn and
  reported in a turn of the host's, which is under the host's span).

### Names, which freeze at the release

One rule for every kernel span: `<part>.<op>`, dotted lowercase with snake_case words (skill `effect-idioms`, §7),
the part being the contract, plugin or port the span is the work of, the op its function. No `kernel.` prefix: the
kernel moves to the package roots at the release, and the word would be stale. Metrics, and the attributes spans and
metrics carry, are `efferent.*`; OpenTelemetry's own keys (`gen_ai.*`) are kept where they name the same thing.

| Span | Of |
|---|---|
| `session.turn`, `session.begin`, `session.end`, `session.recover`, `session.fork`, `session.recover_turns` | the session plugin, `recoverTurns` |
| `tool.call`, the event `model.attempt` | `callTool`, `planned` |
| `flat_memory.context`, `window_memory.context`, `summary_memory.context` | the three memories |
| `inbox.enqueue`, `tasks.start`, `approval.approve`, `approval.approve_in`, `read_result.read` | the inbox, the tasks plugin, approvals, `readResult` |
| `knowledge.curate`, `knowledge.curate_again` | the curation step |
| `scripted_model.make`, `scripted_shell.make` | the scripted model and shell |
| `journal_directory.<op>`, `journal_sqlite.<op>`, `disk_files.<op>`, `files_search.find`, `process_shell.run` | the Node entry's ports (unchanged) |
| `openai_compatible_embedder.embed` | the Node entry's embedder (ADR 0032) |
| `in_memory_media.<op>`, `directory_media.<op>` | the media stores (ADR 0034) |

| Metric | Attribute keys |
|---|---|
| `efferent.model.calls`, `efferent.model.tokens`, `efferent.model.cost`, `efferent.tool.calls` | `efferent.model`, `gen_ai.operation.name`, `efferent.outcome`, `efferent.token.kind`, `efferent.cost.basis`, `efferent.tool` |

Span attributes: `efferent.session.id` and `gen_ai.conversation.id` (a session, under the old engine's key and
OpenTelemetry's, which backends group a conversation's traces by), `efferent.turn`, `efferent.outcome`,
`efferent.tool.asked`, and on the `model.attempt` event `efferent.attempt`, `efferent.plan.step`, `efferent.outcome`,
`efferent.reason`. `tool.` and `tasks.` begin names the old engine's spans also use, and `efferent.tool.calls` is the
old telemetry plugin's metric too, with another description: both go with the old engine, before the names freeze.

### Content is off by default; the export's option turns it on

What was said (a model call's prompt and answer, a tool call's parameters and result, a failure's or a log's words)
leaves the process only when the host turns it on: `content: true` on the export's options. These facts decide the
shape:

- Effect AI's toolkit puts a call's `parameters` on the span current where it is handled, whatever the host wants
  (`Toolkit.handle` annotates it unconditionally); under `callTool` that span is `tool.call`. So the switch
  must sit where spans leave the process: the export leaves out every attribute of `CONTENT_ATTRIBUTES` before the
  host's policy is asked: the toolkit's `parameters` and `tool` (the model's name for it), `efferent.tool.asked` (the
  name of a tool the toolkit has not, which `tool.call` keeps apart and calls `unknown` in `gen_ai.tool.name`),
  `efferent.reason` (a failed attempt's words), `exception.message`, `exception.stacktrace` and `effect.cause` set as
  attributes, and `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`. A host on another exporter filters them there.
- A failure's words are content too: a provider that refuses a request can echo it back, system text and messages
  and all, and a tool's own span that fails on a path names the path. With content off the policy tracer hands the
  exporter each span's exit with every failure and defect replaced by its type alone (an error's tag and its reason's,
  as `AiError.InvalidRequestError`, else its class's name), the fixed words of `WITHHELD`, a one-line stack and no
  cause (`withheldExit`), so the span's status message and its `exception` events name what kind of failure ended it
  and nothing it said; the span the program holds keeps its real exit. A log Effect writes on a span (its tracer
  logger's event: the message as the event's name, the cause as `effect.cause`) is sent as `log` with its level and
  fiber alone. `telemetry-content.test.ts` plants a marker in every place a conversation's words come from (the
  system text, the messages, a written file's text, a command, a missing path, an unknown tool's name, the key, a
  host's log and a logged cause) and runs a turn under a plan over a disk and a shell, once well and once refused with
  the request echoed: with content off no marker is in anything posted, traces or metrics; with content on each is.
- Neither `modelAnswer` nor `callTool` reads a switch: an optional contract a part uses when present is what ADR
  0020 rules out and the kernel's skill does not add.
  With `content` on, the export also provides Effect AI's own `CurrentSpanTransformer`, which runs as each call's
  stream ends, before its span does: it writes the system text, the conversation sent (a tool's result among it,
  under the call's id, which `tool.call` carries as `gen_ai.tool.call.id`) and the answer, in OpenTelemetry's
  message shape. The transformer is not provided with content off, so nothing is serialized. The layer's type names
  the `Flusher` alone; a host's own transformer, provided inside, wins.
- No variable turns content on, not even OpenTelemetry's capture-content one: what a conversation said leaves the
  process only when the host's code says so.
- Span names are sent as they are: a span's name is the program's code, never what was said.

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
about. The export now always runs Effect's OTLP tracer behind it, since the content rule is a policy too, and with
content off it also withholds a failure's words and a log's text, as above.

### Metrics

| Metric | Where | Attributes |
|---|---|---|
| `efferent.model.calls` | the Node entry's charge, as it closes a call's hold | `efferent.model` (the model asked and priced), `gen_ai.operation.name` (`chat` for a model's call, `embeddings` for an embedder's, ADR 0032), `efferent.outcome` (`answered`, `failed`, `refused` by the provider, `unsent`, `interrupted`) |
| `efferent.model.tokens` | the charge, for a call whose provider reported usage | `efferent.model`, `gen_ai.operation.name`, `efferent.token.kind` (`input` not read from the cache, `cache_read`, `cache_write`, `output`: apart, as `costOf` prices them) |
| `efferent.model.cost` | the charge, once the ledger settled a hold | `efferent.model`, `gen_ai.operation.name`, `efferent.cost.basis` (`billed`, `usage`, `held`) |
| `efferent.tool.calls` | `callTool` | `efferent.tool` (`unknown` for a name the toolkit has not), `efferent.outcome` (`succeeded`, `failed`) |

- **Calls, tokens and cost are counted in one place**, the charge (`model-spend/`), which sees every call a provider
  of the Node entry sends: a host's loop's, a curator's, a summarizer's. They come from the same report and the same
  settlement, so cost per token holds. Each attempt a plan sends is a call with its own outcome. A call the ledger
  refused, or one refused before it is sent for want of a price or an output bound, held nothing and is not counted.
  `modelAnswer` counts nothing. A model with no ledger (`scriptedModel`, a browser's) is traced and not counted; the
  export is on the Node entry, so a browser host loses nothing it had.
- **Cost has one source**, the ledger (ADR 0020): `efferent.model.cost` counts what `settle` took, only after it took
  it (calls and tokens are counted whether or not it did), for a held call or an uncapped model's bill
  (`metredCostOf`). A call that is released counts nothing, and so does an uncapped model's call with no bill, which
  the ledger settles at 0 for want of a price: never a cost of 0.
- **Each cost point says what it is**: `billed` (the provider's bill), `usage` (the reported tokens at the host's
  price) or `held` (the call left and nothing came back: the ledger settled it at its worst case, an estimate, with
  no tokens beside it). A dashboard sums the first two as spend and tells the third apart.
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
  spans: { keep: (span) => !["POST", "session.begin", "session.end"].includes(span.name) },
})
```

The old mapping also named the priced model (`langsmith.metadata.ls_model_name`), so LangSmith priced each run; that
would be a second price table beside the ledger, so it is not ported. Live LangSmith ingestion is unverified.

## Consequences

- A kernel host gets a trace of each turn, model call and tool call, and the four metrics, by providing one layer
  around its program; with no exporter, Effect's spans and metrics stay in the process and nothing a turn stores or
  sends changes (`telemetry.test.ts` compares the journal and the requests, the learn tests and the goldens pass).
- The content attributes are dropped by key from every exported span with content off, a host's own attributes of
  those names included, and with it off a failed span's own words and a log's text never reach a backend: a host that
  wants them turns content on, and gets the conversation with them.
- The old plugin keeps its copy of the moved files until the old engine is removed with it.

## What would reopen this

- Effect AI making the call's span the current span of a provider's stream, or opening a span for a tool call
  itself: the HTTP request would move under the call, or `tool.call` would be a second span.
- A host that needs content on for some calls and not others, which a per-attribute policy cannot tell apart, or a
  failure's words without the conversation's.
- A second source of cost, or a backend that prices runs the host must match.
