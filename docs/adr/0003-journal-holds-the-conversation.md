# ADR 0003: The journal holds the conversation; records carry tags; memory builds the context; the kernel has no loop

- **Status:** accepted, 13 November 2026
- **Applies to:** `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and every plugin written for them
- **Supersedes:** in [ADR 0001](0001-kernel-plugin-composition.md), the stored request, the rule
  that memory sends every message-bearing record whichever plugin wrote it, and replacing
  the loop as a way to take part; in [ADR 0002](0002-core-owns-state-plugins-own-workflows.md),
  the loop contract (`Loop`, `Settings`, the request vocabulary, the conversation's events
  under `plugin.loop.`) and `LOOP_READER`. The rest of both records stands.
- **Skill:** `kernel-architecture` loads this record with 0001 and 0002 before an architectural change

## Context

The first cut of the kernel shipped a loop contract and a stock loop. The loop stored
four records a turn: the user's message, the request it sent (`plugin.loop.request.sent`:
the system text, pointers to the messages sent, the estimate, the budget), the answer,
and the turn's start and end from the session plugin. The system text was configuration,
`settings({ system })`, which the loop and memory read. Memory built a request of
pointers, and the loop resolved them.

Teaching the kernel showed three faults.

- **Two sources of truth.** The request record held a copy of the system text and a
  second account of what the journal already held. Change the system text and the stored
  requests describe a prompt no one will send again.
- **A loop no one writes.** A host's program is the loop: what a turn does is the
  program's decision. A stock loop hid the one function a reader most needs to see, and
  a contract for it named a workflow the kernel has no reason to own.
- **No way to tell what a record is for.** Memory read every record that bore a message.
  Once UI patches, side prompts or usage records reach the journal, that rule sends them
  to the model.

## Decision

**The journal holds the conversation, and nothing derived from configuration.** A turn
stores its start and end (the session plugin's), the user's message and the model's
answer, and a memory's own derived state, such as the window's cut. It never stores the
system text, a request, or pointers to what was sent. What a model was shown is rebuilt
from the journal, or watched where it is shown: at the model.

**The conversation's records are core's.** `conversation.user.message` and
`conversation.assistant.message`, with `userMessage(text)` and `assistantMessage(text,
meta?)`, are core's vocabulary under a `conversation.` prefix of their own, because
whoever runs a turn writes them and every memory reads them. The assistant message's data
is metadata the writer has: the model, and the usage the provider reported. Core's
`core.` records stay the session plugin's alone; a turn's body may write the
conversation's, by hand or through the two kernel functions that do it for a loop
(`modelAnswer`, `callTool`: ADR 0004, as amended).

**Records carry tags.** A definition declares what its events are for, and every event of
it carries the tags: `conversation`, `turn`, `memory`, `ui`, `trace`, and a plugin's own
as `<plugin>.<tag>`. `messageOf` reads a message only from a record tagged
`conversation`; `taggedWith` tells any record by its tags. Every stored record also
carries the turn it was stored in, stamped by the session plugin, so filtering and
rebuilding need no fold.

**Memory builds the context.** `Memory.context(session)` returns the messages that follow
the system text, ready for a prompt. It reads the conversation's records and its own,
through the conversation's vocabulary (`vocabularyOf(name, own, CONVERSATION_VOCABULARY)`); what it
stores of its own is tagged `memory` and is derived from the conversation, never a copy of
it. A budget is the memory's own option and covers the history. The stock memories are
`flatMemory`, everything, and `windowMemory`, whole turns dropped oldest first. (ADR 0008
adds `summaryMemory`, whose own record carries the summary it sends.)

**The kernel has no loop.** No loop contract, no stock loop and no `Settings`. A host's
program writes its turn over the contracts: `sessions.open(id)` opens a turn in a scope and
closes it with the scope's outcome; the program stores the message, asks memory for the
context, calls Effect AI's `LanguageModel` with the system text first, and stores the
answer. The inbox runs the host's turn function (`inbox(turn)`) for each message it takes.

## Consequences

- A change to the system text changes the next prompt, and nothing stored goes stale.
- A plugin that needs to observe a model call watches the model or the conversation's
  records; there is no request event to hook. The window's pressure is published by the
  window as it builds a context.
- The turn's five lines are in every host. The tools cut grows that turn into a loop over
  steps; when two hosts copy the same block, the block becomes a function of a contract,
  as ADR 0001's costs say.
- The journal's stored shape changed with this record: tags and the turn on the envelope,
  the conversation's records renamed, no request record. The kernel had not been released,
  so no store of the old shape exists to refuse.

## Considered and dropped

- **Storing the request with the system text referenced, not copied.** It keeps a second
  account of the conversation, and the reference goes stale when the text changes.
- **A stock loop as an answer key beside the host's own.** Two loops would drift, and the
  stock one would hide the function a reader learns from.
- **A tag for usage.** Usage is metadata with identifiers, not a purpose: it is the
  assistant message's data.

## What would reopen this

- A fact about a model call that must survive the process and cannot be rebuilt from the
  conversation's records or carried in the answer's metadata.
- Two hosts whose turns must share one implementation to stay correct, which a function of
  a contract cannot serve.
- A record that is for the conversation and for another use at once in a way two tags
  cannot express.

A change to this decision is a new record that supersedes this one; this one is not edited.
