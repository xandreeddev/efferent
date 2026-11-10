---
title: SQLite sessions
description: Store conversation journals in a SQLite database on Bun, with open turn admission.
pluginId: "@xandreed/plugin-session-sqlite"
---

`sessionSqlitePlugin` supplies `SessionLog` and `TurnAdmissionOpen` using one
SQLite database. Compose it with [sessions](/docs/plugins/sessions/) for
durable conversations, serialized turns, forks and queued input.

## When to use it

Use this backend for a Bun host that wants a local database file instead of
a directory of commit files. This package imports `bun:sqlite` and cannot
load on Node. For a Node host, use the
[file backend](/docs/plugins/session-files/) or your own `SessionLog` adapter.

Choose [SQLite log only](/docs/plugins/session-sqlite-log/) if your application
needs to supply an admission policy instead of accepting every turn.

## Install and configure

```sh
npm install effect @xandreed/plugin-session-sqlite @xandreed/plugin-sessions
```

```ts
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { sessionsPlugin } from "@xandreed/plugin-sessions"

const plugins = [
  {
    plugin: sessionSqlitePlugin,
    options: { path: ".efferent/runtime/sessions.db" },
  },
  sessionsPlugin,
]
```

Run this fragment on Bun and include these entries in `Agent.define`'s
`plugins` array. Complete the graph with conversation memory, a tool registry,
a step loop and a model supplied by your host. The path overrides the default;
the plugin creates its parent directory when needed.

## What is persisted

The database keeps session heads and ordered session-log events. The SDK
records conversation messages, tool results and request/lifecycle evidence
through that log; `Sessions` interprets ownership, inbox state and ancestry.
The backend does not ingest workspace files or choose the model's context.
See [context, memory and the journal](/docs/concepts/context-journal/).

## Transactions and recovery

A commit checks the incarnation, expected revision and lease deadline inside
one `IMMEDIATE` transaction. A competing writer receives a typed contention
failure or a bounded retry; SQLite's synchronous API is not configured to
block the runtime waiting on a busy connection.

The database uses WAL with `synchronous = NORMAL`. Committed transactions
survive a process crash; a power loss can lose recent commits. Opening accepts schema 3 and initializes an empty unversioned database directly. Other versions and nonempty unversioned databases are refused before schema changes. Configure a fresh store; there is no migration. Session removal also removes its stored events
and child sessions through foreign-key relationships.

## Composition and lifecycle

The combined plugin installs open admission. `sessionsPlugin` still owns
turn serialization and leases; SQLite does not replace that service.
Provide one selected storage backend and admission policy per graph, using
bindings if several plugins offer the same service.

Keep the database across restarts. When backing up an active WAL database,
use a SQLite-consistent backup rather than copying only the main file.
The runtime's scoped layer owns and closes its database connection.

## Related guides

- [SQLite log with custom admission](/docs/plugins/session-sqlite-log/)
- [File-backed sessions](/docs/plugins/session-files/)
- [Sessions and turn ownership](/docs/plugins/sessions/)
- [SDK and sessions](/docs/concepts/harness/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-session-sqlite` · Version **0.20.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/SessionLog`, `efferent/TurnAdmission` |
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
