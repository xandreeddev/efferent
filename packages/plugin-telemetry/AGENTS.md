# @xandreed/plugin-telemetry

Usage, cost and tool telemetry for efferent turns, and OTLP/HTTP export of
the program's traces and metrics. Runs on Node 24 and Bun: it imports
`effect`, `effect/http`, `effect/observability` and `@xandreed/core` only,
never `node:*` or Bun's own APIs (the tests may use `Bun.serve` as a
collector; `scripts/telemetry-consumer.fixture.mjs` runs the packed package
on Node and Bun in `bun run verify:packages`).

- `telemetryPlugin` / `TurnTelemetryLive` (`turn-telemetry.adapter.ts`):
  session-scoped, requires `RunContext` and `TurnEvents`, provides nothing.
  One inline subscription to the turn's events, dispatched with
  `Match.valueTags` over the events it records (`assistant.message`,
  `tool.completed`, `tool.refused`, `step.ended`, `stream.fallback`);
  recording never fails the turn. Its optional `CurrentModelCallRecorder`
  dependency must be declared: runtime activation forwards declared keys only,
  so an undeclared Reference would read its default instead of the turn's recorder.
  A dedicated recorder observer survives the plugin's own scope and closes
  with `TurnLive`, after late helpers and finalizer work. It writes span events to the span current
  where it is built (`agent.turn` under `Agent.turn`), captured once with
  `Effect.currentSpan`: a subscriber's handler runs under the publisher's
  span, so `annotateCurrentSpan` there would land on the wrong span.
- Metrics (`telemetry-metrics.ts`, `TelemetryMetrics`): the definitions are
  the identity in Effect's registry (name, description, attributes), so tests
  and dashboards read them through the export. No metric carries a session,
  run or turn id. Token kinds come from core's `usageBreakdown` and sum to a
  response's `totalTokens`; cost is core's `costOf` with the host's prices,
  keyed by each ledger call's actual `"<provider>:<modelId>"` selection.
  Known and Partial reported subtotals count across every call purpose/outcome.
  `efferent.llm.calls` exposes purpose, outcome, usage coverage and whether a
  price is available; unknown usage and unpriced models never imply a free bill.
  A replayed durable call contributes to the turn span but does not increment
  global token/cost/call metrics again. Fresh bootstrap calls do increment them.
- `assistant.message` remains step narrative. If ANY ledger call is observed,
  even Unknown or Known0, it suppresses selected-response billing. When the
  recorder closes with no ledger, exact per-model legacy selected facts provide
  fallback; prior durable facts affect span cost only. Manual composition with
  a recorder lacking `observe` retains the existing caller-scoped legacy path.
  `efferent.model.called` span events retain reported usage/outcome/correlation;
  span attributes expose unknown, partial and unpriced coverage. Selected turn
  usage attributes/results keep their existing meaning. One cache-write rate
  still gives approximate mixed-TTL pricing.
- Options (`telemetry.entity.ts`) are flat: `prices`, `metricAttributes`,
  `spanEvents`. The plugin keeps the id of the package's pre-0.11.0 plugin,
  whose `enabled` and `serviceName` options are refused as unknown keys.
- Export (`otlp-telemetry.adapter.ts`): `OtlpTelemetryHttpLive` builds
  Effect's `OtlpTracer` and `OtlpMetrics` layers over the host's
  `HttpClient`, sharing one `OtlpExporter.layerFlusher` (memoized by
  reference); `OtlpTelemetryLive` adds `FetchHttpClient`.
  `OtlpTelemetryHttpFromEnv` (and `OtlpTelemetryFromEnv`, plus
  `FetchHttpClient`) resolves the standard `OTEL_*` variables in
  `otlpExportFromEnv` (`otlp-telemetry.entity.functions.ts`, read through
  the current `ConfigProvider`, so tests pass `ConfigProvider.fromEnv({ env })`)
  rather than Effect's `layerFromConfig`, which exports nothing unless
  `OTEL_TRACES_EXPORTER` lists `otlp` and needs a service name in the
  environment. It reads a variable only when it can matter (nothing past
  `OTEL_SDK_DISABLED=true`, nothing past the endpoints when no signal has
  one, a shared endpoint, compression or protocol only when the signal's
  own is unset), so an invalid
  value elsewhere never fails a host that exports nothing. The export is a
  Layer around the host's program, not a plugin: the `Tracer` and the
  metric registry are fiber references a plugin's `provides` cannot reach.
