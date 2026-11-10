---
title: Window memory
description: Fit a conversation into context with compact views, recoverable spills, and a turn ledger.
pluginId: "@xandreed/plugin-memory-window"
---

Window memory supplies `ConversationMemory`: the policy that turns a session's
recorded history into the messages sent to the model. Use it when you want a
bounded active conversation without paying for a summary model.

It preserves the full recorded history while shortening its presentation.
It does not learn facts across separate conversations or index documents.

## Install

```sh
npm install @xandreed/plugin-memory-window
```

Install the shared `effect`, core and SDK packages with the rest of your graph.
The plugin runs on Node 24 and Bun and requires no model credentials.

## Add to an agent

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const plugins = [
  { plugin: memoryWindowPlugin, options: {
    compactPreviousTurn: true,
    spillMinChars: 2_000,
    previewChars: 600,
    ledgerTurnChars: 240,
  } },
]
```

Use these entries in `Agent.define({ plugins })` with a loop, tool discovery,
a model, and session services. This fragment supplies only the context policy
and its recall capability. A durable session backend supplies persistence.

## What the model sees

A tool result longer than `boundOnWriteChars` (16,000 characters by default)
is bounded as it is written: every request shows its first 16,000 characters
and a notice with the locator and offset to read the rest from. See
[bound results as they are written](#bound-results-as-they-are-written).

At a new turn, earlier tool results can use each tool's compact view. Under
context pressure, the policy first replaces large current-turn results with
a preview and locator, then replaces the oldest turns with a short ledger.
The current admitted turn stays intact as a turn; individual results can spill.

The contributed `recall_context` tool reads a shortened result from the memory
archive, up to 8,000 characters per call. Its continuation offset reads the next
page. A recalled page is never shortened. Recall cannot reconstruct content
the original tool clipped before returning it.

Compaction actions are recorded before they apply. They change later model
requests, leaving the original tool result and messages in the journal. A new
memory strategy can rebuild from those original entries.

## Bound results as they are written

Without a bound, an agent whose tools return large results fills its context
in a few calls, and the policy then shortens results the model has already
been sent. `boundOnWriteChars` bounds each result once, before any request
includes it:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { boundOnWriteChars: 16_000 } }
```

A result whose view is longer than the bound is shown as its first characters
and a notice, for example `[… 36000 more characters kept out of context; call
recall_context with locator "run-1:4" and offset 16000 to read them]`. The
journal keeps the whole result. Within its turn, what the result shows
changes again only when context pressure spills it, so the start of each
request stays the same from one step to the next. If the write stops between
storing a result and recording its bound (the turn is cancelled, a sibling
call fails, the result's view or an append fails, the process dies), that
result stays without one and is shown whole until pressure spills it.

- A tool sets its own bound with the `boundOnWriteChars` annotation of
  `defineTool`; a tool that ends its result with its own continuation (an
  offset to read on from, an exit status) sets `0` to keep its results whole.
  The workspace tools `read`, `ls`, `find`, `grep` and `bash` do.
- A pinned result, a `recall_context` page and a result that holds images are
  never bounded. A digest recorded as the result was written is shown instead
  while it is no longer than the bound.
- Under pressure, a bounded result can be spilled again to the `previewChars`
  preview. The result that shows the most text is spilled first.
- At a new turn, an earlier turn's bounded result takes its tool's compact
  view only when that is shorter than what it shows.
- `boundOnWriteChars: 0` bounds nothing, as before the option.

Each bound is recorded as a compaction of the `window` strategy, so
`context.built` counts it among its `compactions`.

## Keep the current turn's results whole

A turn that reads a large result and keeps working with it over several steps
pays for each spill: the model sees a preview and calls `recall_context` to
read back what it just received. Set `currentTurnFirst: true` to reverse the
order under pressure:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { currentTurnFirst: true } }
```

The policy then compacts earlier turns and replaces the oldest turns with a
ledger first, keeping every result of the current turn whole. It spills the
current turn's largest results only when the current turn alone does not fit,
choosing the fewest spills and then the fewest dropped turns, and fails with
`context.budget` only when nothing fits. The default, `false`, keeps the order
above.

The option keeps the strategy id `window` and adds a suffix to its version:
`3+current-turn-first`. Compactions recorded under either order keep applying
exactly as they were recorded, while each request's `strategyVersion` (in its
recorded header and in `context.built`) shows which order decided it.

## Digests, images and budgets

`digestOnWriteChars: 0` disables eager digestion by default. To digest supported
large results on write, set a positive threshold and compose
[the digest plugin](/docs/plugins/memory-digest/). A tool must also declare a
digest task; adding the digester does not summarize every result.

`turnContext: "current"` avoids replaying obsolete turn-context sections.
Image presentation has separate `media`, `maxImages` and `maxMediaChars`
limits. Set `maxMediaChars: 0` for text-only model messages.

The available message budget excludes the system prompt and active tool
schemas. Token estimates can be calibrated by accepted provider input usage.
If the current turn still cannot fit at dispatch, the policy fails with
`context.budget`; it cannot make an arbitrarily large request fit.

## Scope and related plugins

The provider is runtime scoped, but opens an independent memory session over
each turn's authorized journal. Choose it or
[summary memory](/docs/plugins/memory-summary/) as the conversation strategy.
Using both providers requires an explicit binding and does not combine policies.

Add [long-term memory](/docs/plugins/memory/) for learned cross-conversation
knowledge or [RAG](/docs/plugins/rag/) for indexed documents. See
[context and the journal](/docs/concepts/context-journal/) for their boundaries
and [session files](/docs/plugins/session-files/) for durable local storage.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory-window` · Version **0.20.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ConversationMemory` |
| Requires | none |
| Uses when available | none |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "compactPreviousTurn": true,
  "turnContext": "current",
  "replies": true,
  "spillMinChars": 2000,
  "previewChars": 600,
  "ledgerTurnChars": 240,
  "digestOnWriteChars": 0,
  "digests": true,
  "media": "inline",
  "maxImages": 8,
  "maxMediaChars": 20000000,
  "currentTurnFirst": false,
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
    "compactPreviousTurn": {
      "type": "boolean"
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
    "spillMinChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "previewChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "ledgerTurnChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "digestOnWriteChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
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
    "currentTurnFirst": {
      "type": "boolean"
    },
    "boundOnWriteChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "compactPreviousTurn",
    "turnContext",
    "replies",
    "spillMinChars",
    "previewChars",
    "ledgerTurnChars",
    "digestOnWriteChars",
    "digests",
    "media",
    "maxImages",
    "maxMediaChars"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
