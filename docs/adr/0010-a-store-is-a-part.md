# ADR 0010: A store is a part; a turn left open is closed by the host that knows its writer is gone

- **Status:** accepted, 14 November 2026
- **Applies to:** `@xandreed/core/kernel` (`JournalStorage`, `Sessions`), `@xandreed/sdk/kernel` (the session plugin, the stores)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

Until now the kernel kept journals in the process. A journal that outlives its process raises
four questions the in-process store never had to answer:

- **How a host finds a conversation again.** An id held by the host is gone with the process.
- **What becomes of a turn its writer left open.** A page that is reloaded, or a process that
  dies, stores `core.session.turn.started` and never the end. The journal then says a turn is
  open, and every later turn is refused as busy.
- **Who may close it.** The journal cannot tell a writer that is slow from one that is gone.
- **What a store must promise** beyond what the in-process one showed: that a second handle
  reads what the first wrote, and what it says of a value it cannot read.

## Decision

- **A store is the `JournalStorage` contract and its kit, and nothing else.** `create`,
  `append`, `read`, `list`. A store with a medium beside its handle gives the kit two handles
  on one medium (`pair`), and the kit checks that the second reads, lists and appends after
  what the first wrote (`reopens`).
- **A host finds its sessions in the store.** `list` gives every header in the order of
  `byCreation`: the header's `createdAt`, then its id. The order is a function of the stored
  headers alone, so a store keeps no index and neither does a host. Two sessions created in
  one millisecond are ordered by id, not by which call came first.
- **The header says when the session was created.** The session plugin stamps `createdAt`
  from the clock; a store keeps the header as it was given. This and the outcome below make
  journal format 2. No store outlived a process at format 1, so nothing is migrated.
- **`Sessions.recover(id)` closes a turn whose writer is gone, and the host calls it.** It
  stores `core.session.turn.ended` with the outcome `Abandoned`, announces it, and gives the
  turn it closed; a free session is left as it is, so a host calls it without looking first.
  The kernel never calls it: only the host knows that the store has one writer and that it
  has just started (one process over a file, one tab holding a lock).
- **One writer per store is assumed, not enforced, and the journal stays whole when the host
  was wrong.** A writer whose turn was closed under it reads the journal at its next write,
  is refused (`NoOpenTurn`), and stores no end of its own: its close takes the end the journal
  holds. A turn the calling process holds is refused to `recover` (`SessionBusy`).
- **A stored value that is not a journal's is `Unreadable`,** apart from `Unavailable`, which
  says the store may answer later. `list` fails on one too: a journal passed over silently is
  a conversation lost without a word.
- **A parent is not checked to exist,** by a store or by the session plugin: a header is an
  envelope to the store, and a parent may live in another store.
- **`webStorageJournal(storage, { prefix })` is the first such store.** It is handed the
  storage as a value with five members, so it names no browser type; one key per header and
  one per event, so an append writes one key.

## Consequences

- A turn `recover` closed keeps what it stored. A memory sends of it what it sends of any
  turn; a tool call with no result is not sent (`paired`).
- A listener in the recovering process hears the end of a turn whose start it never heard.
- The sessions kit is handed the store its plugin runs on (`{ sessions, storage }`), since
  three of its checks write what another writer would have left there. A session plugin that
  hides its store cannot run the kit.
- `SessionBusy` from a journal that holds a turn open names `Sessions.recover` in its message.
- A host that calls `recover` while another writer lives closes that writer's turn. The
  journal stays readable; the other writer's work in that turn after the close is refused.

## What would reopen this

- A store with several writers by design (a server with many processes): a lease or a writer
  id in the journal would then say whose turn it is, and `recover` would check it.
- A host that needs sessions in the order its calls created them, within one millisecond.
- A store whose `list` is too large to give whole: paging, or a filter by owner.
