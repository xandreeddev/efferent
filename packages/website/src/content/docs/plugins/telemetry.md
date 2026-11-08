---
title: Turn telemetry
description: Record model usage, estimated cost and tool metrics per turn, with host-controlled OTLP export.
pluginId: "@xandreed/plugin-telemetry"
---

`telemetryPlugin` records model-call usage, estimated cost, tool activity and
turn span events. Use it to observe an agent's work and distinguish reported
usage from unknown or unpriced calls.

Recording and export are separate: the plugin records in-process; the host
installs an exporter around the program when data should leave the process.

## Install and configure

```sh
bun add @xandreed/plugin-telemetry
```

```ts
import { Agent } from "@xandreed/sdk"
import { telemetryPlugin } from "@xandreed/plugin-telemetry"

const plugins = [
  {
    plugin: telemetryPlugin,
    options: {
      prices: {
        "primary:chat-model": {
          input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25,
        },
      },
      metricAttributes: { "deployment.environment": "development" },
      spanEvents: true,
    },
  },
]

const definition = Agent.define({ plugins })
```

The key and rates are illustrative: use the actual `provider:modelId`
selection and your host's prices per million tokens, in one currency.
Merge this fragment into the complete graph from
[Getting started](/docs/getting-started/), build it in an Effect scope,
and supply normal sessions and model services when running turns.

## Requirements and lifetime

The session-scoped plugin requires the turn's `RunContext` and `TurnEvents`,
which `Agent.turn` supplies. It optionally observes `CurrentModelCallRecorder`
to include physical model attempts, helpers and late work. It provides no
service or exporter. Recording itself does not fail a turn.

Ordinary event subscriptions close with the plugin. Recorder observation
lasts until the turn closes, covering late helpers and finalizer work.
Replayed durable calls contribute to span evidence without incrementing
global call, token and cost counters again.

## Usage, cost and export

Unknown usage and missing prices remain explicit gaps, not zero-cost calls.
Partial usage contributes an incomplete subtotal. A single cache-write rate
makes mixed-lifetime cache cost approximate. These observed totals are not
a provider invoice, and selected-response turn usage keeps its own meaning.

The models plugin's [spend caps](/docs/plugins/models/#spend-caps) price
the same usage with the same `ModelPrice` table, keyed the same way, so one
table can serve both. They differ where usage is missing: telemetry reports
no cost for an unknown usage, while the spend ledger settles a completed or
interrupted attempt with no final usage at its reserved worst case. For calls
with known usage, the reported cost and the settled spend agree.

Keep `metricAttributes` few and bounded; do not use session, run or user ids
as metric dimensions. Those correlations belong on spans. `spanEvents: false`
disables the plugin's span enrichment while retaining its metrics.

For OTLP/HTTP export, wrap the host program with a layer, outside `plugins`:

```ts
import { Effect } from "effect"
import { OtlpTelemetryLive } from "@xandreed/plugin-telemetry"

declare const program: Effect.Effect<void>

const observed = program.pipe(Effect.provide(OtlpTelemetryLive({
  baseUrl: "http://localhost:4318",
  serviceName: "my-agent",
})))
```

Run and close the host's Effect scope so exporters can flush. The package
supports Node 24 and Bun; `OtlpTelemetryLive` supplies a fetch HTTP client,
while `OtlpTelemetryHttpLive` accepts the host's client. Environment-based
and LangSmith export layers are covered in the observability guide.

A host with an export policy passes `spans` (`OtlpSpanPolicy`): `keep`
drops spans (their children are sent under the nearest kept ancestor) and
`attribute` rewrites or leaves out span and span-event attributes before
they reach the exporter. A host that runs its own OpenTelemetry provider
bridges Effect's tracer into it instead and leaves the export layers out;
the plugin's span events and metrics work with any tracer. The
[observability guide](/docs/concepts/observability/#export-traces-and-metrics)
covers both.
The old plugin options `enabled` and `serviceName` are rejected: service
naming belongs to the export layer.

## Related guides

- [Observability](/docs/concepts/observability/) for metrics, spans, export and content consent.
- [Events](/docs/guides/events/) for turn events and model-call records.
- [Context and journal](/docs/concepts/context-journal/) for durable evidence versus the current prompt.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-telemetry` · Version **0.19.2** · Plugin API **3** · Scope **session**

| Contract | Services |
| --- | --- |
| Provides | none |
| Requires | `efferent/RunContext`, `efferent/TurnEvents` |
| Uses when available | `@xandreed/core/CurrentModelCallRecorder` |
| Contributes | none |

### Default options

```json
{
  "prices": {},
  "metricAttributes": {},
  "spanEvents": true
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "prices": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "input": {
            "type": "number",
            "minimum": 0
          },
          "output": {
            "type": "number",
            "minimum": 0
          },
          "cacheRead": {
            "type": "number",
            "minimum": 0
          },
          "cacheWrite": {
            "type": "number",
            "minimum": 0
          },
          "reasoning": {
            "type": "number",
            "minimum": 0
          }
        },
        "required": [
          "input",
          "output",
          "cacheRead",
          "cacheWrite"
        ],
        "additionalProperties": true
      }
    },
    "metricAttributes": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "spanEvents": {
      "type": "boolean"
    }
  },
  "required": [
    "prices",
    "metricAttributes",
    "spanEvents"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
