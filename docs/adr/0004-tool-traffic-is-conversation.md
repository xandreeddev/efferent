# ADR 0004: Tool traffic is conversation; tools are code; failures are data; memory keeps calls paired

- **Status:** accepted, 13 November 2026
- **Applies to:** `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and every memory written for them
- **Builds on:** [ADR 0003](0003-journal-holds-the-conversation.md), whose rules stand: the journal holds the
  conversation and nothing derived from configuration, records carry tags, memory builds the context, the kernel
  has no loop
- **Skill:** `kernel-architecture` loads this record with 0001, 0002 and 0003 before an architectural change

## Context

The first cut of the kernel left tools out. An assistant message could name tool calls, but nothing stored what a
call came to, nothing sent a call or a result to a model, and no memory knew that a call needs its result. A turn
that uses tools is a loop over steps: the model asks for tools, the turn runs them, and the model is asked again
with the results. Three questions follow: where the tools live, what is stored, and what a memory may send.

## Decision

**The tools are Effect AI's `Toolkit`, and the kernel adds no tool service.** A host declares its tools with
`Tool.make` and `Toolkit.make`, gives their handlers with `toolkit.toLayer`, and its turn offers the toolkit to
`LanguageModel.streamText` with `disableToolCallResolution: true` and `toolCallValidation: "deferred"`, then runs
each call through `toolkit.handle`. The model is Effect AI's `LanguageModel` and the turn calls it directly; the
tools are the same kind of module, called the same way. A kernel contract for tools would wrap one that exists.

**Tool definitions are code.** A tool's name, description and schema are offered in every call and never stored,
like the system text: changing them changes the next prompt and leaves nothing stored stale.

**Tool traffic is conversation.** The model's answer is stored with the calls it made (`assistantMessage(text, {
toolCalls })`, from the stream's `tool-call` parts as they came), and each call's outcome as
`conversation.tool.result` (`toolResult(call, result, isFailure)`), a new `Message` variant, `ToolResult`. Both are
tagged `conversation` and read through `CONVERSATION_READER`. `promptMessage` sends a call as a part of the model's
message and a result as a tool message that answers it.

**Failures are data.** A tool's failure (`failureMode: "return"`), an unknown tool and parameters that do not decode
are stored as a result with `isFailure`, and the turn goes on: the model reads the failure as the answer to its
call. The text of a failure is Effect AI's toolkit's or the tool's, not the kernel's.

**Memory keeps calls paired.** A provider refuses a call no result answers, and a result whose call it was not sent.
A turn stopped while a tool ran leaves such a call in the journal, and a memory that cuts the conversation can split
a pair. Every memory sends its messages through `paired`: a call only with its result, a result only with its call,
and an answer left with neither text nor a call not at all. The journal keeps every record. The memory kit checks
it (`pairs`).

## Consequences

- A host's turn grows from one model call to a loop, written in its own program; the kernel ships the records,
  `toolResult`, `paired` and a scripted model that can ask for tools (`ModelAnswer` `Calls`), and no loop.
- A step limit is the host's: what a turn says when it reaches it is the program's own words, and is not stored.
- Messages that arrive while a turn runs may be taken into it between steps, so a long run can be steered. That is
  the host's choice too.
- The window memory drops whole turns only. One long tool turn can therefore go over its budget, and fails with
  `OverBudget` like any turn that alone does not fit. A memory that cuts inside a turn must keep pairs whole.
- The estimate counts tool traffic: a call's name and parameters, a result's JSON (`messageText`).

## Considered and dropped

- **A `Tools` service and kit in the kernel, with an `addTools` helper.** It would put a second name on Effect AI's
  toolkit and hide the one step a reader most needs to see: running a call and storing what it came to.
- **Letting Effect AI resolve calls inside `streamText`.** The turn would not see a call before it ran, could not
  store calls and results in order, and a bad call would fail the stream and the turn.
- **Repairing an unanswered call by storing a made-up result.** The journal would hold a result no tool returned.
  Pairing is a rule of what is sent, so it lives in memory.

## What would reopen this

A tool that must run outside the turn (approved by a person, or run by the provider) and whose result arrives in a
later turn: pairing across turns, and a record for a call that is waiting.
