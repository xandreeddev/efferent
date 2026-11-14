---
name: kernel-architecture
description: How the efferent kernel's parts compose — what core owns and what a plugin's contract owns, where a contract and a plugin live, and how plugins extend each other (replace, wrap with a higher-order plugin, react to an event, record a fact in the journal; no hooks, registries, priorities or config wiring). Read before adding or changing a kernel contract, a stock kernel plugin, memory or a host's turn, anything in core's kernel, or before proposing a new way for plugins to extend each other.
---

# Change the kernel's architecture

These records hold the decisions. Read them before you design; this skill is the
checklist, the records have the reasons.

- `docs/adr/0010-a-store-is-a-part.md`: a store is the `JournalStorage` contract and its kit (`list` by `byCreation`, no index; a `pair` of handles for a store that outlives its handle); a turn its writer left open is closed by `Sessions.recover` as `Abandoned`, called by the host, never by the kernel; one writer per store is assumed and the journal stays whole when the host was wrong; a parent is not checked to exist
- `docs/adr/0009-what-the-ui-shows-is-a-record.md`: what the UI shows is a view record (`plugin.render.view`, tagged `ui`, no message, same id replaces) a tool appends through `CurrentTurn`; a client folds them with `viewsOf`; progress is live; the model never sees a view
- `docs/adr/0008-a-memory-keeps-its-summary.md`: a memory keeps what it derived (a summary) as a record of its own, tagged `memory`, whose message it sends; it gets a model's work through a contract the host provides (`Summarizer`)
- `docs/adr/0006-a-sub-agent-is-a-session.md`: a sub-agent is a session created with the caller's as its parent, reached through a tool whose result `{ answer, session }` names it; no new contract; a helper is created under the turn its delegate call runs in (`CurrentTurn`), with a depth limit read from the parent chain
- `docs/adr/0007-a-tool-reaches-its-turn.md`: work reaches the open turn it runs for through `CurrentTurn` (a `RunningTurn`), provided by `callTool` around a tool's handler, by `modelAnswer` while the model's stream runs, and by the summary memory around its summarizer; a tool declares it in `dependencies`
- `docs/adr/0005-context-for-one-request.md`: what a wrapper of `Memory` adds for one request (the time, a chosen instruction, fetched data) comes after the memory's context, whole and in its order, and is never stored; `memoryWrapperConformance` checks it
- `docs/adr/0004-tool-traffic-is-conversation.md`: the tools are Effect AI's `Toolkit`
  (no kernel service); tool definitions are code, never stored; a call and its result
  are conversation records (`assistantMessage(text, { toolCalls })`,
  `conversation.tool.result` from `toolResult`); a tool's failure is a stored result and
  the turn goes on; every memory sends through `paired`.
- `docs/adr/0003-journal-holds-the-conversation.md`: the journal holds the conversation
  and nothing derived from configuration; the conversation's records
  (`conversation.user.message`, `conversation.assistant.message`) are core's; records carry
  tags; memory builds the context (`Memory.context`); the kernel has no loop, which is the
  host's program. It supersedes parts of the two below.
- `docs/adr/0002-core-owns-state-plugins-own-workflows.md`: what core owns (sessions and
  their journal, events, the conversation's records) and what it never will (a loop, a
  memory, a prompt, a request); where a contract and a plugin live, and the import graph.
- `docs/adr/0001-kernel-plugin-composition.md`: how plugins compose.

## Choose the place

- [ ] Every agent has it, whatever its workflow: core (`packages/core/src/kernel`). Rare:
      it changes `api/core--kernel.api.txt`, and a name removed or changed there needs a
      CHANGELOG line saying what a plugin must change.
- [ ] Anything else: a contract in `packages/sdk/src/kernel/contracts/<name>/` (entities,
      events, pure rules, kit), its stock plugin in `plugins/<name>/`.
- [ ] A plugin imports contracts and core, never another plugin's folder; a contract
      imports core and other contracts, never a plugin. The boundaries gate refuses both.
- [ ] An event is named after the owner of the contract that defines it: `core.` for
      core's, `plugin.<name>.` for a plugin contract's; `conversation.` is core's vocabulary
      for the conversation, which a turn's body writes. A plugin that reads the
      conversation or another plugin's records extends that vocabulary
      (`vocabularyOf(name, own, CONVERSATION_VOCABULARY)`).
