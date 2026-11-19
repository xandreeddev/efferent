# ADR 0016: A branch is a copy, cut at a closed turn

- **Status:** accepted, 15 November 2026
- **Applies to:** `@xandreed/core` (`SessionHeader.branch`, `JournalStorage.fork`, `Sessions.fork`, both
  kits), the stock stores and the session plugin of `@xandreed/sdk`
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A person wants to go back to an earlier point of a conversation and continue from there another way, and keep
the conversation as it was: ask the same thing differently, or edit a message and send it again. Four things had
to be decided: what a branch is, where its records come from, where it may be cut, and what it carries with it.

The journal is the only state (ADR 0003), and every part reads a session's journal: memories, a tool that reads
its turn, the folds a client draws. A sub-agent is a session with a `parent` (ADR 0006), and a store is a part with
a kit (ADR 0010).

## Decision

- **A branch is a session whose journal starts as a copy of another's**, up to the end of a closed turn. After
  that it is a session like any other: turns open on it, `list` gives it by creation, a host recovers it.
- **The copy is the store's, in one step**: `JournalStorage.fork(header)` stores a new session whose events are
  the events of `header.branch.of` up to `header.branch.through`, each as it was stored (its place, turn, time
  and envelope). A store that fails part way leaves no session under the new id: the web storage journal writes
  the events first and the header last, and takes the events back if a write is refused. Every store implements
  it, and the storage kit holds every store to it (`fork`).
- **`Sessions.fork(id, { through? })`** cuts at the end of turn `through`, or of the last closed turn without it.
  A turn that is open, or never was, is refused (`SessionRefused`, `NoClosedTurn`), and so is a session with no
  closed turn, and a journal of another format (`FormatMismatch`). The cut is the place of that turn's first
  `core.session.turn.ended` (`cutOf`, a pure function). A turn open in the session is never copied: the session
  goes on with it, past the cut.
- **The header says where a branch was cut**: `branch: { of, through }`, the session and the place. `parent`
  keeps its one meaning, the session a sub-agent works for. A branch keeps the owner and the parent of the session
  it is cut from. The field is optional, so the journal format does not change: a reader that does not know it
  reads a branch as a session of its own, which it is, and the journals stored before it read as they did.
- **Nothing is announced.** The records a branch copies were heard when they were stored; announcing them again
  would count them twice (a meter of answers would). A fork claims nothing either: the session it reads is
  append-only, and the cut is at a turn already closed.
- **A branch carries everything stored before the cut**, because it is a copy: messages, tool results, a summary
  a memory kept, the skills loaded, an approval given for good (`grantsOf` reads it: a branch inherits an
  "Always", as the user decided), what the UI showed. Records that name the session they came from keep naming it:
  a helper's result names its child session, a fact names the conversation and turn it was learned in.
- **What is not branched**: the facts (ADR 0014) are in the memory session, which every conversation shares; a
  branch reads the same facts. A workspace of files, when there is one, is not branched either.
- **Every part reads a branch as it read the session at the cut.** `branches.test.ts` holds it for the three
  stock memories (the context of the branch's next turn is the one the session's next turn got), for a summary
  stored before the cut (the branch starts with it, and the summarizer is not asked again), for an approval given
  for good (the branch's tool acts with nobody asked) and for `readResult` (a long result read on by the place it
  had).

## Rejected

- **A branch made by `Sessions` alone**, by creating a session and appending a copy of each record. No contract
  change, but not one step (a failure part way leaves half a branch), and each record copied is stamped with the
  time of the copy, not the time it was said.
- **A branch as a view** of the other session's journal up to the cut, with no copy. Nothing is duplicated, but
  every store and every reader would have to join two journals, and a session's journal would no longer be one
  list in one place.
- **Reusing `parent`.** A sub-agent's parent is not a prefix of it, and a client tells a helper by its parent
  (lesson 4): a branch would be drawn as a helper.
- **A new journal format.** Nothing a reader of the present format reads is wrong in a branch's header.
- **Cutting inside a turn.** A turn's records hold together (a call and its result, the turn's end); a cut inside
  one would copy an open turn, which no writer would ever close.
