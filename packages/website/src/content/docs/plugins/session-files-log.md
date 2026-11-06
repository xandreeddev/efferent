---
title: File session log
description: Persist the session journal in a directory while supplying turn admission separately.
pluginId: "@xandreed/plugin-session-files/log"
---

`sessionLogFilesPlugin` provides the directory-backed `SessionLog` alone.
Use it when your host supplies its own `TurnAdmission`, such as a policy
that checks an account budget before a turn starts.

## Choose the appropriate entry

The package exports two plugin definitions. This entry provides storage;
[file-backed sessions](/docs/plugins/session-files/) pairs the same storage
with `TurnAdmissionOpen`. Select one definition for a storage root. A second
log provider requires an explicit binding in the agent graph.

The log does not decide when a model should run, manage a conversation's
turn lease, or construct the model's context. Those responsibilities belong
to `Sessions`, the host's turn code, and its conversation memory strategy.

## Install and configure

```sh
npm install effect @xandreed/plugin-session-files
```

```ts
import { sessionLogFilesPlugin } from "@xandreed/plugin-session-files"

const plugins = [
  {
    plugin: sessionLogFilesPlugin,
    options: { path: ".efferent/runtime/sessions", stallMs: 10_000 },
  },
]
```

This is an entry for `Agent.define`'s `plugins` array, not a complete agent.
Add [sessions](/docs/plugins/sessions/) and supply `TurnAdmission` through a
host service or another plugin. The rest of the graph still needs its model,
conversation memory, registry and step loop. Options merge over the defaults.

## Journal layout and contents

The format is identical to the combined file plugin:

```text
<root>/store.json
<root>/sessions/<session-id>/header.json
<root>/sessions/<session-id>/commits/<12-digit-revision>.jsonl
<root>/sessions/<session-id>/tmp/
<root>/staging/
<root>/trash/
<root>/quarantine/<session-id>/
```

A commit holds metadata, head state, ordered event rows, and a length/CRC-32
trailer. The SDK's recorded messages, tool results, requests and lifecycle
records become these rows. The log does not read arbitrary workspace files
or create a RAG index. Workspace content reaches a conversation when an
explicit message or tool result records it.

Conversation memory reads those durable records to construct a bounded
model context. Compaction and summaries are additional memory behavior;
storing a journal does not send all its bytes on every model request.
See [context, memory and the journal](/docs/concepts/context-journal/).

## Read, fork and restart behavior

The storage port reads one session with sequence, kind and limit filters.
A read from the end (`from: "end"`) opens commit files newest first and
stops once it holds its limit, so the latest records of a few kinds cost
the commits that hold them, not the whole session.
Fork ancestry and its sequence ceilings are applied by `Sessions`, so a child
does not inherit subsequent parent activity. Reuse the same configured root
to reopen a conversation after restart.

Commits are flushed and published by exclusive hard links rather than
rewriting a shared log file. Hard-link support is required, including on a
network mount. A torn or damaged final commit is quarantined and recovery
uses the previous whole revision; earlier corruption fails the read.
`stallMs` bounds native operation waits, not the duration of an agent turn.

## Host responsibilities

Supply admission before composing `sessionsPlugin`; this entry installs no
admission policy. Keep the storage directory intact between runs and use the
session APIs rather than editing published commit files. Runtime scope
cleanup releases the handle without erasing persisted history.

`MediaStoreDirectoryLive`, exported by the same package, is a separate layer
for immutable media blobs. It is not installed by this plugin; hosts opt into
media storage by composing it with core's session-log decorator.

## Related guides

- [Combined file storage and open admission](/docs/plugins/session-files/)
- [Sessions](/docs/plugins/sessions/)
- [Context, memory and the journal](/docs/concepts/context-journal/)
- [Core contracts](/docs/concepts/engine/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-session-files/log` · Version **0.17.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/SessionLog` |
| Requires | none |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "path": ".efferent/runtime/sessions",
  "stallMs": 10000
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
    "path": {
      "type": "string"
    },
    "stallMs": {
      "type": "integer",
      "minimum": 100,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "path",
    "stallMs"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