- [ ] An event is defined with `storedEvent` or `liveEvent`, and a record is made with
      `stored(definition, data)`: a session refuses an object written by hand, a copy of a
      draft, or a record of a definition written by hand (`NotADraft`). A definition's
      mistake (a name, a tag) throws where it is made, with what is wrong.
- [ ] A record whose shape changes takes a new name. A journal that holds the old name is
      refused by the new vocabulary, or passed over when the record may be skipped; a
      plugin never changes the journal's format, which is core's.
- [ ] A part that holds the open session (a tool, a memory) publishes a live event about
      its turn with `session.publish(definition, data)`, and asks for no `Core`.
- [ ] A listener is given what its definition's kind is delivered as: a stored record
      (`seq`, `turn`, `message`) or a live event. No handler tells the two apart by hand.
- [ ] An event's definition declares its tags (`conversation`, `turn`, `memory`, `ui`,
      `trace`, `<plugin>.<tag>`). A word outside the five does not type and is refused. Only a record tagged `conversation` is read as a message
      (`messageOf`); a memory may send the message of its own record (a summary, ADR 0008);
      a memory's own records are tagged `memory` and derived from the conversation, never a
      copy of it.
- [ ] Nothing derived from configuration is stored: no system text, no request, no
      pointers to what was sent, no tool definitions.
- [ ] Tool calls and their results are stored as conversation records, a failure as a
      result with `isFailure`, never as a failed turn. A loop reads the model's answer
      with `modelAnswer(stream, session, { onText })` and runs a call with
      `callTool(toolkit, call, session)`: each stores what it produced, and gives the
      work its turn (`CurrentTurn`), rather than the loop's own copy of those blocks.
- [ ] Work that must reach its session reads `CurrentTurn`, a `RunningTurn` whose writes
      cannot fail in their type, and never wraps them in `Effect.orDie`. Only the
      function that holds the open session provides it (`callTool`, `modelAnswer`, the
      summary memory around its summarizer).
- [ ] A memory sends its messages through `paired`, so no call goes without its result;
      the memory kit's `pairs` check holds it to that.
- [ ] What the UI shows is a record tagged `ui` that bears no message (a view), never a
      tool result the model reads in every later request; a client draws it by folding the
      journal, the same fold live and after a reload.
- [ ] A memory with state (a summary, a cut) stores it once as a record of its own,
      tagged `memory`, and starts every later context from it, so the prefix changes only
      when it compacts. It asks for a model's work through a contract the host provides
      (`Summarizer`), never a model of its own; a budget's errors are the memory
      contract's (`OverBudget`, `InvalidBudget`).

## Choose the way

1. A method of a contract sees the value at the right moment, with the session in hand:
   **wrap** that contract with a higher-order plugin.
2. The moment sits between two calls inside a turn: it is the host's program, so write
   it there. When two hosts copy the same block, make it a function of a contract.
3. Nobody needs an answer back: listen to an **event** with `Core.on`.
4. Other parts must see it later: append an entry to the **journal** through the open
   session.

## When you wrap

- [ ] The wrapper is a function from a plugin of the contract to a plugin of the same
      contract, hiding the inner one with `Layer.provide`. Never a plain layer placed in
      a `provideMerge` chain: one composed on the wrong line wraps nothing.
- [ ] Each contract's stack is its plugin with its wrappers applied; the rest of the agent
      gets one layer per contract.
- [ ] You know where it must sit: the last applied is the outermost and runs first. A
      memory wrapper's entry lands in the journal before those of the wrappers inside it.
      A wrapper that must sit at a fixed place says so in its doc comment.
- [ ] A memory wrapper appends its entry first, then delegates, and never edits the
      context the memory below returns.
- [ ] Nothing that must be recorded happens in a model wrapper: it has no session.
- [ ] A test shows the part using the contract sees the wrapped one, and the order.

## Do not add

A hook mechanism, a registry of steps, priorities or phase numbers on wrappers, optional
contracts a part uses when present, a config object that wires plugins, a store beside the
journal, listeners that write to the journal, or a stock loop. If a need seems to require
one, check "What would reopen this" in the records. If it applies, write a new record that
supersedes the one it changes before any code.
