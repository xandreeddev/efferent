---
title: Conversation memory capture
description: Synchronize committed journal evidence into durable long-term memory jobs.
pluginId: "@xandreed/plugin-memory/capture"
---

Conversation capture connects owner-checked `Sessions` to `LongTermMemory`.
It reads durably closed turns, creates deterministic evidence sources, enqueues
them, and records a synchronization checkpoint in the source journal.
Use it alongside the memory engine to learn from conversations automatically.

Capture does not itself call an extraction model or wait for knowledge to become
searchable. The memory engine's separate worker performs that work.

## Install

```sh
npm install @xandreed/plugin-memory
```

Capture is a second plugin exported by the memory package; it is not a separate
npm package. Supply the shared core/SDK dependencies and the native engine's
storage, helper model and embedding service.

## Add to an agent

```ts
import { memoryCapturePlugin, memoryPlugin } from "@xandreed/plugin-memory"

const plugins = [
  { plugin: memoryPlugin, options: {
    namespace: "assistant", collection: "memory",
    embeddingModel: "host-embedding", embeddingVersion: "1",
    embeddingDimensions: 768,
  } },
  { plugin: memoryCapturePlugin, options: {
    namespace: "assistant", collection: "memory",
    maxSourceChars: 48_000,
    maxTurns: 10,
    pageSize: 500,
    maxPages: 100,
  } },
]
```

Use these entries in `Agent.define({ plugins })` with a `MemoryStore` provider,
the actual matching embedding service, `UtilityLlm`, and the rest of the graph.
The session-scoped capture plugin requires `Sessions` before the turn starts.
If the host supplies it per turn, declare it among `turnServices`.

## What becomes evidence

Capture includes the initial user request, steered user input, final reply,
original journaled tool-result views, correlated tool arguments, and handler receipts.
Tool arguments are paired by their actual run, step and call association.
A handler receipt describes execution; the domain result must establish any
claim that an external action completed.

Intermediate assistant messages, reasoning, summaries, digests, context sections
and memory/RAG tool results are skipped as standalone capture events. Final
replies are retained, so they can still contain proposals or repeat retrieved
material. The extraction model is instructed to distinguish those statements
from confirmed effects; capture itself does not certify them as facts.

The tool view is the original recorded result view, before later context
presentations or digests. Capture does not read those shortened presentations,
and cannot restore content already clipped by the original tool.

Large turns split into exact UTF-16 ranges with one source episode identity.
The original turn timestamps and part offsets remain available as metadata.
Only owner-authorized session reads are used.

## Commit acknowledgement and catch-up

The SDK calls committed-turn observers after its own successful `TurnWriter.end`
acknowledgement, including when the turn's outcome failed. Successful tool
effects in a failed turn therefore remain eligible evidence. A failed closing
commit is not treated as captured history.

Observer failure is logged without changing the original turn result. A later
turn's memory preparation can catch up; hosts can explicitly call
`MemoryCapture.sync(address)`. If a host supplies its own `TurnWriter`, the
host owns the closing commit and calls `sync` after that end is acknowledged.

Enqueue precedes the journal checkpoint. A lost checkpoint acknowledgement
replays the same source identities rather than creating duplicate jobs.
Forgetting a source leaves a tombstone that retry or backfill respects.

## Bounded history and persistence

`sync` returns `sources`, `through` and `hasMore`, with an optional
`stalled: "open-turn" | "page-limit"`. An incomplete turn or exhausted scan
does not acknowledge unprocessed evidence. Adjust bounds or continue explicitly;
one sync call is not a complete-history guarantee.

`backfill({ owner, before?, limit? })` visits a bounded session-list page.
Retain its returned cursor to continue. Persistence depends on both the
[session backend](/docs/plugins/session-files/) and
[knowledge store](/docs/plugins/knowledge-postgres/). See
[long-term memory](/docs/plugins/memory/) and
[context and the journal](/docs/concepts/context-journal/) for processing and restart.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory/capture` · Version **0.17.0** · Plugin API **3** · Scope **session**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/plugin-memory/MemoryCapture` |
| Requires | `efferent/Sessions`, `@xandreed/core/LongTermMemory` |
| Uses when available | none |
| Contributes | `@xandreed/core/CommittedTurnObservers` |

### Default options

```json
{
  "namespace": "default",
  "collection": "memory",
  "maxSourceChars": 48000,
  "maxTurns": 10,
  "pageSize": 500,
  "maxPages": 100
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
    "namespace": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "collection": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "maxSourceChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxTurns": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "pageSize": {
      "type": "integer",
      "maximum": 5000,
      "exclusiveMinimum": 0
    },
    "maxPages": {
      "type": "integer",
      "maximum": 1000,
      "exclusiveMinimum": 0
    }
  },
  "required": [
    "namespace",
    "collection",
    "maxSourceChars",
    "maxTurns",
    "pageSize",
    "maxPages"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
