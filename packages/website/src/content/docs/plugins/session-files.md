---
title: File-backed sessions
description: Persist conversation journals in a directory on Node or Bun, with open turn admission.
pluginId: "@xandreed/plugin-session-files"
---

`sessionFilesPlugin` stores the agent's session journal in a directory and
provides an open turn-admission policy. Compose it with
[sessions](/docs/plugins/sessions/) to create conversations, serialize their
turns, and reopen their recorded history after a process restart.

## When to use it

Use this backend for a Node or Bun host that needs durable conversations on
local disk or a network mount supporting hard links. The directory holds
conversation records. Workspace file access belongs to the workspace tools;
document ingestion and retrieval belong to the knowledge plugins.

For a custom admission policy, choose the
[log-only variant](/docs/plugins/session-files-log/) instead. Both variants
use the same storage format.

## Install and configure

```sh
npm install effect @xandreed/plugin-session-files @xandreed/plugin-sessions
```

```ts
import { sessionFilesPlugin } from "@xandreed/plugin-session-files"
import { sessionsPlugin } from "@xandreed/plugin-sessions"

const plugins = [
  {
    plugin: sessionFilesPlugin,
    options: { path: ".efferent/runtime/sessions", stallMs: 10_000 },
  },
  sessionsPlugin,
]
```

Pass these entries in `Agent.define`'s `plugins` array alongside the rest of
your agent graph. This fragment supplies storage, admission, and sessions;
your host still supplies a model and the plugins used to render memory,
discover tools, and run steps. Configuration overrides the plugin defaults.

## What reaches disk

Under the configured root, the backend creates:

```text
store.json
sessions/<session-id>/claims/<generation>.json
sessions/<session-id>/removed/<incarnation>
lives/<session-id>.<incarnation>/header.json
lives/<session-id>.<incarnation>/commits/000000000001.jsonl
lives/<session-id>.<incarnation>/tmp/
removing/
staging/
quarantine/<session-id>/<incarnation>/
```

Each immutable commit file contains metadata, the session head's state,
event rows, and a byte-count/CRC-32 trailer. A commit can hold several events;
its revision differs from an event's sequence number. The header identifies
the session, its owner, its metadata, its initial state and any parent/fork
information.

Removing a session deletes its folder under `lives/` (header, commits and
temporary files) and any bytes set aside in `quarantine/`, and those of its
children. What stays is a claim (the session id, its incarnation and when it
was created) and a tombstone file named by the incarnation: enough to refuse
a stale reference and to number the next session created under the same id,
nothing of its owner, metadata, state or events. A removal stopped part way
(a crash, an unreachable mount) is recorded in `removing/` and finished when
the store is opened again, or when the same reference is removed again:
`SessionLog.remove`, or `Sessions.remove` given the session's `SessionRef`
(its `SessionView.incarnation` with the id and owner), which then fails with
`SessionMissing`.

The SDK records user and assistant messages, structured tool results,
selected lifecycle events, and request evidence in that journal. Streaming
deltas are transient; they are not a second stored copy of each message.
A file read by a workspace tool can appear as that tool's recorded result.
The backend does not independently copy the workspace or index its files.

The journal is also distinct from the model's next context: a conversation
memory plugin selects, renders, summarizes or compacts recorded entries.
See [context, memory and the journal](/docs/concepts/context-journal/).

## Atomicity, reads and recovery

The store writes a temporary commit, flushes it, then publishes its revision
with an exclusive hard link. Concurrent publishers compare revisions; an
existing final file is not overwritten. A filesystem without hard-link
support fails to open, including a store copied onto such a filesystem
after it was created. Native filesystem calls have bounded waits governed
by `stallMs`; a timed-out publication may need a subsequent read to establish
whether it landed.

`SessionLog.read` selects one session's events by sequence bounds, kinds and
limit. `Sessions` adds authorized lineage reads: a fork sees its ancestors
only through the recorded fork boundary, not their later turns.

On reopening, an incomplete or corrupt final commit is set aside in
`quarantine` and the previous whole commit becomes the head. Damage before
the tail fails the read instead of silently discarding history. Only layout 2 is supported. Other markers and nonempty unmarked roots are refused without mutation. Configure a fresh location; there is no migration or automatic deletion. Claims and generation tombstones are permanent; listing and removing sessions read only the sessions not removed, so that work does not grow with the sessions removed before. Owner/incarnation references fence reads, commits, removals and ancestry against replacements.

## Admission and lifecycle

This plugin provides both `SessionLog` and `TurnAdmissionOpen`. Open admission
accepts turns; it adds no account budget or application authorization rule.
`sessionsPlugin` supplies turn ownership and concurrency control above it.
Avoid composing another admission or session-log provider without an explicit
service binding. Closing the runtime releases its storage handle; persisted
commits remain available to a later runtime.

## Related guides

- [Context, memory and the journal](/docs/concepts/context-journal/)
- [Sessions and ownership](/docs/plugins/sessions/)
- [File log with custom admission](/docs/plugins/session-files-log/)
- [SQLite alternative](/docs/plugins/session-sqlite/)
- [SDK and sessions](/docs/concepts/harness/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-session-files` · Version **0.19.2** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/SessionLog`, `efferent/TurnAdmission` |
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
