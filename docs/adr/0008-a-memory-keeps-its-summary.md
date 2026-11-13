# ADR 0008: A memory keeps what it derived as a record of its own, and asks the host for a model's work

- **Status:** accepted, 14 November 2026
- **Applies to:** `@xandreed/sdk/kernel`, every memory that keeps state, and every host that provides a `Summarizer`
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A conversation outgrows the model. The window memory drops old turns and forgets them. A
summary memory keeps them in short, which raises three questions the earlier records left
open:

- **Where the summary lives.** Rebuilt for every context, it would cost a model call per
  turn and change from turn to turn, so the cached prefix would never hold. Kept in the
  memory's process, it would be lost on a reload and differ between two plugins over one
  store.
- **How it reaches the model.** ADR 0003 sends the conversation's records, through
  `messageOf`; a summary is not the conversation, and must not be read as a turn of it by
  another memory.
- **Who calls the model.** No kernel plugin calls a model or runs a tool (ADR 0004): the
  host's program does.

## Decision

- **Stored once, as the memory's own record.** The summary memory appends
  `plugin.summary.summarized`, tagged `memory`, when it compacts: the summary is the
  record's message, and its data holds the place of the last message it replaces
  (`through`). Every later context starts with that message, then every message of the
  conversation after `through`, so the prefix changes only at a compaction.
- **A memory's own record may carry the text it sends.** `messageOf` still reads a message
  only from a record tagged `conversation`, so no other memory sends the summary; the
  memory that wrote it reads its own record's message. The text is framed: a host note
  that says the summary is data, then the summary inside `<conversation-summary>`, which a
  copy of the tag inside it cannot close.
- **The host provides the model's work.** The memory asks a `Summarizer` contract
  (`summarize({ earlier, messages })`), which the host provides over the model it picked
  or any other. The memory's type says it needs one.
- **One summary per context.** A context asks for one summary at most. If the context is
  still over the budget after it, or folding every closed turn could not make it fit, it
  fails with `OverBudget`, the memory contract's error, shared with every memory that has a
  budget.

## Consequences

- A reload, or a second plugin over the same store, starts from the same summary, and the
  summary is paid for once per compaction, not per turn.
- The summary memory reads a record of its own that may not be skipped: a reader that does
  not know `plugin.summary.summarized` is not its concern, and a later summary memory that
  changes the record's shape bumps the journal format.
- The page, a client or a test can tell the summarizer's model call from the turn's only
  by the `Summarizer` it provides: the memory does not say.

## What would reopen this

- A memory that must call a model in the background, outside any turn's context call.
- Summaries a client must edit, which would make the summary the conversation's and not
  the memory's.
