# @xandreed/plugin-session-sqlite

Core's `SessionLog` port in one SQLite file (`session_heads` and `session_log_events`), and a plugin that pairs it with the open `TurnAdmission`; hosts compose `sessionsPlugin` (plugin-sessions) on top. Bun only: it imports `bun:sqlite` and declares no Node engine, so `verify:packages` never imports it on Node. Layer `plugin-session-sqlite` in `foundry.config.ts` (imports core, `node:` and `bun:sqlite`, the one Bun module a source layer may import); its tests' layer `plugin-session-sqlite-tests` also imports plugin-sessions.

## Rules

- Keep Bun-only imports in this package: every other published package must load on Node.
- Both plugins default `path` to `.efferent/runtime/sessions.db`; the directory is created and the file set to mode `0600`.
- A commit is one `IMMEDIATE` transaction: read the caller's `Clock` under the write lock, then check the revision and `notAfter`, then write; never read the time before the lock.
- Map a SQLite failure in one place (`failure`): `SQLITE_BUSY*` (read with core's `errorCodeOf`) is `store.busy` (`isStoreBusy`), anything else the operation's code (`store.open`, `store.io`), SQLite's error kept as the `cause`, never as text; decode every row read (`decodeRow`), a bad one failing with `store.decode`, never a defect.
- Never let SQLite wait on the thread (bun:sqlite is synchronous): `busy_timeout` stays 0 and a call held off by another connection's lock is retried by `busyRetry` (2 ms doubling to 100 ms, jittered) for up to `BUSY_WAIT` (5 s), then fails with `store.busy`; that wait also covers switching a new file to WAL.
- Keep WAL with `synchronous = NORMAL`: a commit survives a crash of the process; a power loss may drop the last commits, never tear one.
- Removal cascades through foreign keys (`foreign_keys = ON`): a session's events and child sessions go with its head.
- The file's schema version is SQLite's `user_version`; `MIGRATIONS` is the schema in order, entry n taking a file from version n to n + 1. A shipped entry never changes (`SCHEMA_V1` is the tables 0.14.0 created, `IF NOT EXISTS`, which a file without a version holds): a change to the tables adds an entry. `migrateSessionDatabase` runs the missing entries, then stamps the version, inside the open's `IMMEDIATE` transaction, never outside it; a file at a later version (a newer release's) fails with `store.version`, neither read nor written.
- Change behaviour by adding the check to core's `sessionLogConformance` or `sessionLogRecoveryConformance` first.
- Each `SessionLog` call is an `Effect.fn` span, `session_log.<create|head|list|read|commit|remove>`, carrying `efferent.session.id` when the call names a session (`onSession`); opening the file is `session_log.open`. `makeSessionLogSqlite` is `Effect.fnUntraced` (it runs when the layer is built), and the per-call helpers (`operation`, `decodeRow`) open no span.

## Public surface

- `sessionSqlitePlugin` (also the default export): the log plus `TurnAdmissionOpen`; `sessionLogSqlitePlugin`: the log alone, for hosts with their own admission.
- `makeSessionLogSqlite(path)` (scoped `SessionLog` service) and `SessionLogSqliteLive(path)` (its layer).

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests, the scripts and the docs import the plugins, `makeSessionLogSqlite` and `SessionLogSqliteLive`, and the default export is tagged `@public` (`src/index.ts`).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `sessionSqlitePlugin` | `@xandreed/plugin-session-sqlite` | runtime | `efferent/SessionLog`, `efferent/TurnAdmission` | none | none |
| `sessionLogSqlitePlugin` | `@xandreed/plugin-session-sqlite/log` | runtime | `efferent/SessionLog` | none | none |

## Model-facing text

None.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | `sessionSqlitePlugin` and the public exports |
| `src/session-log.adapter.ts` | `openSessionDatabase` (the pragmas), the schema (`MIGRATIONS`, `migrateSessionDatabase`), row decoding, the busy retry, `makeSessionLogSqlite`, `SessionLogSqliteLive`, `sessionLogSqlitePlugin` |
| `src/session-holder.testing.ts` | a child process that holds the lock, commits or holds a turn, for the crash tests (left out of the build) |

## Tests

- `src/session-log.adapter.test.ts`: core's `sessionLogConformance`, and `sessionLogRecoveryConformance` with `callerClock: true`, over a temporary file; the pragmas (`:31`), a damaged row failing with `store.decode` (`:41`); the schema version (`:99`): a file 0.14.0 wrote, without a version, built from the sdk's `journal-0.14.0.json`, opening with every event and a new file's tables, a newer release's file refused with `store.version` and left byte for byte, an added migration run once, a failed one leaving the version and tables; and the `session_log.*` spans under the caller's, with the session's id (`:192`).
- `src/sessions.conformance.test.ts`: core's `sessionsConformance` over `SessionsLive` instances sharing one SQLite file, as several servers over one store.
- `src/session-recovery.test.ts`: crash recovery against real processes (`session-holder.testing.ts`, stopped with SIGKILL): concurrent opens, a commit waiting past its `notAfter`, a wait that never blocks the thread, `store.busy`, a process killed mid-commit, compare-and-swap races, reaping a dead holder's turn (one killed after it held its reply for its end stores no reply).
- `packages/sdk/src/agent.backends.test.ts`: the model sees the same requests over the memory and SQLite logs; `verify:packages` (on Bun) runs sessions with a background task and the recovery kit over the packed package.
- Run: `bun test packages/plugin-session-sqlite packages/sdk/src/agent.backends.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
