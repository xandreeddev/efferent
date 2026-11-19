# @xandreed/core

The kernel's core (`src`, `docs/kernel.md`): what every agent has,
whatever its workflow. Its only runtime dependency is Effect. No provider
SDK, no IO, no runtime module (`node:`, `bun:`), no loop and no memory: the
workflow contracts and the stock plugins are the sdk's kernel
(`packages/sdk/src`), and the loop is the host's own program.

The engine of earlier releases (its entities, ports, kits, References, the
turn's bus, `./conformance` and `./internal`) is gone, and the kernel is the
package's `src` (ADR 0036). Its one entry is the root, `src/index.ts`:

| Entry | Holds | Semver | Who imports it (boundaries) |
|---|---|---|---|
| `@xandreed/core` (`src/index.ts`) | Ids, `Message` (`UserMessage`, `AssistantMessage` with its `ToolCall`s, `ToolResult`), the event envelope with its `tags` and `turn` (`Tag`, `taggedWith`), core's own events (`core.session.turn.started`, `core.session.turn.ended`, `core.listener.failed`), the conversation's records (`conversation.user.message`, `conversation.assistant.message`, `conversation.tool.result`, `userMessage`, `assistantMessage`, `toolResult`, `toolResultEvent`, `ToolResultData`, `CONVERSATION_VOCABULARY`) and the helpers a plugin defines its own with (`storedEvent`, `liveEvent`), reading a journal (`readJournal`, `vocabularyOf`, `KERNEL_VOCABULARY`), the session's phase and its fold, `inspectionOf`, the `JournalStorage` and `Sessions` contracts with their kits, `Core` (publish, on, events) with `kernel`, the layer that provides it, and the spend ledger `ModelSpend` with `modelSpendMemory` and its kit (ADR 0020) | a name removed or changed in `api/core.api.txt` comes with a CHANGELOG line saying what a plugin must change | the sdk's kernel, and the eval packages for the spend ledger (`core-kernel`) |

`quality/exports-have-consumers` runs on the entry (`CURATED_ENTRIES` in
`foundry.config.ts`): each export is imported, by one of the entry's
specifiers, from another package, a script or a doc code block, or is
tagged `@public`. `@public`, on the declaration, marks host API: what the
guides document for hosts, and what a host needs to write a plugin, a
port's adapter or a kit. Core exports nothing `@deprecated`: a name that
goes is removed in the release that drops it, with its replacement in the
CHANGELOG.

The boundaries gate (`foundry.config.ts`) holds the package in one layer,
`core-kernel` (`src/**`), with its tests in `core-kernel-tests`: it
imports nothing of the workspace and `effect` alone, so no model type and
no runtime module enters it. A package that imports `@xandreed/core` or
`@xandreed/core` names `core-kernel` in its `canImport`. The
kernel's rules:

- Core owns what every agent has, whatever its workflow: sessions and
  their journal, journal storage, events, the message vocabulary and the
  conversation's records (ADRs 0002 and 0003). It never owns a loop, a
  memory, a prompt, a system text or a request to a model: memory is a
  contract of the sdk's kernel (`packages/sdk/src/contracts`), the
  loop and the system text are the host's program, and no code here
  defines or imports them; a comment names them only to say where they
  live.
  Core stores nothing and runs no turn. `Core` is `publish`, `on` and
  `events` (`core.port.ts`, `core.adapter.ts`); everything else there is
  vocabulary, pure rules, the two contracts and their kits.
- Core's API is a product. `api/core.api.txt` lists it, and
  `verify:packages` fails when it differs from the build (`bun run
  api:update` rewrites it). A change that removes or changes a name there
  comes with a CHANGELOG line saying what a plugin must change. There is no
  API version constant: the package version is the version, and nothing
  would read a second one; one comes when remote plugins need a handshake.
- A limit on a wait for a listener holds whatever the listener does. A
  publisher waits for its waiting listeners while it is not interrupted
  itself, which is the contract inside a turn; every limit put on such a
  wait (the session plugin's `closeWait`, a caller's interrupt, the close
  of a scope) returns at its own time, over a listener that cannot be
  interrupted too. That holds because a listener is called on a fiber of
  its own (`call` in `core.adapter.ts`): the one who waits joins it, and
  when its own wait is interrupted it reports the listener, interrupts it
  behind itself and returns. Never join or
  interrupt a listener's fiber in a way that waits for it, and never issue
  the report from the listener's own interruption: an uninterruptible one
  never gets there. Whatever a handler ends with is its own failure,
  `ListenerFailed`, an interrupt it was not sent included (`Effect.interrupt`,
  a join of an interrupted fiber, an await of an interrupted deferred):
  only the interruption of whoever waits is the cut, so a handler's own
  interrupt neither silences a background listener nor passes for its
  publisher's interruption. A waiting listener is started at once
  (`startImmediately`), so one that does not suspend runs before any other
  fiber, as if it were called in place. `core.listener.failed` is never
  waited for: a listener registered for it with `{ wait: true }` is
  delivered in the background, and a report only hands the event over. A
  listener removed while a publish is under way is passed over. By
  default the first waiting listener that fails stops those after it and
  fails the publish; `PublishOptions.listenerFailures: "report"` runs
  every one, reports each failure after the hand-over, in the order the
  listeners ran, and its overload of `publish` cannot fail (the session
  plugin's end of a turn and the inbox's `plugin.inbox.queued` use it). The
  waiting listeners run, then the publisher's own step
  (`PublishOptions.beforeHandOver`), then the event is handed to the
  background ones and the stream, which hear of it on fibers of their own,
  whenever they are scheduled, possibly before the publisher's next step:
  what must hold when the background hears of an event is done in the
  publisher's own step (`core.adapter.test.ts` holds each; the session
  plugin's test of its `beforeHandOver` runs under a scheduler that makes
  every fiber yield after a few operations).
