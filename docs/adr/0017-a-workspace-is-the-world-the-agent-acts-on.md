# ADR 0017: A workspace is the world an agent acts on, not a store of the agent

- **Status:** accepted, 16 November 2026
- **Applies to:** `@xandreed/sdk` (the `Files` contract, its kit, `inMemoryFiles`, the file tools)
- **Amends:** skill `kernel-architecture`'s "Do not add" list; notes on ADR 0003 and ADR 0012
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

An agent that edits code, notes or a document works on files. Read literally, a file system next to the kernel is
"a store beside the journal", which the kernel's skill forbids: the journal is the only state (ADR 0003). Before a
`Files` contract existed, the line had to be drawn so that it can be checked, or the next store beside the journal
would cite this record.

Who may change a file was the second question. Lesson 9's `Approval` lets a tool ask before it acts (ADR 0012).
An app may want no asking at all (a sandbox), a person asked for each file, or a model that answers first and asks
the person only when it is unsure: a choice of the app's, not of the tools.

## Decision

- **The line, as three conditions a workspace meets and a store beside the journal does not:**
  1. **No part that builds the agent's state or a prompt holds `Files`**: no memory, memory wrapper, fold or the
     session plugin. Among the agent's parts only a tool's handler does; the app's own view of the world (a file
     pane, a person's editor) may read it, since it builds neither. `type-level:` tests hold that no stock layer
     requires `Files`, and a test of the kernel's sources that no part outside the files contract and its tools
     imports it.
  2. **The journal's folds do not read a file**: the agent's state, its context, its facts and grants are what
     they are whatever the workspace holds. It follows from the first; a test also holds that the context a memory
     builds is the same with the workspace changed.
  3. **Nothing reaches a prompt from a file except through a stored result**: what the agent knows of a file is
     what a tool call returned, a `conversation.tool.result` in the journal. A file changed after it was read is
     still sent as it was read.

  The skill's "Do not add" now reads *a store beside the journal: state the agent's parts read to rebuild
  themselves. A world the agent acts on through a contract that only tools hold (ADR 0017) is not one.*
- **A workspace is reached through a contract, `Files`**, which the host provides: a page in memory or in the
  browser's storage, a test in memory, a command line on the disk (the kernel ships no disk: it imports no `node:`).
  Calls: `read(path)`, `list(folder)`, `write(path, text, expected?)`. A write given what it expects (no file, or
  this text) fails with `FileChanged` when the file holds something else, writing nothing: two writers (a person
  and the agent, or two tasks) are held apart by this, not by a lock. A folder lists every file in it and in its
  folders, by code unit, never a name that only starts like it. It has a kit, `filesConformance`.
- **A path is a `FilePath`**: relative, names joined by `/`, none empty, `.` or `..`, with no `\`, `:` or control
  character, at most 160 characters, so an app's approval key of a path (an action is at most 200) has room. A model's path becomes one through `workspacePath`, which refuses one that
  would leave the workspace, as the call's failed result.
- **The kernel's tools**: `readFile`, `listFiles`, `writeFile`, `editFile`. A program provides `Files` alone
  (`readFile` and `listFiles` declare `Files`; `writeFile` and `editFile` also `CurrentTurn`, to say a write
  happened, which `callTool` provides). A program that leaves `Files` out does not compile (ADR 0007's
  `ToolNeeds`).
- **What the journal holds of files is bounded.** `readFile` returns a page of at most 4,000 characters with where
  the next starts, sent whole (`SentWhole`). A write's text is in its call, which `pointed` does not shorten and
  every later prompt sends: a write of more than 4,000 characters is refused (its call is stored all the same, so
  the limit bounds what a model that follows it stores), and a longer file is written in parts (`append`). `listFiles` lists at most 200 paths and says how many it left out.
- **An edit is a compare and set.** Its text to find must be in the file exactly once; the write expects the text
  the edit read. A text not there, there twice, or a file changed between the read and the write fails as the
  call's result, with no write.
- **Permission is the app's, not the tools'.** The kernel's file tools never ask. Whether and how a write is
  allowed is decided by the app that composes the agent, with the parts it already has:
  - **a sandbox**: a `Files` the app can afford to let the agent change freely, and no asking at all;
  - **a `Files` that declines**: a wrapper of the app's (a higher-order plugin, as `autoApprove` wraps `Approval`)
    that refuses some reads or writes by a rule, with `FilesRefused { reason }`, which the tool hands the model as
    its failed result;
  - **asking a person**: the app's loop asks before it runs a call that writes, `approveIn(session, request)`
    (ADR 0012), with a key the app chooses (per file, per folder, one for all), so the answer is a record and an
    answer for good stands. A `Files` wrapper cannot ask: its calls run with no turn in their type, and an
    approval is stored in a turn;
  - **a model first, a person when it is unsure**: an `Approval` of the app's over the person's that answers
    `Allowed` for what its judge finds safe and passes the rest on.

  Each is a layer the app wraps around the plugin. The kernel ships none of them as the default; the docs and the
  lesson show each as the app's code.
- **A write is said live**, `plugin.files.written` (tagged `trace`, about its turn, stored nowhere): the call and
  its result are the record. A file pane learns of a change from it and reads `Files` again; it draws the world,
  not the agent (ADR 0009 is about what the agent shows).
- **The difference from facts (ADR 0014).** A notes file the agent writes and reads again is its own memory kept
  where the kernel cannot see it: the kernel never sends a file, so it is read only when the model asks. A host
  that wants knowledge carried across conversations uses facts. A workspace used as memory is the host's choice
  and its risk.

## Consequences

- A reload keeps the files only if the host's `Files` is durable.
- **An interrupted write can leave a changed file and no record**: `callTool` stores the result after the handler
  returns, so Stop, a reload or a crash between the two loses the result, and `paired` then drops the call from
  every later prompt (a test holds it). Accepted: the next read shows the file as it is. A record of intent stored
  before the write was rejected: one more record kind, for a window the next read closes.
- A branch shares the workspace: files are not branched. A branch's journal may say a file held text it no longer
  holds; the agent reads it again.
- Nothing replays a write: a journal read again (a reload, a branch) changes no file.
- `FilesUnavailable`, the medium's own failure, is a defect of the call, as a store's failure is in the facts
  tools: `callTool` stores it as a failed result.

## Rejected

- **Files in the journal** (each write a record, the workspace a fold): every version of every file kept, and a
  change made outside the agent missing from it.
- **Files pasted into the prompt**: every prompt pays for every file, and the cached prefix changes with any.
- **A snapshot of the workspace per turn or per branch.**
- **File tools that ask** (`approve` inside `writeFile` and `editFile`, a key per path): permission would be the
  kernel's policy, and an app that runs in a sandbox, or lets a model decide first, would have to work around it.
- **A `Files` wrapper that asks a person**: it would read the turn from the context its calls run in, which their
  type does not say, or ask without storing the answer, so an answer for good would not stand.

## What would reopen this

- A branch that needs files of its own.
- A part other than a tool, among those that build the agent's state or a prompt, that must read a file.
- A medium whose writes cannot compare and set: the contract would need another way to keep two writers apart.

A change to this decision is a new record that supersedes this one; this one is not edited.
