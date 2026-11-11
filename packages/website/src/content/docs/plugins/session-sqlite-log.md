---
title: SQLite session log
description: Use Bun's SQLite session storage with a separate host admission policy.
pluginId: "@xandreed/plugin-session-sqlite/log"
---

`sessionLogSqlitePlugin` supplies only the SQLite-backed `SessionLog`.
Choose it when your application provides `TurnAdmission` and wants durable
session events without installing the package's open admission policy.

## Runtime and package

The log-only and [combined SQLite plugin](/docs/plugins/session-sqlite/) are
exports of the same package. Both use `bun:sqlite`; this package is Bun-only.
Importing the log-only export does not make it usable on Node.

For Node and Bun with a shared directory format, see
[file session log](/docs/plugins/session-files-log/).

## Install and configure

```sh
npm install effect @xandreed/plugin-session-sqlite
```

```ts
import { sessionLogSqlitePlugin } from "@xandreed/plugin-session-sqlite"

const plugins = [
  {
    plugin: sessionLogSqlitePlugin,
    options: { path: ".efferent/runtime/sessions.db" },
  },
]
```

This fragment is an entry for `Agent.define`'s `plugins` array. Supply
`TurnAdmission` from your host or another plugin, then add
[sessions](/docs/plugins/sessions/). Complete the agent with the model,
conversation memory, registry and step loop required by your application.

## Storage behavior

Session heads and journal events share the database. Each commit verifies
the current incarnation and revision and checks its lease deadline under
the database write lock before storing the new state and events atomically.

Busy writes use bounded asynchronous retries around the synchronous SQLite
operation. Persistent contention becomes a typed store failure instead of
waiting indefinitely on the runtime thread. The database uses WAL and
`synchronous = NORMAL`: process-crash recovery is supported, while a power
loss may discard the latest commits.

A read from the end (`from: "end"`) walks a session's rows newest first
along the sequence and kind indexes and stops at its limit; the rows come
back in sequence order.

Opening accepts schema 3 at the stored format the database records in
`PRAGMA application_id` (none recorded, as the first schema-3 release wrote
it, is format 19), and initializes an empty unversioned database directly,
recording this release's format. Other versions, older or newer, other
formats and nonempty unversioned databases are refused with `store.version` before anything changes. Configure a fresh
store; there is no migration.
Published history stays in the existing database between process starts;
changing the path selects another store. Use the session APIs for removal
and a SQLite-consistent backup for an active database.

## What this entry leaves to the host

This plugin contributes no admission rule. The host's `TurnAdmission`
decides whether a requested turn may begin, and `Sessions` manages the open
turn, lease, inbox and fork boundaries. Conversation memory derives model
context from the journal; this backend does not index local documents.

Choose either this entry or the combined SQLite entry for a given graph.
If another plugin also provides `SessionLog`, select a provider explicitly
through a binding. The runtime scope owns the database connection and closes
it when the layer is released.

## Related guides

- [SQLite storage and open admission](/docs/plugins/session-sqlite/)
- [Sessions](/docs/plugins/sessions/)
- [File session log](/docs/plugins/session-files-log/)
- [Context, memory and the journal](/docs/concepts/context-journal/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-session-sqlite/log` · Version **0.21.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/SessionLog` |
| Requires | none |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "path": ".efferent/runtime/sessions.db"
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
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
