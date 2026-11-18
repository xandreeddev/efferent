# ADR 0024: The kernel's Node ports live on an entry of their own; a durable store has one writer, and the host recovers what the last one left open

- **Status:** accepted, 18 November 2026
- **Applies to:** `@xandreed/sdk/kernel/node` (new: `directoryJournal`, `sqliteJournal`, `JournalOpenFailed`),
  `@xandreed/sdk/kernel` (`recoverTurns`, `RecoveredTurn`)
- **Amends:** ADR 0010 (one writer per store is enforced by the durable stores, not only assumed; the host's
  recovery is one call over the whole store)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine (`packages/runtime`, `process-host`, the `plugin-*` packages) is to be removed before the next
release, and the kernel must keep what apps need from it: journals on disk and in SQLite, files on disk, model
providers, a shell, workspace search, media, telemetry, remote embeddings, Postgres. Until now the kernel kept
journals in the process (`inProcessJournal`) or in a browser's storage (`webStorageJournal`), and its browser
entry imports no runtime module, which `browser-bundle.test.ts` proves. A port that needs `node:fs` or a SQLite
driver needs a place that is not that entry.

A turn its writer left open stays open until a host calls `Sessions.recover` (ADR 0010), which assumed one writer
per store and left it to the host to know it. A host over a store on a disk cannot know it without a lock: a
process killed inside a turn leaves that session busy for good, the sessions plugins keep (facts, a graph,
knowledge) included.

## Decision

### The entry

- **`@xandreed/sdk/kernel/node` (`packages/sdk/src/kernel/node/index.ts`) holds the ports that need a runtime's
  modules.** "Node" names the modules they import (`node:fs`, `node:path`, `node:os`, `node:crypto`), which Node 24
  and Bun both provide: the entry loads on both, and is checked on both from the packed packages
  (`scripts/kernel-consumer.fixture.mjs`). It is a subpath of the sdk, not a new package: the maintainer chose sdk
  subpath entries, so a host adds no dependency and one version covers the kernel and its ports.
- **No `/bun` entry.** `sqliteJournal` loads its driver when its layer is built: `bun:sqlite` on Bun, `node:sqlite`
  on Node (usable without a flag on Node 24). A static `bun:sqlite` import in any entry would stop that entry
  loading on Node, which `verify:packages` checks for every entry of a package that declares Node. So one entry
  serves both, and the SQLite journal is one adapter over the two drivers, which differ only in how a statement is
  prepared (`query` against `prepare`).
- **Layers.** Each folder under `node/` is a layer of its own in `foundry.config.ts`, before `sdk-kernel`:
  `sdk-kernel-node-writer` (the one-writer lock, shared by the stores), `sdk-kernel-node-journal-directory`,
  `sdk-kernel-node-journal-sqlite` (the only layer that names `bun:sqlite`), and `sdk-kernel-node`, the entry.
  A port's folder imports core's kernel and the lock, never another port's folder. None is in `sdk-kernel`'s
  `canImport`, so the browser entry cannot import one; `browser-bundle.test.ts` also builds that entry for a
  browser and finds no module of `node/` in its graph, with a control that does. `./kernel/node` is a
  `restricted` subpath of the sdk, as `./kernel` is: no other layer of the sdk may import it.
- **How a later port joins.** A folder under `node/` (`node/bash/`, `node/search/`), its layer before
  `sdk-kernel-node` with the externals it imports, its name in the entry's `canImport` and in `SDK_KERNEL_TESTS`,
  its exports in `node/index.ts`, and its kit, if it has one, run over it in its folder's tests and in the packed
  fixture on Node and on Bun. A port that is no store does not use the lock.
- **The name once the kernel moves to the package roots.** When the old engine is removed and
  `@xandreed/sdk/kernel` becomes `@xandreed/sdk`, this entry becomes `@xandreed/sdk/node`. That is decided here, so
  the move renames it once and decides nothing.

### The directory journal (`directoryJournal({ directory })`)

- **One file per session**, `sessions/<name>.jsonl`: the header on the first line, an event on each line after it,
  each line its CRC-32, a space and its JSON. A session's file name is its id when the id is lower-case letters,
  digits and hyphens (a UUID), else `~` and the id's bytes in hexadecimal, so no id is read as a path or folds
  into another by case.
- **Durable when it returns.** An append writes its line and calls `datasync` before it returns. A session and a
  branch are written whole in `tmp/`, synced, published by an exclusive hard link (a name taken is
  `SessionExists`), and the folder is synced after. A half-made session never exists; what a crash leaves in
  `tmp/` is removed by the next process that holds the store. The file system must have hard links.
- **A crash in the middle of an append leaves a torn tail**, bytes after the last line break. A read leaves them
  out; the next append cuts them (logged) before it writes, holding the store. A whole line whose CRC-32 does not
  match, or whose event breaks the numbering from 1, is `Unreadable`: the store refuses the session at that line
  and never reads past it, nor repairs it.
- **Its format is recorded and refused when unknown**, as the old engine's stores do: `store.json` names the store
  (`DIRECTORY_STORE`) and its layout (`DIRECTORY_LAYOUT`, 1). Another layout or store is `Format`; so is a
  directory that holds other files and no marker. Nothing is migrated or written there. The journal format of
  each session stays the header's (`JOURNAL_FORMAT`), which the session plugin checks (`currentFormat`).
