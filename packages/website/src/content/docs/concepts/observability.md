---
title: Observability
description: Export each turn's trace and the framework's metrics over OTLP, and record usage, cost and tool metrics per turn with the telemetry plugin.
---

# Observability

Every turn `Agent.turn` runs is one trace subtree under its `agent.turn`
span (a child of the caller's span, if any), its begin a span beside it,
its logs annotated with its ids, and the packages update Effect
metrics as they work (turns, steps, model
calls, tool calls). All of it goes through Effect's own `Tracer` and metric
registry, and none of it leaves the process until the host provides an
exporter around its program. `@xandreed/plugin-telemetry` provides both
halves on Node 24 and Bun:

- **Export**: `OtlpTelemetryLive`, `OtlpTelemetryHttpLive` and
  `OtlpTelemetryFromEnv` post traces and metrics over OTLP/HTTP with the
  exporters Effect ships (`effect/observability`). No OpenTelemetry SDK is
  installed.
- **Per-turn telemetry**: `telemetryPlugin` records each turn's token usage
  by billed kind, its cost at the host's prices, tool calls, refusals and
  durations, steps and stream fallbacks, and writes the turn's usage and
  refusals as events on its `agent.turn` span.

## Export traces and metrics

Provide the export layer around the program that defines the agent and runs
its turns. It is the `Tracer` and the metrics exporter of everything inside:

```ts
import { Effect } from "effect"
import { OtlpTelemetryLive } from "@xandreed/plugin-telemetry"

declare const program: Effect.Effect<void> // Agent.define, then agent.turn(...)

Effect.runFork(program.pipe(Effect.provide(OtlpTelemetryLive({
  baseUrl: "http://localhost:4318",          // traces to /v1/traces, metrics to /v1/metrics
  headers: { authorization: "Bearer …" },
  serviceName: "support-agent",              // "efferent" by default
}))))
```

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | — | the collector; each signal goes to `<baseUrl>/v1/traces` or `/v1/metrics` |
| `tracesUrl`, `metricsUrl` | — | a signal's own URL, used as given; it wins over `baseUrl` |
| `traces`, `metrics` | `true` | turn a signal off; a signal with no URL is not exported either |
| `serviceName` | `resourceAttributes["service.name"]`, else `"efferent"` | the resource's `service.name` |
| `serviceVersion`, `resourceAttributes` | none | the rest of the resource every span and metric is reported under |
| `headers` | none | sent with every request, both signals |
| `tracesHeaders`, `metricsHeaders` | none | sent with one signal's requests only, over `headers` (a signal at another vendor, with its own key) |
| `protocol` | `"http/protobuf"` | or `"http/json"`; gRPC is not supported |
| `compression` | `"none"` | or `"gzip"` (batches under 1 KB stay uncompressed) |
| `exportInterval` | 5 s traces, 10 s metrics | how often batches are posted |
| `shutdownTimeout` | 3 s | how long closing the layer waits for the last post |
| `metricsTemporality` | `"cumulative"` | or `"delta"`, for backends that want deltas |

These layers take their options as given. They ignore `OTEL_SERVICE_NAME`
and the `service.name` in `OTEL_RESOURCE_ATTRIBUTES`: `serviceName` (or the
`"efferent"` default) always names the service, so set it there or use
`OtlpTelemetryFromEnv`. Effect's exporter still merges the other
`OTEL_RESOURCE_ATTRIBUTES` into the resource, under `resourceAttributes`,
and reads `OTEL_SERVICE_VERSION` when no `serviceVersion` is given.

Spans are batched and posted every interval; the metric registry (every
metric the program updated, the framework's and the plugin's) is posted whole
each interval. Closing the layer posts what is left. A post that fails is
retried, then that signal pauses for 60 seconds; export never fails the
program.

**A host's HTTP client.** `OtlpTelemetryLive` and `OtlpTelemetryFromEnv`
post with the global `fetch`. `OtlpTelemetryHttpLive(options)` and
`OtlpTelemetryHttpFromEnv(defaults?)` take the `HttpClient` from the host
instead, for a proxy or custom TLS:
`OtlpTelemetryHttpFromEnv().pipe(Layer.provide(myHttpClientLayer))`.

**From the environment.** `OtlpTelemetryFromEnv(defaults?)` reads the
standard OpenTelemetry variables, over `defaults` (the options above) for
what they leave unsaid. With no endpoint, or with `OTEL_SDK_DISABLED=true`,
it exports nothing, so a host can always provide it:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector; each signal gets `/v1/traces` or `/v1/metrics` appended |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `..._METRICS_ENDPOINT` | a signal's own URL, used as given |
| `OTEL_EXPORTER_OTLP_HEADERS`, `..._TRACES_HEADERS`, `..._METRICS_HEADERS` | `key=value` pairs, comma-separated, values URL-encoded; a signal's own over the shared ones |
| `OTEL_EXPORTER_OTLP_COMPRESSION`, `OTEL_EXPORTER_OTLP_PROTOCOL` (and per signal) | `gzip` or `none`; `http/protobuf` or `http/json` |
| `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_RESOURCE_ATTRIBUTES` | the resource: `service.name` from the first, else the third, else `defaults.serviceName`, else `defaults.resourceAttributes`, else `efferent` (`service.version` likewise from the second); the third's attributes win over `defaults.resourceAttributes` |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | a list without `otlp` (such as `none`) turns that signal off |
| `OTEL_SDK_DISABLED=true` | exports nothing |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_METRIC_EXPORT_INTERVAL` | the export intervals, in milliseconds |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `cumulative`, `delta` or `lowmemory` (deltas) |

`OTEL_EXPORTER_OTLP_TIMEOUT` is not read: `shutdownTimeout` comes from
`defaults` only. A variable is read only when it can matter: nothing after
`OTEL_SDK_DISABLED=true`, nothing about a signal its exporter list turns
off, nothing past the endpoints when no signal has one, and a shared
endpoint, compression or protocol only when the signal's own is unset. A variable that is read and set
to a value the layer cannot use (`grpc`, an invalid URL, a stray `%` in
headers) fails the layer with its `ConfigError`.

**Serverless.** A host that may be frozen once it responds (a Vercel or
Lambda function) flushes before responding: `flushTelemetry` posts every
pending batch and waits for those posts. It cannot fail; bound it with
`Effect.timeoutOption` when the response has a deadline.

```ts
import { Effect } from "effect"
import { flushTelemetry } from "@xandreed/plugin-telemetry"

declare const handleRequest: Effect.Effect<Response>
const respond = handleRequest.pipe(Effect.tap(() => flushTelemetry.pipe(Effect.timeoutOption("2 seconds"))))
```

**Evaluations.** `efferent-eval` provides an app's `observability` layer
around each command that loads the app, and closes it with the command:
`observability: Layer.orDie(OtlpTelemetryFromEnv())` in `eval.config.ts`
exports the command's `eval.cli` span and everything under it, an
interrupted command's too. A variable set to an invalid value stops the
command at start; a failed export never fails it.
[Evals](/docs/concepts/evals/#traces) lists the spans.

The export layer joins Effect's tracer only. A host already running the
OpenTelemetry Node SDK (with HTTP or database auto-instrumentation) gets two
separate pipelines; traces from both reach a collector but are not
parent-linked.

## The span tree

```text
agent.turn.begin                 Agent.turn beginning the turn: session plugins activated, Sessions.begin
agent.turn                       Agent.turn, or a host's composition with traceTurn(writer)
├─ engine.run                    one run of the step loop (turn.run)
│  └─ engine.turn                one step
│     └─ LanguageModel.*         effect/ai's span of the model call
│        ├─ providers.generate   the models plugin's call (model, usage, finish reason)
│        │  └─ models.credentials  the call's credential, a token refresh included
│        └─ tool.<name>          the tool registry's call, refused calls included
│           └─ (the handler's own spans)
└─ turn.persist_reply            the turn's reply recorded as it ends (guardTurn), failed or not
```

`agent.turn` carries `efferent.session.id`, `efferent.run.id`,
`efferent.turn` (which every span under it repeats), `gen_ai.conversation.id`
and `efferent.origin`, and ends with `efferent.outcome`, the failure's code
and the turn's usage (`efferent.usage.*_tokens`). Each provider step's
`engine.turn` carries the call's usage under the OpenTelemetry GenAI names.
Prompts and responses stay out of spans unless a run captures trace content
(`captureTraceContent`). [SDK & sessions](/docs/concepts/harness/) shows
how a turn is composed; the repository's `docs/framework.md` ("Traces and
metrics") lists every attribute and where captured contexts nest.

`agent.turn.begin` is the turn's sibling under the caller's span. `Agent.turn`
opens it when it begins the turn itself (a turn the host began, its
`TurnWriter` passed in, has none), around the session-scoped plugins'
activation and `Sessions.begin`. It carries `efferent.session.id`,
`efferent.run.id` and `efferent.origin`, and ends with `efferent.turn` once
the turn begins, or with `efferent.failure.code` when it cannot: the
refusal's code (`session.busy`, `turn.duplicate`, `session.missing`…), the
same code `agent.turn` would give; a turn that could not begin has no
`agent.turn`. A host composing its own turn wraps its begin in
`traceTurnBegin({ session, runId, origin })` and the rest in
`traceTurn(writer)`.

**Ids in logs.** Logs carry the ids as annotations, under the span
attributes' names. A line logged inside a turn `Agent.turn` runs (the
host's `use`, a tool handler, a plugin) carries `efferent.session.id`,
`efferent.run.id` and `efferent.turn`; one logged while the turn begins,
the first two. Effect's loggers print annotations (`Logger.consolePretty`,
`Logger.consoleJson`, `Logger.consoleLogFmt`); a host's own logger reads
them from `References.CurrentLogAnnotations`. A host annotating its own
logs or spans uses the same keys: `turnAttributes(admitted)` and
`sessionAttributes(session)` from `@xandreed/core`. Annotations the host set
where it captured the turn's services do not replace the turn's, as for
spans.

**Other spans.** Beside the tree above: the workspace plugin's
`skills.settle` (its skills directory read, at `Agent.define`, outside any
turn; the read itself, core's `collectSkillFiles`, is `skills.collect`) and
`bash.exec` (a host calling `Bash.exec` itself; the bash tool streams, under
its `tool.<name>`); the session logs' `session_log.*` (`create`, `head`,
`list`, `read`, `commit`, `remove`, and the SQLite store's `open`), in
memory (`SessionLogMemoryLive`) as in SQLite, each with
`efferent.session.id` when it names a session, wherever the log is called;
the sessions plugin's `sessions.*` (each `Sessions` call but `changes`, with
`efferent.session.id`; `sessions.begin` under `agent.turn.begin` when
`Agent.turn` begins the turn) and its turn writer's `turn_writer.commit`
(one per commit, under the span of the call that asked for it),
`turn_writer.flush` and `turn_writer.end`, each with the turn's ids; the
render plugin's `render.emit`; and the evals' `eval.*` spans
([evals](/docs/concepts/evals/)).

## The telemetry plugin

```ts
import { telemetryPlugin } from "@xandreed/plugin-telemetry"

const telemetry = { plugin: telemetryPlugin, options: {
  prices: { "anthropic:claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  metricAttributes: { "deployment.environment": "production" },
} }
// Agent.define({ plugins: [...plugins, telemetry], ... })
```

It is session-scoped and requires the turn's `RunContext` and `TurnEvents`,
so `Agent.turn` builds it for each turn inside the turn's `agent.turn` span.
It provides nothing and exports nothing itself: the export layer above
carries what it records.

| Option | Default | Meaning |
| --- | --- | --- |
| `prices` | `{}` | a `ModelPrice` (per million tokens) per model, keyed as responses name it: the models plugin's `"<provider>:<modelId>"` selection |
| `metricAttributes` | `{}` | constant attributes on every metric it records; keep them few and bounded |
| `spanEvents` | `true` | write the turn's ids, response and refusal events and the running cost on the span where it is built |

**Metrics.** None carries a session, run or turn id (those are on the
spans), so series stay few:

| Metric | Attributes | Counts |
| --- | --- | --- |
| `efferent.llm.tokens` | `efferent.model`, `efferent.token.kind` | each response's tokens by billed kind: `input` (uncached), `cache_read`, `cache_write`, `reasoning`, `output` (without reasoning); they sum to the response's `totalTokens` |
| `efferent.llm.cost` | `efferent.model` | each priced response's cost, in the prices' currency |
| `efferent.steps` | `efferent.step.status` | steps of the step loop, by how they ended: `completed`, `failed`, `cancelled`, or `malformed` (a response the model could not form, answered with a corrective turn) |
| `efferent.tool.calls` | `efferent.tool`, `efferent.ok` | tool calls whose handler ran |
| `efferent.tool.duration` | `efferent.tool`, `efferent.ok` | those calls' time, in milliseconds |
| `efferent.tool.refused` | `efferent.tool`, `efferent.refusal.reason` | calls the registry refused before the handler ran |
| `efferent.stream.fallbacks` | — | streamed calls that failed before their first part and were answered without streaming |

`TelemetryMetrics` exports these definitions, for reading them in tests or
naming them in dashboards. The framework's own metrics ride the same export:
`efferent.turns` and `efferent.turn.duration` (by outcome, from
`Agent.turn`), `engine.runs`, `engine.tool_calls` and `engine.corrections`
(the step loop), and `llm.requests`, `llm.request.duration` and
`llm.usage.*_tokens` (the models plugin, utility calls included).

**Span events.** On `agent.turn`, with `spanEvents`: an
`efferent.step.usage` event per response (its step, model, usage and cost),
`efferent.tool.refused` per refused call (its step, tool, invocation id and
`efferent.refusal.reason`), `efferent.stream.fallback` per fallback (its
step and the stream's error, cut to 300 characters), and the attribute
`efferent.cost`, the turn's running cost. An event's step,
`efferent.step`, is the step loop's zero-based index: the step whose
`engine.turn` span carries `engine.step` one higher. A response with no
usage (a host-planned step 0) records nothing.

**Cost.** A response's cost is core's `costOf(usage, price)`: each billed
kind at its price, reasoning at `price.reasoning` or else the output price,
all cache writes at one rate. A response is priced only when its model has a
price: one with no model, from a `LanguageModel` the models plugin did not
route, is counted under `efferent.model: "unknown"` and has no cost. A turn's
own total is `costOf(result.usage, price)` over the `TurnResult` `Agent.turn`
returns.

**What it does not see.** The plugin closes with the turn's other
turn-dependent plugins, before the turn's reply is recorded, so it never sees
`turn.ended`; the turn's total is on `agent.turn` and in the `TurnResult`.
Like the turn's usage, it counts only responses the step loop received: not
a memory strategy's utility calls (the models plugin's `llm.usage.*`
counters do include them), a malformed response the loop corrected, or a
failed attempt.

**A host's own turn.** `TurnTelemetryLive(options)` is the plugin's layer.
A host composing its own turn builds it over the turn's `RunContext` and
`TurnEvents` inside the span it wants written to (`traceTurn`'s, normally);
that span must stay open while the turn runs.

**Earlier plugin.** The package reuses the id of the plugin it shipped
before 0.11.0, `@xandreed/plugin-telemetry` (npm's 0.3.0 and 0.4.0). That
plugin's options, `enabled` and `serviceName`, are refused
(`config.options`): export is the host's export layer now, and the service
name is its `serviceName`. Its other exports are gone too: `TracingLive`,
`FileLoggerLive`, `FileLoggerAddLive`, the default export, and the
`TurnHooks` the plugin provided. `TracingLive(serviceName)` becomes
`OtlpTelemetryLive({ baseUrl, serviceName })`, or
`OtlpTelemetryFromEnv({ serviceName })` for the `OTEL_EXPORTER_OTLP_*`
endpoint it read (`baseUrl: "http://localhost:4318"` in the defaults keeps
its fallback); import the plugin by name (`telemetryPlugin`); and log to a
file with Effect's own `Logger` (`Logger.toFile`).
