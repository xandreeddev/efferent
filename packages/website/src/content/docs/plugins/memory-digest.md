---
title: Result digests
description: Run tool-defined selection and summarization tasks to reduce result context.
pluginId: "@xandreed/plugin-memory-digest"
---

The digest plugin provides `ResultDigester`, a helper that selects useful items
or summarizes a tool result. Use it when a tool declares how its large output
can be shortened and the conversation-memory policy asks for that digestion.

Three components cooperate: the tool defines the digest task, the memory policy
decides when to request it, and this plugin calls `UtilityLlm`. Installing the
plugin alone does not digest every tool result.

## Install

```sh
npm install @xandreed/plugin-memory-digest @xandreed/plugin-memory-window
```

Install the shared `effect`, core and SDK packages with your other plugins.
The plugin runs on Node 24 and Bun and uses the turn's configured helper model.

## Add to an agent

This fragment enables digestion on write for supported results of at least
4,000 characters:

```ts
import { memoryDigestPlugin } from "@xandreed/plugin-memory-digest"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const plugins = [
  { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } },
  { plugin: memoryDigestPlugin, options: {
    maxSourceChars: 48_000,
    digestTimeoutMs: 30_000,
  } },
]
```

Use the entries in `Agent.define({ plugins })` with your loop, discovery,
session services and models. `UtilityLlm` is required; the
[models plugin](/docs/plugins/models/) supplies it. Tools also need a digest
definition in their result view. A tool without one keeps its ordinary view.

## Selection and summarization

A selection task supplies keyed items. The helper chooses among the offered
keys, and the tool re-renders complete selected items. Unknown keys are ignored;
the helper cannot create a new item by returning a new key.

A summarization task supplies text and any identifiers that must survive.
The proposed summary is accepted only when those required identifiers remain.
The tool's own application function decides whether an outcome is usable.

The current user request and result are framed as data and bounded before the
helper call. `maxSourceChars` limits helper input; it is not a promise to retain
every detail from a larger result. `digestTimeoutMs` bounds each call.

## Journal and lifecycle

The original returned result remains in the conversation journal. An accepted
digest becomes a separate `ToolDigest` record that later requests can show in
place of the original view. Replay reuses the recorded digest without another
model call. A failure or timeout records no digest and preserves the result's
existing view.

The plugin is session scoped: its helper belongs to the current turn and its
usage accounting. It has no background indexing worker or separate knowledge
database. The window policy can later spill a result and expose
`recall_context` for bounded access to the stored original view.

[Summary memory](/docs/plugins/memory-summary/) can display recorded digests,
but its built-in policy does not initiate them. A custom memory policy can
request digest tasks independently of this example's on-write threshold.

## Related plugins

Digests reduce the cost of active context. They are distinct from
[learned memory](/docs/plugins/memory/) and [document RAG](/docs/plugins/rag/).
See [context and the journal](/docs/concepts/context-journal/) for a file-read
walkthrough and the limits of reconstructing content clipped by a tool.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory-digest` · Version **0.19.2** · Plugin API **3** · Scope **session**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ResultDigester` |
| Requires | `@xandreed/core/UtilityLlm` |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "maxSourceChars": 48000,
  "digestTimeoutMs": 30000
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
    "maxSourceChars": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 400000
    },
    "digestTimeoutMs": {
      "type": "integer",
      "minimum": 100,
      "maximum": 600000
    }
  },
  "required": [
    "maxSourceChars",
    "digestTimeoutMs"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