- **A write is one at a time in the process and runs to its end once begun** (`Effect.uninterruptible`), so an
  interrupted caller never leaves a write half done for the next; the session plugin reads the place again after
  an interrupted append. An append knows where a file ends from its own last write while the file's size and
  change time are as that write left them; otherwise it reads the file again. That check is not a promise to see a
  file changed under the writer (a file system's clock can be coarser than two writes): only the writer writes.
- **Not ported from the old engine:** a bound on each file system call (its admission slots and stall deadline,
  for a network mount that stops answering). A call here waits for the file system as long as it takes. That
  returns with a store on a network mount.

### The SQLite journal (`sqliteJournal({ path })`)

- **Durable when it returns.** WAL with `synchronous = FULL` (the old engine's `NORMAL` can lose the last commits
  in a power loss). An append is one `BEGIN IMMEDIATE` transaction that checks the place and inserts the event; a
  session and a branch are one transaction each. A crash in the middle of a transaction leaves the database as it
  was before it: the test kills a process holding an uncommitted insert.
- **Its format is recorded and refused when unknown:** `PRAGMA user_version` is the schema (`SQLITE_SCHEMA`, 1),
  `PRAGMA application_id` says it is a journal database (`SQLITE_APPLICATION_ID`, `EfKJ`). Another schema,
  another application's tables and a file that is no database are `Format`, left as they were.

### One writer per store

- **The writer of a store is a process, and the store's layer takes it as it is built.** Both journals use one
  lock, a folder of holder files (`<directory>/writer/`, `<path>.writer/`): the file with the highest number
  (`<n>.json`: the process id, the machine's host name, a token and the time) names the holder. A process takes
  the store by publishing the next number by an exclusive hard link of a file written whole, so of two processes
  that found the same holder gone exactly one publishes; it then lists again and gives way to a higher number, one
  published from an older listing. The layer fails with `JournalOpenFailed` (`Held`) while the holder is a running
  process of this machine, a process of another machine (whose processes this one cannot see), or a file that
  names no holder; it takes the store over from a holder of this machine whose process is gone (`kill(pid, 0)`
  answers `ESRCH`), and from one that names this process's id, which a process before this one had. It lets the
  store go, its holder file removed, when the layer's scope closes. A process id used again by another running
  process keeps the store held: the refusal names the file to remove.
- **SQLite's own locks are not that writer.** They order writes one transaction at a time: a process holding
  `BEGIN IMMEDIATE` with an insert refused another's write (`SQLITE_BUSY`), on Bun 1.3.0 and Node 24.16, each
  runtime as either side (checked twice each way on a local disk). They do not say who the store's writer is
  between transactions, and a directory of files has no such lock at all. One writer per store is a rule about
  processes, kept by the store's own lock file on both stores. (A first trial, while this record was written,
  saw a `bun:sqlite` transaction fail to stop another process's write; a later check with a busy timeout of 0
  did not reproduce it.)
- **Two handles of one process share the hold.** They take one lane for their writes, and the lock is released
  when the last closes. That is what the storage kit's `reopens` asks of a store whose journals outlive its handle
  (a second live handle that appends after the first), and what a host that builds the stack twice gets.
- **Several writers per store** (claims that expire, a lease renewed by a live writer) is later work. It is what a
  store shared by several machines or by processes that come and go needs; until then a holder on another machine
  is never taken over, and a host whose machine's name changes between runs (a container made again) removes the
  file the refusal names.

### Recovery

- **Every turn a store holds open when a process takes it was a dead writer's.** No other process can have opened
  it, and this one has opened none yet. So the step runs once per process, by the code that opened the store,
  before any turn: two stacks of one process share the hold, and one that ran it while the other had a turn open
  would close that live turn, since a `Sessions` knows only its own turns. `recoverTurns` (`@xandreed/sdk/kernel`, the session plugin's folder) is
  the host's recovery step: it lists the store and calls `Sessions.recover` on every session it reads, which stores
  `core.session.turn.ended` with the outcome `Abandoned` for a turn left open; it passes over a session of another
  journal format, and gives the turns it closed (`RecoveredTurn`). The journal records the outcome; nothing else
  is stored.
- **The host calls it, once, after the store's layer is built and before any turn** (ADR 0010 stands: the kernel
  never recovers). It needs only `Sessions`, so it is in the browser entry: a page that holds a store over
  `localStorage` by a lock of its own calls it too.

## Consequences

- A host on Node or Bun runs a kernel agent over a directory or a SQLite file without the old engine's packages,
  and a process killed inside a turn costs that turn, not the session.
- A second process on a store is refused as it opens, not at its first write. Reading a store another process
  holds (an inspector beside a running agent) is not possible yet.
- `JournalOpenFailed` is the Node entry's own error, in the layer's error type: a store that cannot open builds no
  stack, and `JournalStorageError` is unchanged (`api/core--kernel.api.txt` does not move).
- A holder whose process is a zombie, or whose id another running process now has, counts as alive: the store stays
  held, and the refusal names the file to remove.
- A holder that names this process's own id on this machine is taken over. Two containers that share the store's
  volume, the same host name and the same process id (1, for each) would both take it: give each its own volume,
  or its own host name.
- One session `recoverTurns` cannot read (`Unreadable`) fails the whole step, and no turn after it in the listing is
  closed: a host repairs or removes that session first.
- Listing reads each session file's first line; `recoverTurns` reads every journal of the store once. A store of
  many long journals makes a slow start: an index of open turns would be the store's, and is not kept.

## What would reopen this

- Several processes writing one store: claims that expire replace the holder file, and `recover` checks the claim.
- A store on a network mount: bounded file system calls return, and with them a lock that does not rest on
  process ids.
- A Bun release whose SQLite driver holds its locks across processes does not change the lock: one lock for both
  stores is simpler than two.
