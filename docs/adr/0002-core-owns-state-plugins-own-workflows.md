# ADR 0002: Core owns state and events, plugins own every workflow

- **Status:** accepted, 12 November 2026
- **Applies to:** `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and every plugin written for them
- **Supersedes:** nothing. ADR 0001 says how plugins compose; this record says what core holds and what it leaves to them.
- **Skill:** `kernel-architecture` loads this record and 0001 before an architectural change

## Context

The first cut of the kernel put every part in a layer, the loop included, but core still
named a workflow. `@xandreed/core/kernel` held the `Loop` and `Memory` contracts, the
request a model is sent (`ModelRequest`, its estimate, `Tokens`, `StepNumber`), the loop's
events, and `Settings { system }`, which `kernel(...)` provided beside `Core`. Core so said
that every agent has a loop, a memory and a system prompt. That is policy: an agent that
only records what a host does, or one whose prompt is assembled per request, has neither.

The design follows the model of a modal text editor whose core owns buffers and events,
while plugins, written against the core's API, change everything else and each user
assembles an editor from them. Here the sessions and their journal are the buffers.

## Decision

**Core owns what every agent has, whatever its workflow:**

- the ids (`SessionId`, `Seq`, `TurnNumber`, `EventName`, `PluginName`, `Owner`, `ToolCallId`);
- the message vocabulary (`Message`, `UserMessage`, `AssistantMessage`, `ToolCall`), which a
  record's envelope bears, and `messageOf`, so any plugin reads any plugin's messages;
- sessions and their journal: the `JournalStorage` and `Sessions` contracts with their kits,
  `OpenSession`, the session's phase, its two transitions and the fold of a journal to it;
- events: `Core` (`publish`, `on`, `events`), event definitions, `storedEvent` and
  `liveEvent`, the session's own events and `core.listener.failed`;
- reading a journal (`readJournal`, `vocabularyOf`, the skip flag);
- `kernel({ capacity? })`, which provides `Core` and nothing else;
- the core part of inspecting a session: its header, state and events (`inspectionOf`).

**Core never owns** a loop, a memory, a prompt, a system text or a request to a model.
Those are workflow, and a workflow is a plugin's.

**Workflow contracts live in contract folders** of `@xandreed/sdk/kernel`:

- `contracts/loop`: `Loop` (`run(input)`), `TurnInput`, `Reply`, `LoopFailure`, the loop
  kit and the script it hands a model; `Settings { system }` and its `settings({ system })`
  layer; the conversation's events (`plugin.loop.user.message`, `request.sent`,
  `assistant.message`, `assistant.delta`); the request vocabulary (`ModelRequest`,
  `SentRequest`, `ResolvedRequest`, `RequestRefused`, `resolveRequest`, `estimateTokens`,
  `estimateRequest`, `Tokens`, `StepNumber`, `firstStep`); the requests part of inspecting
  a session (`requestsOf`); and `LOOP_READER`, the reader of the loop's records.
- `contracts/memory`: `Memory`, `MemoryFailure` and the memory kit.
- `contracts/inbox`: `Inbox`, its ticket, refusals and event.

A contract folder holds a contract's entities, events, pure rules and kit. Its stock plugin
lives in `plugins/<name>`. The `Loop` contract does not name `Memory`: only the stock loop
plugin uses one.

**The import graph has no cycles:**

```text
core  <-  contracts/loop  <-  contracts/memory
               ^                    ^
         contracts/inbox      plugins/*   (contracts and core, never another plugin)
```

A plugin depends on contracts and on core, never on another plugin's implementation.

**Enforced, not a convention.** The boundaries gate (`foundry.config.ts`) holds the graph:

- `sdk-kernel-contracts` (`contracts/**`) may import core's kernel and the contracts, so a
  contract cannot reach a plugin;
- each plugin folder is a layer of its own, `sdk-kernel-plugin-<name>`, that may import the
  contracts and core's kernel, so a plugin cannot reach another plugin's folder;
- the entry (`index.ts`), the tests and `testing.ts` reach every layer.

A deliberate import from a contract into a plugin, and from one plugin folder into another,
is refused (`boundaries/illegal-import`). The contracts share one layer, so the direction
between two contracts (memory over the loop, never the loop over memory) is kept by review,
not by the gate.

**Events are named by the owner of the contract that defines them.** Sessions are a core
contract, so their events are `core.session.turn.started` and `core.session.turn.ended`.
The loop contract's are `plugin.loop.*`, a memory's `plugin.<its name>.*`. Core's vocabulary
(`KERNEL_VOCABULARY`) answers for `core.` records only; `LOOP_READER` adds the loop's, and a
memory's vocabulary extends that (`vocabularyOf(name, own, LOOP_READER)`).

**Turn and session lifetimes.** ADR 0001 proposed a pure reading rule for entries that live
for a turn or a session (`visibleEntries`). It reads what a memory sends, so it belongs to
the loop contract, beside `LOOP_READER`, not to core: core's reader stays a reader of
`core.` records.

## Core's API

Core's API is exactly what `@xandreed/core/kernel` exports (`packages/core/src/kernel/index.ts`),
which `api/core--kernel.api.txt` lists. A plugin may rely on all of it:

- **Ids:** `SessionId`, `Seq`, `TurnNumber`, `EventName`, `PluginName`, `Owner`, `ToolCallId`.
- **The message vocabulary:** `Message`, `UserMessage`, `AssistantMessage`, `ToolCall`, and
  `messageOf`, which reads the message any record bears.
- **The event envelope and event definitions:** `StoredDraft`, `StoredEvent`, `AnnouncedEvent`,
  `LiveEvent`, `KernelEvent`, `Delivered`; `EventDefinition`, `StoredDefinition`,
  `LiveDefinition`; and the helpers a plugin defines and makes its own with: `storedEvent`,
  `liveEvent`, `stored`, `live`, `announced`, `originOf`, `dataOf`.
- **Core's own events:** the definitions `turnStartedEvent`, `turnEndedEvent` and
  `listenerFailedEvent`; their data, `TurnStartedData`, `TurnEndedData`, `TurnOutcome` and
  `ListenerFailedData`; and the constructors the session plugin stores a turn's start and end
  with, `turnStarted`, `turnEnded` and `outcomeOf`.
- **Reading a journal:** `Journal`, `Vocabulary` (named `Reader` when this was written), `readJournal`, `vocabularyOf`, `KERNEL_VOCABULARY`.
- **Sessions:** `Sessions` (`create`, `read`, `turn`), `OpenSession` (`append` and `journal`
  inside a turn), `TurnFailure`; a session's header and how one is asked for, `SessionHeader`,
  `JOURNAL_FORMAT`, `NewSession`, `NewSessionInput`; its phase, `SessionState`, `Free`,
  `TurnOpen`; the transitions and helpers the session plugin imports, `beginTurn`, `endTurn`,
  `sessionStateOf`, `headerOf`, `newSession`; and inspecting a session, `Inspection`,
  `inspectionOf`.
- **Journal storage:** `JournalStorage` (`create`, `append`, `read`).
- **Events at run time:** `Core` (`publish`, `on`, `events`) and `kernel({ capacity? })`, the
  layer that provides it.
- **Option types:** `KernelOptions`, `ListenOptions`, `PublishOptions`.
- **Errors:** `ListenerFailed`, `JournalStorageError`, `UnknownRecord`, `SessionRefused`,
  `InvalidSession`, and `PluginFailure`, the shape of a plugin's own error that the contracts
  carry.
- **Kits:** `journalStorageConformance` (`JournalStorageSubject`), `sessionsConformance`
  (`SessionsSubject`), `ConformanceCheck`, `ConformanceFailure`.

There is no version constant: the package version is the version, and nothing would read a
second one. One is added when plugins loaded from elsewhere need a handshake.

**The rule protects the whole report:** a change to `api/core--kernel.api.txt` that removes or
changes any name in it comes with a CHANGELOG line saying what a plugin must change, and the
list above changes with it. CI already fails when the report is out of date (`bun run
verify:packages` compares it with the build; `bun run api:update` rewrites it), so every
change to core's surface shows in review.

## Considered and dropped

- **A scripting language for plugins.** A small language in which plugins would be written,
  above TypeScript. It would need its own types, errors, tooling and a bridge to every
  contract, and it would hide the layer types that make a missing part a compile error.
  Effect and TypeScript stay the plugin language.
- **An API version constant** beside the package version: nothing reads it yet.
- **A ready-made assembly** of the stock plugins in core or the sdk. Each app assembles its
  agent from plugins; the lesson's stack is the example.

## Later

- **Remote plugins**, run in another process or loaded at run time. They would need a
  handshake, a wire form of the contracts and a version to agree on. A later cut.

## What would reopen this

- A concept that every agent needs whatever its workflow, which no plugin can own because
  two contracts would both have to define it: it moves into core, with this record
  superseded.
- A plugin that must import another plugin's implementation, where no contract can stand
  between them.
- Remote plugins becoming a requirement, which may need core to carry a version.

A change to this decision is a new record that supersedes this one; this one is not edited.