- A listener is named by its registrant: `Core.on` takes `{ name, wait? }`,
  and `name` is how a failure of it is reported. There is no ambient
  plugin name: a plugin is a layer, and nothing sets one around it.
- `kernel({ capacity? })` (`core.adapter.ts`) is the layer of `Core`
  and nothing else; every other part is a plugin's layer, composed
  over it by the host. Core has no wiring of its own: no plan, no
  declaration of what a plugin needs beside its layer's type, no wait for
  `Core` to fall quiet. A plugin's listeners go with its layer's scope.
- The event type is open. An event is named after the owner of the
  vocabulary that defines it: `vocabulary.entity.ts` defines core's own,
  the session's `core.session.turn.started` and `core.session.turn.ended`
  and `core.listener.failed`; `conversation.entity.ts` the conversation's
  records, `conversation.user.message`, `conversation.assistant.message`
  and `conversation.tool.result`, which whoever runs a turn writes (ADRs
  0003 and 0004). `assistantMessage(text, { toolCalls })` takes the model's
  `tool-call` stream parts as they came (`{ id, name, params }`) and
  `toolResult(call, result, isFailure, { whole? })` what a call came to (`whole`, written only when true: the tool's word that its result is sent as stored, ADR 0011); both brand the
  call's id and keep a value that is not JSON as its text. Tools are never
  stored: they are the host's code, like the system text. A plugin contract's events
  and a plugin's own are defined in its folder with `storedEvent` and
  `liveEvent`, which take the definition's `tags`. `KERNEL_VOCABULARY` answers
  for `core.` records only, `CONVERSATION_VOCABULARY` for those and the
  conversation's; a plugin's vocabulary adds its prefix over one of them, or
  over the vocabulary of the plugin whose records it reads
  (`vocabularyOf(name, own, over)`). Never type `Core.publish`, `Core.on`, `OpenSession.append`
  or `JournalStorage.append` with a list of names: the sdk's
  `plugins.test.ts` defines two events of its own and must keep compiling.
  A stored event is always announced with its turn (`announced`); a live
  one names a turn only when it happens inside one (`LiveEvent.turn` is an
  optional key), so an event about a session and no turn of it, such as
  the inbox's `plugin.inbox.queued`, is made with `live(definition, { id })`.
  `core.` records are the session plugin's to write: `OpenSession.append`
  refuses one (`SessionRefused`, `ReservedName`) and stores nothing, which
  the sessions kit checks (`reserved-name`).
- A message sits once, on the envelope (`StoredEvent.message`), and
  `messageOf` reads it only from a record tagged `conversation`, whichever
  plugin wrote it, so text a record of another use bears never reads as
  the conversation. What it stands for (the run of the journal a summary
  replaces) is the writing plugin's own data: the envelope has no field
  for it. Every record carries the tags its definition declares and the
  turn it was stored in: the session plugin passes the open turn to
  `JournalStorage.append(id, expectedSeq, turn, event)`, and the store
  stamps it with the place and the time. Nothing about a request is
  stored, and core names none (ADR 0003): the system text is the host's
  program's, and memory builds the context from the conversation. The
  kernel writes no text for the model: a failed tool result holds the
  text of the failure, as it came. That is a tool's own failure, Effect
  AI's toolkit's, or a kernel refusal raised inside the handler (a
  `SessionRefused` such as `NotADraft`), whose message the model then
  reads; those messages say what to do next.
- `Sessions.open(id)` opens the next turn in the caller's scope and closes
  it with the scope's exit; `turn(id, body)` runs a body in a scope of its
  own. A scope's close cannot fail, so an end that cannot be stored is a
  defect of the scope under `open` and the storage failure itself under
  `turn`; the sessions kit checks `open` (`open`).
- A contract carries a plugin's own tagged error as it was raised
  (`PluginFailure`), so core names no plugin's error.
- `Sessions.create` takes the input as a host writes it
  (`NewSessionInput`, the encoded side of `NewSession`) and decodes it: an
  empty owner, or a parent that is no id, is `InvalidSession`. The kit
  checks it (`invalid-session`).
- A definition and a record are made one way each. `storedEvent` and
  `liveEvent` make a plugin's definitions (core's own are `coreStoredEvent`
  and `coreLiveEvent`, which the entry does not export), and each checks
  where it is called: a name that is none, a one-word tag outside
  `RESERVED_TAGS` (which does not type either, `DefinitionTag`), a tag under
  another plugin's name. A refusal there throws an `Error` whose message
  says what is wrong (`orRefuse`, over `Result.getOrThrowWith`: the gates
  ban `throw`, and `Schema`'s own `make` says only "Schema validation
  failed"). `stored(definition, data)` is the one way to make a
  `StoredDraft`, which is branded: it marks what it makes, and only for a
  definition made by those functions, on a property no copy or store
  carries over (`isStoredDraft`). The session plugin refuses anything else
  (`NotADraft`), and the sessions kit checks it (`not-a-draft`). The `Tag`
  schema checks a tag's shape alone, so a stored record with a tag a later
  kernel reserved still decodes: never move the reserved words into it.
  `vocabularyOf` refuses, where it is called, a definition that is not
  under its plugin's prefix.
- `Core.on` hands a handler what its definition's kind is delivered as
  (`DeliveryOf`: `StoredDelivery` or `LiveDelivery`), and delivers an event
  only when it has the definition's name and its kind. `OpenSession.publish`
  publishes a live event about the open turn (the sessions kit's `publish`),
  so a tool or a memory that holds the session needs no `Core`.
- A header reads back with whatever format it was written in
  (`SessionHeader.format` is an integer, not the literal); `currentFormat`
  is the one place it is compared with `JOURNAL_FORMAT`, and the session
  plugin calls it before a turn opens (`FormatMismatch`). `Sessions.read`
  does not refuse: a host shows what it found. The storage kit checks that
  a header's `parent`, `createdAt` and `format` read back as given.
- A store is the `JournalStorage` contract and its kit (ADR 0010). `list`
  gives every header by `byCreation`, a function of the headers alone: a
  store keeps no index. A store whose journals outlive its handle gives
  the kit a `pair` and is held to `reopens`. A stored value that is not a
  journal's is `Unreadable`, never passed over. `Sessions.recover` closes
  a turn whose writer is gone as `Abandoned`; the kernel never calls it,
  the host does. The session plugin keeps the journal whole when a turn
  was closed under its writer (the sessions kit's `recovered-writer`):
  that is why the kit's subject gives the store too.
- A branch (ADR 0016) is a session whose journal starts as a copy of
  another's up to the end of a closed turn: `JournalStorage.fork(header)`
  copies the events as stored, in one step, and `Sessions.fork(id, {
  through })` finds the cut (`cutOf`, the first end of the turn asked for,
  or of the last closed one) and makes the header (`branchHeaderOf`). The
  header's optional `branch: { of, through }` says where it was cut;
  `parent` keeps meaning a sub-agent's caller, and the format is the same.
  A fork announces nothing and claims nothing. The storage kit's `fork` and
  the sessions kit's `fork` hold both; a branch of a journal of another
  format is refused in the sessions kit's `format`.
- The spend ledger (ADR 0020) is the one contract here that no turn needs:
  `ModelSpend` (`model-spend.port.ts`), its data and pure transitions
  (`model-spend.entity.ts` and its functions), the ledger in memory
  (`modelSpendMemory`, `model-spend.adapter.ts`) and its kit
  (`modelSpendConformance`, with its careless ledgers in its test). It sits
  here because the eval packages take it and nothing else of the framework,
  and must not depend on the sdk. It holds no conversation and calls no
  model: whoever sends a model call reserves. It has the total cap alone; a
  per-turn cap comes with the provider that names a turn and forgets it.
- Service keys are `@xandreed/core/kernel/<Name>`. The kits use the
  kernel's own helpers (`conformance.entity.ts` and its functions, which
  are not exported), not core's `src/conformance.functions.ts`. A check
  has an `id`, the one its kit's doc comment lists, and a failure names
  the check it came from. `journalStorageConformance` has its self-test
  here; `sessionsConformance` runs, with its careless plugins, where the
  stock plugins live (`packages/sdk/src/kits.test.ts`). A new check comes with a
  careless plugin that fails it and no other check it is not careless
  about. A check never counts scheduler turns to show that something did
  not happen: it waits on a latch or publishes a probe after.

## Model-facing text

None: core's kernel writes no text a model reads. A failed tool result holds
the tool's own failure, and the texts a kernel host sends (pointers, notes,
tool descriptions, refusals) are the sdk kernel's, inventoried in
`packages/sdk/AGENTS.md`.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