- LangSmith (`langsmith-telemetry.adapter.ts`): `LangSmithTelemetryHttpLive`
  installs the same Effect OTLP tracer over a host HttpClient, with
  `langSmithTracer` mapping run types before the original span's end exports
  it; `LangSmithTelemetryLive` adds FetchHttpClient. It exports traces only,
  shares the existing `OtlpExporter.layerFlusher` by reference, and uses
  `flushTelemetry`. It adds no LangSmith/provider/OpenTelemetry SDK.
  `LangSmithTelemetryOptions` requires a Redacted API key and one exclusive
  `LangSmithTarget`: Project, or Agent plus one `LangSmithEnvironment`.
  The full `tracesUrl` is used verbatim, defaulting to the US SaaS
  `/otel/v1/traces` endpoint. Target, key, URL and timing validation fail with
  the fixed secret-free `config.options` message; parse inputs and causes are
  never attached. Actual native Headers validation at the transport boundary
  rejects NUL and non-ByteString values before an exporter exists, retaining
  valid ASCII/Latin-1 values and discarding native secret-bearing errors.
  Unknown/raw-header options and mixed addressing are rejected.
  Generic OTLP export and environment behavior stay unchanged.
- LangSmith inference ownership: native `LanguageModel.generateText`,
  `generateObject` and `streamText` spans are LLM runs unless their exact
  span is marked `efferent.inference.synthetic`. Explicit supported host
  run types are preserved on host spans; inherited non-inference types never
  erase a native operation's LLM identity. An explicit parent inference boundary suppresses
  its native descendants even if the explicit kind was inherited. For nested
  host boundaries, an authored neutral inference operation also owns its native
  descendants; an explicit non-inference host kind takes precedence over that
  host operation. For nested
  automatic native wrappers, the innermost operation owns inference. Framework
  engine/agent/provider/task wrappers remain chains with backend usage/cost/
  operation aliases removed before export. Registry `tool.<name>` owns tool
  classification; `loop.tool_call` stays a chain. State is weak, per tracer,
  and bounded by span objects rather than a global ID registry. The decorator
  preserves span identity, getters, events, links, context, Exit, end time and
  idempotent end. Invalid external parent IDs are omitted using core's shared
  `traceParentOf`; valid sampled:false remains false.
- Native provider SDKs annotate their actual inference span. Plain custom
  LanguageModel.make returns usage without automatically annotating it:
  missing usage stays absent, never inferred from engine/turn/ledger totals
  and never invented as Known0. Hosts may annotate their actual options.span.
  No global SpanTransformer, response accumulator or wrapping model is added.
  Current cache-write spelling wins; deprecated cache_creation maps only when
  current cache_write is absent. The provider-name compatibility alias is
  destination-specific. Already-gated engine step input/output may map to
  chain input.value/output.value, with existing clipping; the exporter does
  not read payloads or override content consent. Tests use scripted models
  and local collectors. Live LangSmith ingestion remains UNVERIFIED.
- Public surface: the root names each export, and
  `quality/exports-have-consumers` checks each one. The scripts and other
  packages' tests import `telemetryPlugin`, `OtlpTelemetryLive` and
  `flushTelemetry`; the rest are tagged `@public` at their declarations:
  the turn's layers (`TelemetryPluginLive`, `TurnTelemetryLive`), their
  options (`TelemetryOptions`, `telemetryDefaults`), `TelemetryMetrics`,
  the export's layers (`OtlpTelemetryHttpLive`, `OtlpTelemetryHttpFromEnv`,
  `OtlpTelemetryFromEnv`) and their options (`OtlpTelemetryOptions`,
  `OtlpProtocol`, `OtlpCompression`, `OtlpTemporality`), plus the LangSmith
  layers, `LangSmithTelemetryOptions`, `LangSmithTarget`, `LangSmithAgentId`
  and `LangSmithEnvironment`. How a usage splits
  into token kinds (`tokenCounts`, `TokenKind`) stays inside the package.

See the root AGENTS.md for the enforced zero-baseline rules and checks, and
the website's `concepts/observability.md` for the user-facing contract.
