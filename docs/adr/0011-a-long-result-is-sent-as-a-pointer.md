# ADR 0011: A long result is sent as a pointer, by a rule that reads only the record

- **Status:** accepted, 14 November 2026
- **Applies to:** `@xandreed/core/kernel` (the tool result's record), `@xandreed/sdk/kernel` (the memory contract, `callTool`, the stock memories, the `readResult` tool)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A tool's result is conversation (ADR 0004): stored once, and sent in every later prompt. A tool
that answers with a page, a file or a table then costs its whole length in every request, and
one such result can be over a memory's budget by itself. Compaction (ADR 0008) helps only
later, and only by folding the turn away.

The journal can keep the result and the prompt carry less of it. Four things had to be
decided: who shortens it, when, what the model is told, and how it reads the rest.

Two facts shaped the answers. A provider caches a prompt by its start, so whatever is sent
for a record must be the same in every request that holds it. And a call's id is the
model's: a model that numbers its own calls starts again when its process does, so a journal
kept across restarts holds two calls under one id (the amendment to ADR 0004).

## Decision

- **The rule is a function of the record.** `pointed(options)` gives the function a memory
  reads each record's message with, where it called `messageOf`. A tool's result whose text
  is estimated over `overTokens` stays that call's result, failed or not; what it says
  becomes the first `previewTokens` of its text, framed as the tool's own, and one host note
  with the result's length and the call that reads on. It reads nothing but the record and
  its options, so a result is sent the same way in the turn that fetched it and in every
  later one. Nothing is stored by pointing.
- **A pointer names the record's place.** The note gives the result's `seq` in its journal,
  which is unique and never changes, not the call's id.
- **The model reads on with a tool the kernel ships.** `ReadResult`, with its handler
  `readResult`, returns a part of a stored result's text by place and character: up to
  2,000 characters a call whatever length is asked, never half a character, with where it
  ended and the result's length. It reads the journal of the turn it runs in (`CurrentTurn`). A host adds the tool
  and its handler where it lists its own; there is no registry. The pointer's text and the
  tool are one contract, under one name (`READ_RESULT`).
- **A tool says when its result must be sent whole.** The annotation `SentWhole` on a tool
  (`Tool.make(…).annotate(SentWhole, true)`) is read by `callTool` off the tool it runs and
  stored on the result as `whole`. `pointed` leaves such a result as stored. `ReadResult`
  carries it. `pointed` also leaves a page of `readResult` alone by the tool's name, so a
  loop that stores results by hand cannot point a page at itself, and it leaves a result the
  pointer would not make shorter.
- **Pointing comes before counting.** The stock memories with a budget take the rule as an
  option (`pointers`) and read each record through it before they estimate anything: the
  budget counts what is sent, and the summary memory's summarizer is handed what the model
  was. `flatMemory` sends everything, by definition; a flat memory that points is the flat
  memory with `pointed`'s function in place of `messageOf`.
- **Options that are none are refused where they are written.** `pointed` throws on a
  number that is not finite or under one token, and on a preview not shorter than the size,
  as `storedEvent` and `vocabularyOf` do for a definition. A stock memory given such options
  throws where its layer is made.
- **The memory kit holds a memory that says it points.** A subject that names its `pointers`
  gets four more checks: a long result is sent as `pointed` gives it and a short one as
  stored (`pointer`), one marked `whole` as stored (`pointer-whole`), the same way in its own
  turn and the next (`pointer-stable`), and, with a budget, a turn whose result alone is over
  the budget fits once pointed (`pointer-budget`).

## Rejected

- **A wrapper of `Memory` that rewrites the context** (ADR 0005's shape). The memory under
  it would count, drop and fold results it never sends, and a wrapper sees prompt messages,
  which carry no place and no `whole`.
- **A list of tool names in the memory's options** for the results to send whole. Two places
  to edit for one fact, and the rule would read configuration, which can change between two
  requests, where the record cannot.
- **A record written when a result is first pointed.** There is nothing to remember: the
  rule gives the same answer every time.
- **Pointing only the turns before the open one.** The model would see the whole result in
  the turn that fetched it, and the prompt's start would change once for every result, at
  the next turn. A host that prefers that trade writes the memory itself.
- **Keying the pointer by the call's id.** An id that repeats would read another result's
  text, silently.
- **A typed failure for bad options** on the stock memories' layers. Every host's stack type
  would name a failure most of them cannot have; a definition refused where it is written is
  the kernel's existing answer.

## Consequences

- The model sees only the start of a long result, also in the turn that fetched it, and pays
  a step to read on. Each page it reads is conversation, sent whole from then on.
- A host that sends pointers and does not offer `ReadResult` sends a note naming a tool the
  model does not have. Nothing checks that: the memory does not know the tools.
- The tool result's record gains an optional key, `whole`, written only when true. It was
  added before the journal's format 2 was released, so the format's number stands.
- `toolResult` takes it as an option; `callTool` sets it. A loop that stores results by hand
  passes it itself, or its whole results are pointed like any other, `readResult`'s aside.
- After a compaction folds the turn that held a result, its pointer is gone from the context
  with it. The result is still in the journal; the model no longer has its place.

## What would reopen this

- A second kernel tool whose pages must stay whole: the name rule would become a second
  special case, and the annotation alone should carry it.
- A provider whose cache is not by prefix, or a host for which the extra step costs more than
  the prompt's start changing once per result.
- Results that are not text (an image a tool returns): a preview by characters says nothing
  of them.
