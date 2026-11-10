---
title: Summary memory
description: Retain recent turns verbatim while folding older conversation into recorded summaries.
pluginId: "@xandreed/plugin-memory-summary"
---

Summary memory supplies `ConversationMemory`. It keeps recent turns in detail
and folds older whole turns into a recorded summary, including the previous
summary when one exists. Use it for long conversations whose goals and pending
work need a more descriptive handoff than a compact ledger.

Summaries shape one conversation's active context. They do not populate the
cross-conversation memory store or a document index.

## Install

```sh
npm install @xandreed/plugin-memory-summary
```

Install the shared `effect`, core and SDK packages with your graph. The plugin
runs on Node 24 and Bun; its helper calls require a configured model service.

## Add to an agent

```ts
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"

const plugins = [
  { plugin: memorySummaryPlugin, options: {
    summarizeAt: "turn-end",
    triggerRatio: 0.8,
    keepRatio: 0.16,
    cooldownTurns: 3,
    summaryTimeoutMs: 60_000,
  } },
]
```

Use these entries in `Agent.define({ plugins })` with the remaining loop,
discovery, model and session services. Supply `UtilityLlm` in each turn's
services, for example through [models](/docs/plugins/models/). The graph
declares it optional because the runtime-scoped policy reads it when opening
the turn; opening without it fails with `memory.summary`.

## Timing and retained history

The default considers a summary after the final reply is recorded and sealed.
It summarizes when the rendered messages exceed 80% of the message budget,
retains a recent tail targeted at 16%, and normally waits three turns between
successful summaries. Whole-turn boundaries can change the exact retained size.

The next run's start catches eligible work left unfinished. Select
`summarizeAt: "step"` to consider summaries before requests instead. Overflow
recovery can bypass normal pressure and cooldown checks; it still preserves
the active admitted turn.

A helper failure or timeout logs the failure and records no new summary.
The earlier summary remains usable, and that memory session does not repeatedly
buy the failed call. End-of-turn summary work cannot take away a sealed reply.

The summary and its compaction decision are journal records. Original messages
and tool results remain available to the archive and historical request replay.
Changing the context strategy does not delete or rewrite them.

## Checkpoints and limits

After a reducing summary, a compatible durable backend can save a render
snapshot. This is a checked acceleration of later rendering, not a replacement
archive or a retention policy. Cold open still loads and validates the archive;
unsupported or incompatible projections fall back to full rendering.

Summary instructions and a bounded transcript go to `UtilityLlm` as framed
data. The result is model-generated and can omit detail. Tune `keepRatio` and
evaluate the helper model before relying on summaries for exact records.

The `digests` option displays previously recorded digests. The built-in summary
policy does not itself request result digestion, and it never spills a result
under context pressure or reduces the current turn. Use
[window memory](/docs/plugins/memory-window/) when you want that behavior.

## Bound results as they are written

A tool result longer than `boundOnWriteChars` (16,000 characters by default)
is bounded as it is written: every request shows its first 16,000 characters
and a notice with the locator and offset to read the rest from, and the
journal keeps the whole result. The plugin contributes `recall_context`,
which reads a bounded result a page of up to 8,000 characters at a time.
Within the turn that wrote the result, the tool returns no text the request
still shows (the first 16,000 characters, or a page read a step ago): the call
is answered with a failure that names the offset to read on from. See
[reading a shortened result on](/docs/concepts/context-journal/#reading-a-shortened-result-on).

```ts
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"

const memory = { plugin: memorySummaryPlugin, options: { boundOnWriteChars: 0 } }
```

`boundOnWriteChars: 0` bounds nothing from then on. The plugin contributes
`recall_context` all the same: a session keeps the bounds it recorded, so one
continued at `0` still shows the results bounded earlier with their notice,
which names the tool. A tool sets its own bound with the `boundOnWriteChars`
annotation of `defineTool`, and `0` there keeps that tool's results whole. A
pinned result, a `recall_context` page and a result that holds images are
never bounded.

Summary memory folds earlier turns and never reduces the current one. Results
that are each bounded can still pass the budget together within one turn
(twelve at the default bound fill the default 64,000-token budget), and the
request is then sent as it is: size `boundOnWriteChars` or `budgetTokens` for
the turns your agent runs.

Each bound is recorded as a compaction of the `summary` strategy, whose
version stays `2`: render snapshots saved before this option keep applying.
[Context and the journal](/docs/concepts/context-journal/#bounding-what-a-tool-shows)
lists the rules and the limits.

## Related plugins

Choose one `ConversationMemory` provider. Add
[long-term memory](/docs/plugins/memory/) and [capture](/docs/plugins/memory-capture/)
alongside it for evidence-backed learning across conversations, or
[RAG](/docs/plugins/rag/) for documents. The
[context and journal guide](/docs/concepts/context-journal/) explains restart,
request replay, and the difference between summaries and learned memory.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory-summary` · Version **0.20.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ConversationMemory` |
| Requires | none |
| Uses when available | `@xandreed/core/UtilityLlm` |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "summarizeAt": "turn-end",
  "triggerRatio": 0.8,
  "keepRatio": 0.16,
  "cooldownTurns": 3,
  "turnContext": "current",
  "replies": true,
  "digests": true,
  "media": "inline",
  "maxImages": 8,
  "maxMediaChars": 20000000,
  "instructions": "Summarize the earlier part of this conversation for the same assistant, which will continue from your summary plus the newest turns. Preserve, in order: the user's goals and constraints; facts and records established (with their identifiers); answers already given; open questions and pending work. Dense prose and lists; never invent anything not in the transcript.",
  "summaryTimeoutMs": 60000,
  "boundOnWriteChars": 16000
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
    "summarizeAt": {
      "type": "string",
      "enum": [
        "step",
        "turn-end"
      ]
    },
    "triggerRatio": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "keepRatio": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "string",
          "enum": [
            "Infinity",
            "-Infinity",
            "NaN"
          ]
        }
      ]
    },
    "cooldownTurns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "turnContext": {
      "type": "string",
      "enum": [
        "current",
        "all"
      ]
    },
    "replies": {
      "type": "boolean"
    },
    "digests": {
      "type": "boolean"
    },
    "media": {
      "type": "string",
      "enum": [
        "none",
        "inline"
      ]
    },
    "maxImages": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxMediaChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20000000
    },
    "instructions": {
      "type": "string"
    },
    "summaryTimeoutMs": {
      "type": "integer",
      "minimum": 100,
      "maximum": 600000
    },
    "boundOnWriteChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "summarizeAt",
    "triggerRatio",
    "keepRatio",
    "cooldownTurns",
    "turnContext",
    "replies",
    "digests",
    "media",
    "maxImages",
    "maxMediaChars",
    "instructions",
    "summaryTimeoutMs"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
