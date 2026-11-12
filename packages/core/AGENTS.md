# @xandreed/core

Shared schemas, service ports, message codecs and protocol helpers. Runtime
dependencies are Effect and the provider-neutral effect/ai contracts only.
No provider SDKs, filesystem IO, runtime graph, terminal, or host imports.

`domain/trace-parent.entity.ts` holds the branded nonzero 32/16-hex trace and
span identities and optional sampling decision of `TraceParent`. Its pure
`traceParentOf` normalizes valid span IDs to lowercase and omits invalid/custom
or tracing-disabled ancestry; `externalSpanOf` restores an external parent,
preserving explicit sampled false and Effect's default when it is absent. No
mutable span, annotations or captured Context is stored in this data.

`src/loop` holds the References a step reads (`CurrentPromptCacheKey`,
`CurrentModelCallPolicy`, `CurrentAgentStep`, `CurrentAgentRun`, `CurrentTraceContent` with
`replayableContext`, `CurrentPromptProvenance`). `src/internal` holds what
the agent loop, the models plugin and the sdk share with core: the provider
mapping (`mapping.entity.functions.ts`), the stream fold, tool schemas, and
the JSON, glob and id helpers (`randomUuid`, which the models plugin's kits
use too). The turn engine (`TurnLive`, a turn's run and lifecycle) is the
sdk's (`packages/sdk/src/turn/`); core keeps what code beneath it uses too:
the turn's bus (`src/turn/turn-bus.adapter.ts`: `makeTurnEvents` and
`makeTurnTasks`, the in-memory `TurnEvents` and `TurnTasks` the step-loop
kit runs a loop with, and `harnessDefectsAsFailures`, which the sessions
plugin and the agent loop use), and the memory, journal and model-request
functions the engine reads, which `./internal` exports to the sdk.

The package has four entries, each an `index.ts` of explicit named exports:

| Entry | Holds | Semver | Who imports it (boundaries) |
|---|---|---|---|
| `@xandreed/core` (`src/index.ts`) | entities, ports, events and journal kinds, `define*`, errors and their guards, model-text frames, References, in-memory adapters | yes | every package |
| `./conformance` (`src/conformance/index.ts`) | every kit of core's ports but the `ToolRegistry`'s (`@xandreed/sdk/conformance`: it runs its turns over `TurnLive`), `ConformanceCheck`, `ConformanceFailure` and `check`, the helper a kit's checks are built with | yes | every package |
| `./internal` (`src/internal/index.ts`) | what first-party packages use of the provider mapping, the stream fold, tool schemas, invocation receipts and the id helper, and what the sdk's turn engine reads of core | none | plugin-agent-loop, plugin-models, plugin-tool-discovery, sdk |
| `./kernel` (`src/kernel/index.ts`) | the kernel, a small core beside the rest of this package (`docs/kernel.md`): ids, `Message`, the event envelope, the event definitions and the helpers a plugin defines its own with (`storedEvent`, `liveEvent`), the pure rules (`inspectionOf` among them), the `JournalStorage`, `Sessions`, `Memory` and `Loop` contracts with their kits, `Settings`, and `Core` (publish, on, events) with `kernel`, the layer that provides `Core` and `Settings` | a first cut: it changes as the parts it leaves out return | the sdk's kernel only (`core/kernel`) |

A package reaches `./internal` only when its boundaries layer grants
`core/internal` (the core entry layer's `restricted`). The root does not
repeat what these entries hold. Public glob helpers live in `workspace/`, public tool-schema helpers in `turn/`, and message mapping in `domain/`; the internal entry re-exports the subset first-party consumers need. Root exports name their declarations directly. No alias redeclaration conceals a module's role.

The credential and settings stores (`AuthStore`, `SettingsStore`) are not
core's: they are the models plugin's own ports, exported with their kits by
`@xandreed/plugin-models` and its `./conformance`, and they keep the service
keys they were declared with here (`@xandreed/core/AuthStore`,
`@xandreed/core/SettingsStore`). Core names them only in prose:
`HARNESS_CODES` lists their codes (`auth.corrupt`, `settings.corrupt`), as
it lists every package's. Core's own model ports, `ModelCatalog` and
`UtilityLlm`, need nothing of theirs.

`quality/exports-have-consumers` runs on all four entries (`CURATED_ENTRIES`
in `foundry.config.ts`): each export is imported, by its entry's name, from
another package, a script or a doc code block, or is tagged `@public`.
`@public`, on the declaration, marks host API: what the README, the guides
or the website document for hosts, and what a host needs to write a plugin,
a port's adapter or a kit (ports and the entities in their signatures,
`define*`, References, error tags and guards, event and stored-payload
schemas). An export that is neither is not added: use it from first-party
code, document and tag it, or leave it unexported. A name no package uses
and no host needs is not exported; core uses it where it is declared. Core
exports nothing `@deprecated`: a name that goes is removed in the release
that drops it, with its replacement in the CHANGELOG.

What a host may still hold from older releases keeps reading: a
`HarnessConfig` names no profiles, and `resolveGraph` refuses a config that
still carries `profile` or `profiles` (`config.profile`) rather than ignore
them.

The boundaries gate (`foundry.config.ts`) layers core by a file's role; a
file is in the first layer whose glob matches it:

| Layer | Files | May import |
|---|---|---|
| `core-model` | `*.entity.ts`; the References in `loop/` | nothing of core |
| `core-ports` | `ports/**` | model |
| `core-logic` | `*.entity.functions.ts`, `internal/**`, `turn/model-text.ts` | model, ports |
| `core` | everything else: adapters (the turn's bus among them), harness, the memory session, prompt sections; and the entries (`**/index.ts`), which re-export every layer | model, ports, logic |
| `core-kits` | `*.conformance.ts` | model, ports, logic, core: the step-loop kit runs a loop over the turn's bus |
| `core-kernel` | `kernel/**`, before every layer above; `core-kernel-tests` holds its `*.test.ts` | nothing of core |
| `core-tests` | test code: `*.test.ts`, `*.bench.ts`, `testing` modules and folders | every layer, and the test libraries `bun:test`, `fast-check` and `effect/testing`, which no other layer imports |

Of the third-party modules, the model and `core` import `effect` alone; the
ports, the logic and the kits also `effect/ai`.

`src/kernel` is apart from all of that. Its files are one layer,
`core-kernel`, placed before the layers above, with its tests in
`core-kernel-tests`: it imports nothing else of core, and `effect` alone,
so no model type and no runtime module (`node:`, `bun:`) enters it; the
model call is the sdk's loop plugin's. No other layer of core may import
it, by a relative path or as `@xandreed/core/kernel`: `./kernel` is a
`restricted` subpath, granted to the sdk's kernel alone. The rest of this
file describes the existing engine's side of core, not the kernel. The
kernel's rules:

- Core stores nothing and runs no turn. `Core` is `publish`, `on` and
  `events` (`core.port.ts`, `core.adapter.ts`); everything else there is
  vocabulary, pure rules, contracts and kits.
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
  listener removed while a publish is under way is passed over. The
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
- `kernel({ system, capacity? })` (`core.adapter.ts`) is the layer of
  `Core` and `Settings`; every other part is a plugin's layer, composed
  over it by the host. Core has no wiring of its own: no plan, no
  declaration of what a plugin needs beside its layer's type, no wait for
  `Core` to fall quiet. A plugin's listeners go with its layer's scope.
- The event type is open. `vocabulary.entity.ts` defines only the facts
  other plugins rely on (`plugin.session.turn.started`,
  `plugin.session.turn.ended`, `plugin.loop.user.message`,
  `plugin.loop.request.sent`, `plugin.loop.assistant.message`,
  `plugin.loop.assistant.delta`) and `core.listener.failed`. A plugin's own
  events are defined in the plugin's folder with `storedEvent` and
  `liveEvent`. Never type `Core.publish`, `Core.on`, `OpenSession.append`
  or `JournalStorage.append` with a list of names: the sdk's
  `plugins.test.ts` defines two events of its own and must keep compiling.
  A stored event is always announced with its turn (`announced`); a live
  one names a turn only when it happens inside one (`LiveEvent.turn` is an
  optional key), so an event about a session and no turn of it, such as
  the inbox's `plugin.inbox.queued`, is made with `live(definition, { id })`.
- A message sits once, on the envelope (`StoredEvent.message`); a request
  is pointers (`ModelRequest.messages`), turned back into messages by
  `resolveRequest` alone, which returns the pointed messages
  (`PointedMessage`) and refuses a place that bears no message, a place
  named twice and, given the request's own place, one that is not before
  it. The estimate is `estimateTokens` alone.
- A contract carries a plugin's own tagged error as it was raised
  (`PluginFailure`), so core names no memory's or model's error.
- `Memory` is one function, `build(session, step)`, and keeps nothing by
  contract: it reads the session's journal, may append a record of its own
  through the open session it is given, and returns pointers.
- `Sessions.create` takes the input as a host writes it
  (`NewSessionInput`, the encoded side of `NewSession`) and decodes it: an
  empty owner, or a parent that is no id, is `InvalidSession`. The kit
  checks it (`invalid-session`).
- Service keys are `@xandreed/core/kernel/<Name>`. The kits use the
  kernel's own helpers (`conformance.entity.ts` and its functions), not
  core's `src/conformance.functions.ts`. A check has an `id`, the one its
  kit's doc comment lists, and a failure names the check it came from.
  `journalStorageConformance` has its self-test here; the other three
  run, with their careless plugins, where the stock plugins live
  (`packages/sdk/src/kernel/kits.test.ts`). A new check comes with a
  careless plugin that fails it and no other check it is not careless
  about. A check never counts scheduler turns to show that something did
  not happen: it waits on a latch or publishes a probe after.

A port that needs a type from a functions file gets it from the entity file
(`LogQuery` is in `memory-log.entity.ts`); what code beneath the sdk's
engine needs stays in core (`sessionAttributes` and `turnAttributes`, which
the in-memory log and the sessions plugin use, are session functions; the
turn's bus is a core adapter).

`SessionChannel` (`ports/session-channel.port.ts`) carries a session's live
payloads (`SessionChannelPayload`, `session/session-channel.entity.ts`) to
every follower of that address and stores nothing; its only failure is
`SessionChannelError` (`unavailable`). `shareTransient`
(`session/session-channel.entity.functions.ts`) is the opt-in turn
subscription that publishes the chosen `TransientTurnEventName`s there
through its own sliding queue and one sender fiber, each publish bounded by
`publishTimeoutMs`, logging and dropping a failed or slow publish, so
sharing never fails or holds a turn.
`sessionChannelConformance` checks order, isolation by the whole address,
no replay, a bounded backlog (`capacity`) and release (`retained`), with
careless-channel self-tests; the in-memory adapter is plugin-sessions'.

`ImageResizer` is the host-neutral optional image fitting port. Its input,
target and typed error live in `domain/image-resize.entity.ts`; `fitTarget`
and `scaledSize` are pure. `imageResizerConformance` ships pure valid PNG
fixtures and tests both provider limits, aspect, no upscaling and unsupported
bytes, with careless-stub self-tests. Adapters belong in plugins; core adds
no converter or native dependency. Reuse `imageSizeOf` and `mediaFromBytes`
for output checks; header parsing stays in the media functions.

`ModelSpend` is the model spend ledger port: its requests, holds, totals
and errors live in `domain/model-spend.entity.ts`, the reservation, settle,
release and forget transitions of the in-memory ledger are pure functions in its
`.entity.functions.ts` (with `modelSpendExceededOf`), applied under one
`Ref.modify` by `ModelSpendMemoryLive` (`turn/model-spend.memory.adapter.ts`).
`modelSpendConformance` checks caps, refusals that hold nothing, settlement,
release, repeats, concurrent reservations and forgetting an ended turn,
with careless-stub self-tests. Callers run `reserve` uninterruptibly. The
models plugin's `spend` option is its consumer; the turn sets
`CurrentTurnRunId` (`loop/stepContext.ts`) so every call of a turn, helpers
included, finds its turn, and forgets the turn in the ledger as its scope
closes.

`BuiltContext.stableMessages` is a required checked prefix length from the same
render as its messages. The memory kit tests the selected run's volatile tail,
reopened history and interrupted-call repair. A build leaves out another run's
exchange of the current turn while a call of it has no result yet: that run may
still be running it, so only a call of the rendering run or of an ended turn is
answered as `ToolInterrupted` (`in-flight-exchange`). A request's results build
in the order of its calls, whatever order they were recorded in (`call-order`).
Every pass of the renderer is linear in the log's length; keep it so (no copy of
an accumulated array or map per entry). Request headers save the count
optionally for compatibility; reconstruction honors the saved value. Only
`RequestStamp.requestVolatile` crosses to Effect prompt options under
`ENGINE_KEY`, and adapters consume it before provider serialization. Raw
entries and context fingerprints never gain that outgoing marker.

`ModelRequestHeader` remains the full materialized V1 host API. Stored V2
headers reference preceding `request.part` records for system text and each
tool declaration. `RequestPartHash` covers canonical schema-encoded tagged
JSON, including encoded provider absence; it does not authenticate a journal.
`resolveRequestHeader(events, at)` selects the actual session/sequence tuple
within caller-supplied authorized lineage, verifies every visible occurrence
of each referenced hash, and returns the full V1 compatibility representation.
It never reads later parts or sorts per-session sequence numbers across a fork.
Keep header lookup key-first: unrelated full bodies stay opaque and malformed
lookup keys still fail. Parts are protocol facts, never memory entries.
`requestHeaderConformance` ships V1/V2, integrity, prefix and lookup checks with
careless resolver self-tests; the SDK owns atomic part/header writes and ACKs.

`ModelRequestHook.prepare` is optional host policy for a fresh prepared request.
Its immutable draft contains the full run reference, step, active tool names and
base system/context/choice. The application helper validates a closed patch,
replaces system text, appends a nonempty `hostNote` context contribution once,
and treats null tool choice as automatic. Absence and empty patches preserve
model-visible bytes; only the accepted normalized patch becomes `header.hook`.
The helper reads the service at execution, preserves caller Context and original
`TurnError` identity, and keeps the callback interruptible even under a caller
mask. Invalid edges or foreign failures use `request.hook` with their cause.
`modelRequestHookConformance` proves application semantics and copying; the SDK
journeys separately prove one combined StepContext, durable header ACK before
dispatch, frozen retries and replay without reapplying the hook.

Plugin and configuration contracts live in `src/harness`; service tags live in
`src/ports`. Entity files contain schemas and derived types. Behavior belongs
in paired `.functions.ts` modules. `definePlugin` bridges typed Layers at the
explicit `plugin.adapter.ts` boundary: a layer may need only what its
`requires` lists, and `build` hands it the graph's untyped services through
`provideDeclared` (`src/harness/plugin.entity.functions.ts`), which checks
each declared key by key (`requires.missing`) and runs the work in the
caller's own context, never a captured one. A plugin that does not compile
against its declaration declares the service; never widen the layer's type
or cast it through. `defineTool` holds a tool's handler to its `requires`
the same way (`provideDeclared` under the tool's name, so the erased
`RegisteredTool.handler` needs nothing), and keeps the declared keys,
References aside, as `RegisteredTool.requires`: a registry checks them
when it opens a run's tools (`toolRegistryConformance`).
`definePromptSection` does the same for a section's `render` (its keys are
`PromptSection.requires`), so `PromptSection.render` needs nothing and the
turn renders sections where it is called, with no context of its own: a
section that reads services is built with it, and a render that lacks one
fails with `requires.missing`.

Tell a `HarnessError` (or another tagged error) by its tag and fields, with
`isHarnessError` (`src/harness/plugin.entity.functions.ts`), never with
`instanceof`: a host can load two copies of core, each with its own class,
and the other copy's errors would lose their codes. A failure's framework
code comes from `harnessCodeOf` (`src/harness/harness-code.entity.functions.ts`):
a `HarnessError`'s own, the code a begin refusal, `InputConflict`,
`TurnClosed` or `ReservedKind` stands for (`TAGGED_CODES`), a tagged error's own `code`,
never an untagged value's (a Node or SQLite error's `code` is `errorCodeOf`).
`HARNESS_CODES` is the published list of the codes the packages raise or
store: add a new one there, with its meaning in the event reference's
`ERROR_CODES` (`scripts/generate-event-reference.ts`, which fails on a
raised code the list lacks), and never rename or remove one; first-party
code builds a `HarnessError` of one with `harnessError(code, message, cause)`.
The writer and the ports on the turn's path over it fail with `TurnError`
(`src/session/sessions.entity.ts`), most of whose members have no `code`
field: match `TurnClosed`, `ReservedKind`, `SessionContended` and
`SessionLogError` by tag (`Effect.catchTag`), read a turn failure's code
with `harnessCodeOf`, and widen a port to `TurnError` only when its
implementations reach the writer. `isTurnError` tells one by its tag and
fields, from any copy of core: `harnessDefectsAsFailures` and the bus
restore one carried as a defect, and a loop or a registry lets one through
rather than wrap it. `PLUGIN_API_VERSION` is 3 since the writer raises the
tags; versions 1 and 2 still load. A `TurnRunner` (`Agent.turn`) fails a
turn that cannot begin with its `TurnBeginError` as it is, never a
`HarnessError` made from it (`turnConformance` checks `SessionBusy`).

`ModelFailureKind` and `ModelFailureStamp` describe a model request's semantic
failure under `ENGINE_KEY.failure`, independently of model, usage and request
bookkeeping. `modelFailureOf` reads an explicit own stamp before neutral
`AiError` reason fallback; it never searches provider prose, bodies or causes.
Unstamped malformed-output and tool errors remain unclassified. Stamp helpers
merge engine siblings, and `stampAiErrorFailure` copies each concrete reason
through its constructor while retaining declared evidence; metadata-less
reasons, including `NetworkError`, retain identity. `modelFailureCodeOf` names
the published code and `modelFailureMessageOf` supplies the shared fixed
reporting text. Provider evidence is interpreted in the models plugin.

`ModelOverflowEvidence` names the actual overflowing `ModelSelection` and known
`ModelLimits`, with omitted bounds remaining unknown. The stamp helpers accept
it as an optional third argument for `ContextOverflow` under `ENGINE_KEY.overflow`.
`modelOverflowEvidenceOf` reads only the same own explicit failure stamp; invalid
optional evidence cannot mask the failure kind or borrow another part's facts.
`StepRequest.onContextOverflow` is optional and authorizes one same-step resend
before a nonempty visible delta, after a durable context reduction. Absence and
false preserve the original failure. A callback failure keeps its identity.

`ModelCallData` is metadata for one terminal physical model attempt. One
`ModelCallId` spans its retries/configured fallback; `attempt` is positive.
Store the actual `ModelSelection`, never requested candidates or descriptor
settings. Known usage is distinct from Partial reported subtotals and Unknown;
new counts are strict normalized integers without tightening legacy TokenUsage.
Run id/ordinal appear together and a step needs that run. Provider outcome
precedes downstream empty/schema/tool acceptance and is independent of usage.

`CurrentModelCallRecorder` is read by `recordCompletion` at execution and
defaults to a no-op outside turns. Its record method fails with original
`TurnError`; unexpected recorder defects become `turn.defect` with their
original cause, including defects while invoking a host's method. An original
`TurnError` carried as a defect retains identity. Optional observation is owned by the turn, with bootstrap/live
dedup and a final legacy-per-model callback. `replayed` means durable before
this TurnLive opened, not merely delivered during registration. Observers
are soft; append/flush is hard. The sdk owns the recorder adapter and the
turn's lifetime, including helper calls in bootstrap and finalizers.

`model.called` is directly appended and flushed before notification, listed
in `RECORDED_ELSEWHERE` to avoid a second bus write, and appended to reserved
journal kinds. Stored format 9 adds its payload; old request headers and
memory fingerprints remain unchanged. `turnModelCallsOf` rejects malformed
and duplicate keys even when identical. `turnBilledUsageOf` sums ledger
Known/Partial subtotals plus the `step.usage` of every loop step (run ordinal,
step) no `Loop` call names; a step's Unknown or Known-zero `Loop` call still
stands for that step, and a helper call never hides a loop step it did not
record. No ledger at all is `turnUsageOf`. `ModelCallLegacyUsage` carries its
run and step for the same per-step choice in billing observers. Preserve
selected TurnResult/RunContext usage. Raw calls expose coverage; terminal-only
records cannot recover a SIGKILL gap or establish an exact provider bill.

The shipped `modelCallRecorderConformance` kit proves a full durable and
observing adapter (its fixture requires observe, although the public recorder
permits simple collectors without it). It checks durability before callbacks,
sticky ACK/error results, terminal dedup, bootstrap provenance, observer
lifetime and soft observer defects. Its careless self-tests are in core;
the real TurnLive adapter runs the kit in sdk and packed verification.
`UtilityCompletion.model` is an optional actual selection, preserving old
constructors and structural helper stubs without claiming their identity.

Session input contracts live in `src/session/sessions.entity.ts` and
`src/ports/sessions.port.ts`: `QueuedInput` holds one normalized
`UserMessage`, a stable `InboxItemId`, `InputDelivery` (`steer` or `next`)
and host-only source metadata. `Sessions.enqueue` stores work separately
from `begin`, which refuses a busy session. An input id is immutable across completion;
`InputConflict` is an enqueue failure, mapped by `TAGGED_CODES` to
`inbox.input-conflict`, not a `TurnBeginError`. Notice ids share its
namespace. `BeginTurn.Queued` claims one input as a user turn; its
`AdmittedTurn.input` retains the full input while `turn.started.input`
and `TurnToAdmit.input` carry only its id. `claimed` stays notice-only.
Untaken queued input survives failed, partial and interrupted turns without an
attempt ceiling; completion, waiting for an answer or explicit cancellation
acknowledges the input claimed by that turn. An early answer remains queued
for its own later turn.

`Sessions.transact` takes an optional `TransactOptions` (`key`, `command`):
its keyed refusals, `TransactDuplicate` and `TransactConflict` (mapped by
`TAGGED_CODES` to `session.transact-duplicate` and
`session.transact-conflict`), are in the error type only of a call given a
key (`TransactRefusal<O>`), so unkeyed callers' types are unchanged. The key
is stored as the framework's `transact.keyed` record (`TransactKeyedData`,
stored format 18), its own namespace apart from `turn.started` keys.
An explicit user resume reclaims its pending input in the opening commit.
`drain.take` selects all work, inputs or notices; the tasks plugin's
reaction executor selects notices. Keep these distinctions in
`sessionsConformance`, including careless wrappers that lose provenance,
accept conflicting ids or ignore the selection. `TurnWriter.steers` reads
fresh pending steering without recording an attempt. `take(entries)`
validates exact inbox-marked user messages and atomically stores them with
`inbox.taken` receipts and removal of their slots. Stale selections return
false without writing; consumed steers stay acknowledged across failure,
and their receipt anchors a later queued begin's duplicate. Inputs marked
next and notices stay untouched. The step loop probes after settlement,
including final completion, and takes only after an actual step starts,
before its plan (step zero too); a cap leaves steering queued. An empty
final probe leaves later arrivals for the next turn. The old in-memory
`TurnInput.steering` remains nondurable.

`MemorySession.record`'s optional alternate commit runs under the same
allocation semaphore: true commits all prepared entries, false changes no
cache or id, and uncertain acknowledgments use the normal fresh-snapshot
reconciliation before another allocation. Keep that contract in
`memoryConformance`; never consume queue state and append the messages in
separate commits, or call memory from inside a queued writer decision.

`MaintainSignal` accepts `turn-start`, `step`, `turn-end` and `overflow`.
`turn-end` comes only after the turn's reply is final and sealed
(`TurnMemory.afterReply`, `TurnWriter.seal`), so nothing it meets can cost
the reply; `turn-start` is its safety net, observing the last durable
selected response (`TurnMemory.acceptedBefore`). Its optional `render` scope
names the calling run ordinal and tail placement; the sdk always supplies
it. Turn-end always renders with no `StepContext`, while older callers that
omit the scope keep latest-run/tail behavior for their existing phases.
Never remove the durable step context: an earlier
request's cut and saved recipe still need it. Transcript defaults are unchanged.
`MemoryObservation` is runtime accepted-input evidence for the same actual
model. `scaledTokens` only raises message estimates, subtracts the measured
system/tool reserve once, and saturates unsafe results conservatively.
An absent optional observation leaves estimates unchanged. All strategy
candidate comparisons use the same scale; raw built estimates, fingerprints,
stable prefixes and stored format 9 remain unchanged. The memory kit checks
that new phases preserve history and current results without requiring every
strategy to summarize; its careless phase check is in
`src/memory/memory-maintenance.conformance.test.ts`.

`MemorySnapshotData` records a retained render prefix and actual lineage cursors;
`MemorySnapshotCandidate` resolves those cursors to memory entry IDs. The optional
`LogHandle.checkpoint` and `TurnWriter.memorySnapshot` capabilities accelerate
rendering only: keep the full archive, reader, maintenance input and replay path.
`memory.snapshot` is a reserved protocol row, never a `LogBody` or a new `EntryId`.
`retainedMemoryPrefix` keeps exact request dependencies, raw presentation and
digest facts and every applicable compaction in original order. It keeps no cut
run's step context, and a compaction keeps only the text a render can show: a
replaced summary or ledger, and views of omitted entries, are emptied while the
compaction (and its id) stays. A snapshot so grows with the number of compactions,
not with their text. `validateMemorySnapshot` fails with `session.decode` only for
undecodable data or anchor/frontier entries the archive lacks; another strategy,
or retained facts unlike this release's selection of the same prefix (an older
rule, damage), log and use the full archive. `projectMemorySnapshot` falls back
for newly needed omitted dependencies and for a render of a cut run's step
context, and checks the first projected build of each step-context placement
against one full render (`MemoryProjection.verified`): a mismatch logs and
restores the archive. `memorySnapshotConformance` checks selection, cursor
integrity and fallback for unlike facts, every option family, render
verification and safe full-history fallback; its self-tests exercise careless
implementations.

`recall_context`, the tool that reads a shortened result back, is core's
(`src/memory/recall.entity.functions.ts`): a plugin may not import another,
so the tool lives where each memory plugin reaches it. `recallCapabilityOf(id)`
builds its capability under the contributing plugin's id (the window
plugin's `recallCapability` is `@xandreed/plugin-memory-window/recall`),
`spillPreview` writes the notice a shortened result ends with, and
`RECALL_TOOL` is the tool's name, by which a strategy tells a recalled page
and never shortens it. `RECALL_PAGE_CHARS` and `recallPage` are not
exported: nothing outside core reads them. A cut never splits a surrogate
pair (`cutAt`): the preview and a page end one unit earlier when the cut
would, a page asked for from inside a pair starts at the pair's first unit,
and the offset each prints is where its cut fell, so the pages read from a
notice join to the whole view. Keep every new cut of a view on `cutAt`: a
lone surrogate is not valid text to send. The capability's skill,
`memory.recall`, is always-on, so its summary never reaches the model:
guidance goes in the tool's and its parameters' descriptions.

A strategy can ask for those cuts at line breaks: `cutAtLineBreaks`, off by
default. It is each memory plugin's option, `MemoryPolicy.cutAtLineBreaks`
for the bound `recordTail` records, and the last parameter of `spillPreview`
(a strategy's own spills) and of `recallCapabilityOf` (its pages), so a
result's head and its pages are cut alike. The rule is one function,
`cutAfterLineBreak(text, from, at)`, exported from its module for the tests
and not from the package: the character cut (`cutAt`), and when that is
short of the text's end, just after the last `\n` before it, if that leaves
the piece some text (`from` is 0 for a preview, the page's start for a page)
and gives up no more than a quarter of the piece asked for (`at - from`);
else the character cut. It searches only the stretch the cut may move into,
so a page of a text with no line break costs the quarter, not the text
before it. What is given up is counted from the character cut,
never from `at`: where a surrogate pair moves that cut one unit back, a
count from `at` makes the rule choose a line break when it is asked again
at the cut it left, and a cut must be one the rule returns for itself
(`src/memory/recall.line-cuts.test.ts`, "cutting again at a position the
rule chose"). Keep the three cuts on that function, so a result's head, a
spill of it and its pages are cut by one rule. With the option off no cut
moves, and no text, golden or stored field differs. The option adds no model-facing text either: the notice and a
page's last lines are the same strings, with the offsets and counts of the
cut, and a piece that ends with its line break is followed by an empty line
before them. Two cuts never move: where a page already read starts (the edge
of the text the request holds), and a page's start, which is the offset the
call names.

`recall_context` can refuse a call for text the turn being run still shows,
and cuts a page where text already read starts (`recallOf`; the refusals are
the cases of `RecallRefusal`, `src/memory/recall.entity.ts`). The guard is
decided from the run's memory (`RunContext.memory`: `resolve`, `entries`,
`turn`) and the run the call is made in (`CurrentAgentRun`), and for a
result of the current turn only. A result of an earlier turn is always
served, a whole page: a reader names no strategy, so it cannot say what a
later turn's render shows of it. `shownChars` is how
many characters of its view a current-turn result shows from its start: all
of them while nothing rewrote or digested it, the head before the notice
after a bound or a spill, and 0 for a compact view, a digest or any other
preview. The head is `previewChars`, the inverse of `spillPreview`: the
offset the notice prints, and only when a cut can fall there (`cutAt` leaves
it where it is) and the stored preview is exactly the view's text up to it
and the notice written for it (`previewTo`), since a `Spill` holds whatever
text its strategy wrote. The preview is rebuilt from the printed offset as
it stands, never by cutting again under the session's rule: a log holds
previews cut at the character limit and previews cut at a line break (the
option was turned on or off, an earlier release wrote them), and each is
read back whatever `cutAtLineBreaks` is now. A check that cut again at the
printed offset would read a character-cut head as no head under the option,
and serve the result from its start. The precedence is read from `shownViewsOf`, under the strategy whose
compaction last named the result (a current-turn result is only ever
rewritten by the session that renders it), with digests counted as shown;
never write another copy of that precedence here. An offset inside the shown
text is refused as `ResultShown`. An offset inside a page of the result that
a `recall_context` call of this turn already returned to the asking run (its
start included; the inputs read once per call with `toolInputsByResult`) is
refused as `AlreadyRecalled` while that page is itself still shown whole.
The offset the reply names is the first one past that page whose text no
such page holds (`readOnAfter`, over `firstUnread`): the page's end, unless
a page already read holds the text there, and then the end of the last page
that follows on. So the call that follows the reply is served, never
refused for the next page along, and every offset inside pages that follow
on from one another gets one reply. With no text left after them the reply
names none: it says the page ends the result when the page that holds the
offset does, and that the text to the result's end is in pages already
read when pages after it hold the rest. Both are `Failure`s, returned like
`UnknownLocator`. An offset past the shown text and outside every such page
is a page, and that page never holds text of one: it ends where the next
such page starts, when that is sooner than its own end (`pageBounds`:
`RECALL_PAGE_CHARS` on, or with `cutAtLineBreaks` the line break before
that), wherever the call starts (below a page already read, in a gap between
two). So every
character a call returns is new to the request in whatever order the offsets
come, and the pages of one result together never hold more than the result
does. A page is never empty for it: its start is outside every page already
read, so the next one starts past it (only an empty result's one page holds
nothing). The line a page ends with (`continuation`) names the first offset
past it whose text no such page holds (`firstUnread`): the page's own end,
as always, unless a page already read holds the text there, and then the
offset past every page that follows on, or none when they run to the
result's end, so the model spends no call on a refusal. Six rules keep the
guard honest:

- A refusal must be true of the request the call was made from: where what
  is shown cannot be told, serve the page, as before the guard. So the guard
  is one-sided: a call it serves may still return shown text (a digest
  recorded under a policy that shows none, a page another run read), and the
  tool's description says a call for shown text can return none, never that
  it does. The cut is one-sided the same way: a page is cut only where a
  page the guard can tell is shown starts, so a page can still hold text of
  a page another run read, or of one read by a call that ran at once with
  it.
- A page already read is what the request shows for its call's result,
  never what its call's input says. `recordedEnd` reads where a page ended from the page as it is
  recorded: it starts at its call's offset (`cutAt`), its text is the
  recorded result before its last line, and the end counts only when the
  recorded result is exactly the view's text between the two followed by a
  line `continuation` writes for that end (the inverse of `pageText`, as
  `previewChars` is of `spillPreview`). So a cut page counts for the text it
  holds, an offset past its end is not refused for it, and two pages served
  whole to calls that ran at once overlap as they did. A page cut at a line
  break is read back the same way, whatever `cutAtLineBreaks` is when it is
  read: nothing here knows the page size or the rule. Never rebuild
  a read page from its call's offset and the page size, and never replay the
  rule over earlier calls to guess what they were served: a replay cuts the
  second of two calls that were both served whole. The page is read from
  the result's view, which is what the request shows for it
  (`presentedEntries`), never from the value the call returned: a result
  recorded in the tool's name that is no such page (a host's own answer to
  the call, a page a registry or a host presents as other text) is not
  counted as read, since what it showed cannot be told. Both halves are
  checked, the text and the line: text of the result cut by another marker
  is no page, and neither is other text before a genuine line. The line
  prints the locator, and a run id is any string, so the line's own text
  can hold what a line starts with: `recordedEnd` tries every place the
  line could start, the last first, and never stops at the first that does
  not fit. Every cut stays on a page's start or on `cutAt`, so no page
  holds half a surrogate pair. Change `continuation` and `recordedEnd`
  together: a line the second cannot read back leaves its pages uncounted,
  and the unit tests of the cut fail. A result the tool never writes
  is no page even when both halves fit: its line with no text before it,
  and text that ends inside a surrogate pair. Counted, each would be
  refused from its own end, which is the offset its refusal names.
  `rewritten` is this file's one list of what a compaction rewrites of a
  result, read by `shownChars` and by `readPagesOf`, which adds the results
  a digest names: a page a compact view or a digest took the place of is
  served again (the unit tests hold each).
- A refusal is read again after the request it was true of. It is the call's
  recorded result, so it stays in every later request of the turn and of
  later turns, while memory may shorten the result it is about (a spill
  under pressure leaves a shorter head and a new notice; a compact view, at
  a turn's start or under pressure, leaves no notice). A `ResultShown` text
  therefore says what the result showed when the call was made, holds no
  offset of its own and sends the model to the offset the result's shortened
  form shows when it reads the reply, or to 0 when that form shows none; the
  text for a result shown whole sends it nowhere while the result is still
  whole. Never put a number in a `ResultShown` text again: 0.21.0's `The
  first 16000 characters of this result are shown above. To read on, pass
  offset 16000.` sent a model past text its request no longer held. What
  such a reply leads to is where the result's shown form ends when it is
  read, not always the first text the request lacks: where the turn had
  already read a page from there, the call that follows the reply is refused
  with `AlreadyRecalled` in the same turn and served that page again in a
  later one. An `AlreadyRecalled` text names where the text already read
  ends because a page is never shortened by a strategy that contributes the
  tool, and it leaves a request only with its whole turn; a strategy that
  shortens a recalled page makes that text stale. Keep that offset the one
  a page's last line would name (`firstUnread`), never the end of the page
  that holds the offset asked for: 0.21.1 named that end, and after a model
  had read pages in order each reply led to the next page's refusal, one
  step a page; the pages a cut leaves follow on from one another by
  construction, so the same rule would refuse once for each of them. Say
  `That page ends the result.` only of the page that holds the offset. It names no turn (0.21.0's said `in this
  turn`): the page and the reply that calls it shown are recorded in the
  same turn, so the page is still above the reply in a later turn's
  requests, and `shown above` stays true there where `in this turn` would
  not. Never name the turn in a refusal's text again. The line a page ends
  with is read again the same way. It says how far the text already read
  runs after the page and where unread text starts, and nothing of what the
  request shows elsewhere: those pages were read in the page's own turn and
  leave a request with it, so the line stays true while the page is shown.
  Never write there that nothing of the result is left to read: the
  result's shown start can shrink after the page was served.
- Only a recorded page that is not an error counts as read. The call being
  answered is in the log before its handler runs, and a refused call returned
  no page. Two calls that run at once are each served as if the other were
  not, the same page or pages that overlap: neither has a result when the
  other is checked.
- Only the asking run's pages count (`ofRun`: the result's run id and
  ordinal are the `CurrentAgentRun`'s). A build leaves out another run's
  exchange while one of its calls has no result (`in-flight-exchange`), so a
  page that run read may not be in the request the call was made from. A
  call made outside a loop names no run, and then only a page recorded with
  no run counts. The sdk records every result with its run, and the handler
  reads the loop's run where the registry calls it: the journey checks both
  (the stored pages name run 0, and the page is refused).
- A refusal's text holds nothing of the request (no offset asked for, no
  locator): every offset inside one shown head gets the same `Failure`, and
  so does every offset inside one page, or inside pages that follow on from
  one another. The step loop signs a step's
  progress by its results, so a model that keeps asking repeats one
  signature and the breaker stops it
  (`packages/sdk/src/recall-guard.journey.test.ts`). The breaker counts
  steps whose results it has seen before in a row, and a step's signature is
  all of its results: a step that also returns something new, or more
  refusals than any step before it, does not count. So a model that steps
  forward inside text it read is stopped only while six refused calls in a
  row fall inside it: the first, then the five repeats the loop's default
  stops at (`REPEAT_BREAK_AT`, `packages/plugin-agent-loop/src/loop.ts`).
  Inside one page, with `RECALL_PAGE_CHARS` at 8,000, those six fit in the
  7,999 characters past the page's start up to a stride of 1,333; a longer
  stride reaches the next page first, which is new text and starts the
  count again, and such a run costs steps, not context. With
  `cutAtLineBreaks` a page gives up at most a quarter, counted back from
  the character cut, so it holds 6,000 to 8,000 characters (5,999 where the
  limit would split a surrogate pair and the character cut is one unit
  before it) and the longest stride stopped inside one is 999 to 1,333, by
  where the page ended: 1,333 is then an upper bound. Pages that follow
  on from one another count as one stretch of text, whose refusals are one
  reply: the journey steps down ten times from 60,000 and then forward
  through those pages 1,000 characters at a time, and is stopped at the
  sixth refusal. The journey holds strides of 1, 1,000 and
  1,333 as stopped and 1,334 as running to the step limit over new pages
  only, with pages cut at the character limit; change either constant and
  the bound moves with it. A model that
  steps downward, each call a little below the last page it read, is not
  stopped either, and no longer needs to be: each call returns the text
  between and nothing the request holds, a new result every time, so the
  run costs steps and ends at the step limit within the budget (the journey
  holds strides of 1,000 and 100 under both strategies).

The guard adds no stored field, journal kind or event, and bumps no strategy
version: a refusal is the failed call's result, recorded as any is.

A result is bounded as it is written (`recordTail`, `src/memory/memory-session.ts`):
when `MemoryPolicy.boundOnWriteChars` is above 0, a result whose presented
view is longer than the bound is recorded with the strategy's own
`Compaction { action: Spill { entry, preview } }`, its preview
`spillPreview(entry, view, bound)` (cut at a line break near the bound when
the policy sets `cutAtLineBreaks`; a result a little longer than the bound
that is left whole at the character limit, its preview no shorter than its
view, can so be bounded with the option), after the presentation and after the
digest step returns, so the first build that includes the result already
shows it bounded and the prefix holding it never changes later. The bound is
the tool's own when its view carries one (`ToolView.boundOnWriteChars`, from
`ToolAnnotations.boundOnWriteChars`; `0` keeps the tool's results whole),
else the policy's. Keep it a render-time fact: never record it as a
`ToolPresentation` or shorten a stored view (`recall_context` and
`MemoryReader.resolve` return the presented view, which must stay whole),
and add no journal kind, event or stored field for it (the cap rides beside
the presentation in `recordTail`, never in it; the stored format does not
move). Left whole: a pinned result, a `RECALL_TOOL` page, a result holding
images (a result with an applied view sends none), a result whose digest was
just recorded, is shown (`render.digests`) and is no longer than the bound,
and a result whose preview would not be shorter than its view. A failed
call's result is bounded like any other: its view is canonical JSON, whose
start holds the failure's name. A policy without the key, or with `0`,
bounds nothing whatever a tool asks, since the notice names a tool only a
bounding strategy contributes. A strategy that bounds contributes that tool
whatever its bound is set to later: the bounds a session recorded stay in
its log, and their notices name it. The annotation is a whole number of
characters, 0 or more (`BoundOnWriteChars`): `defineTool` checks it as
`defineSkill` checks an id, and throws on any other value. The raw append
comes first, before any host code, so the view call and the digest call sit
between it and the bound: a build by another run of the turn in between
shows the result whole once, and a write that stops there (an interruption,
a view or an append that fails, a process that dies) leaves the result
without a bound (nothing records one later, and every later build shows it
whole). `shownViewsOf(entries, { strategy, digests })` gives what a result
shows in place of its view (a compact view, a spill's or bound's preview, a
digest, in the render's precedence, with what wrote it and the compaction
or digest entry that holds the text, `source`): a strategy that compares
against what is shown reads it there. The render keeps its own
expression of that precedence (`renderedContext`), and
`src/memory/memory-log.entity.test.ts` holds the two equal for every result
of one log; change them together. `memoryConformance`'s `bound-on-write`
holds every strategy to the rule: a result shown shortened from its first
build resolves to its whole view and shows the same text after a later
write and a reopen, and a result its first build shows whole is still whole
after the next write. Its careless sessions (a stored view cut short, a
bound recorded by a later write, a bound kept outside the log) are in
`packages/sdk/src/memory.conformance.test.ts`.

`contextReportOf(events, { largest })` (`src/session/context-report.entity.ts`
and its functions) reads what filled each model request back from a
session's journal alone: a row per `request.prepared`, a request prepared
again in its step included, and a summary per turn. Keep it a pure reader:
no service, no journal kind, event or stored field of its own. A row's
results come from `shownResults(entries, options)`
(`src/memory/memory-log.entity.functions.ts`) over the entries up to the
header's cut, with the header's saved render recipe. `renderedContext` folds
every result through the same `shownResultOf`, so the report says what the
request carried: a change to what a result shows (a compact view or a
spill's preview, then a digest, then its view) goes there and in
`shownViewsOf`, which gives a strategy the same precedence, and the report
never gets a rule of its own for it. The rest follows the code that wrote
the journal:

- A request pairs with the latest `context.built` of its turn, run and step
  since that step's previous request; the fields read from it are none when
  the journal holds none.
- Tool declarations count as the sdk's `schemaTokens` counts them (the
  description, then the canonical JSON of the parameters, each tool
  estimated on its own), so a row's system and tool tokens sum to its
  `built.reservedTokens`. The header stores `Tool.getDescription` and a
  dynamic tool's own JSON schema, which the reserve does not read: the doc
  comment says where the two can differ.
- The messages are the strategy's estimate. The journal holds no character
  count of them and the report invents none.
- Host context is the `StepContext` the request showed: under `tail` the
  latest its run recorded within the cut, whichever step recorded it, and in
  the system text the step's own. The hook's note is told from the step
  policy's text by the `hook.context` of the header that context was
  recorded for, as `applyModelRequestHook` joined them. Each is none when the
  request showed none of it: 0 is an empty text.
- Usage goes to the latest request of the same turn, run and step prepared
  before it: a completed `Loop` `model.called` with reported usage, else the
  `step.usage`. A helper call of the same step is not the request's.
- A `Spill` is a bound when it precedes the `step.ended` that lists its
  result (`recordTail` records the bound before the loop settles the step),
  else a spill. A step's maintenance runs before its build, so a pressure
  spill of a result no request has shown yet also precedes the first header
  that includes it: that header rule decides only when no `step.ended` names
  the result.
- A turn's `compacts` counts results: one for each entry a `CompactViews`
  recorded during it names, whether a turn's start or a request over its
  budget decided it. `bounds`, `spills` and `digests` count results too;
  `drops` and `summaries` count compactions. Each counts what the journal
  holds for the turn, whatever strategy recorded it: `compacts` counts every
  compact view recorded in the turn, also one no request showed the result
  through (another strategy's, or 0.21.0's of a result in a turn the same
  decision dropped). `compacts` is a required key of `ContextReportTurn`,
  so a report stored under 0.21.0 does not decode with the schema: the
  CHANGELOG says so under Migration. A turn lists each result at the
  largest size one of its requests showed it, labelled as that request
  showed it, so a result compacted after a request of the same turn had
  shown it whole stays `whole` in that turn's list, and `compacts` is what
  says so. Never relabel a listed result from a compaction: the label is the
  named request's.

Its unit tests build journals by hand (`src/session/context-report.entity.functions.test.ts`):
a resend, a dropped turn, a summary, a digest, a compact view at a turn's
start, compact views under pressure (two compactions naming three results,
one before the turn's first request and one after it) and a journal
without its `step.ended` are records a short scripted turn does not write.
The sdk's `context-report.journey.test.ts` holds it against what real turns'
requests carried, one result bounded as it was written, one spilled under
pressure before any request had shown it, and two compacted under pressure:
one after a request of its turn had shown it whole, one before its turn's
first request.

The step loop and its event vocabulary (`LoopEvent`) live in
`@xandreed/plugin-agent-loop`, plugin activation in `@xandreed/runtime`,
sessions in `@xandreed/plugin-sessions`, and the composable agent
(`Agent.define`, `Agent.turn`) in `@xandreed/sdk`. Foundry is independent and
supplies deterministic verification when a host chooses it.

`MediaStore` holds immutable decoded bytes under `MediaHash`, their exact
SHA-256, independently of labels and the existing noncryptographic media
fingerprint. `mediaHashOf` hashes arbitrary byte windows (core's pure SHA-256
updates typed arrays in place; an adapter with native crypto uses it); store
operations accept only 1 through `MEDIA_LIMITS.imageBytes` bytes. `put` copies
before waiting, repeated equal bytes reuse their key, and `get` returns a fresh
copy or `None` for a missing blob, never bytes whose SHA-256 is not their key
(damage is `Corrupt`), so callers do not hash them again. Invalid inputs,
unavailable storage and corrupt content are distinct `MediaStoreError.reason`
values. Hashes grant no authorization. `MediaStoreMemoryLive` owns its state
per layer instance: pair it only with an in-memory log, since a durable journal
would outlive its blobs. `mediaStoreConformance` checks hash vectors,
roundtrip, idempotence, missing values, both copy boundaries and byte bounds;
careless self-tests cover each storage/copy promise. This port does not choose
reference envelopes or remove blobs when a session is removed.

`withMediaStore(inner, options?)` decorates a `SessionLog` using the supplied
`MediaStore`. It offloads canonical Media only inside known framework event
data. Exact `MediaEnvelope` roots contain a manifest of own data paths, with
`MediaReference` values at those paths; unlisted nested lookalikes remain
ordinary JSON. All metadata and extras survive, so hydration restores request
part hashes exactly. Invalid/noncanonical media-looking values stay inline.
Unknown event kinds, session headers, metadata and state pass through, and so
do a commit's `incarnation` and every row without an envelope: a read decodes
nothing else of a row, so a newer release's or a damaged payload reaches its
reader as stored. Copy the
whole incoming commit before blob I/O, put every blob before committing,
preserve inner failures and uncertain ACKs, and verify physical commit echoes
against immutable expected bytes. Echoes use the operation's logical snapshot
without fresh blob reads. Apply `through` before hydration, including a
defensive clip for older backends. `SessionReadQuery.media: "references"` (a
key-only reader: the sessions plugin's turn lookups) returns envelope values
with their references in place and reads no blob. A missing or `Corrupt` blob,
or bytes unlike the occurrence's metadata, restore that occurrence with its
stored metadata and `UNAVAILABLE_MEDIA_DATA` (logged): `renderLog` never
chooses such an image, so it stays its label line, and the rest of the log
reads. A malformed envelope fails with `store.decode`; unavailable blob I/O
uses `store.io`. The per-wrapper LRU owns checked byte copies, bounded by both
`cacheEntries` (default 32) and `cacheBytes` (default 32 MiB); either zero
disables caching; a hit compares the occurrence's type, size and fingerprint.
Options outside finite nonnegative safe integers fail with `store.encode`. A
warm cache can mask later external blob corruption until eviction or reopen.
The decorated SessionLog kit and corruption, pass-through, key-only, literal
JSON, copy, cache and ACK regressions are in
`src/session/session-log-media.adapter.test.ts`.

A `SessionLog` gives each create a new `SessionHead.incarnation`, stable for
that session's life to every handle, and refuses a commit naming another
(`SessionCommit.incarnation`) with `SessionMissing`, nothing written, in the
same atomic step as its revision check (`sessionLogConformance` check
`incarnation`). Callers that commit name the incarnation they read.

`Sessions.waiting` is a bounded broadcast with an initial post-subscription
signal, then local commits that change an inbox or an open turn (a turn's own
appends signal nothing). `BeginTurn.takeOver` is `true` or a named turn
(`{ turn, runId }`), which takes over only while that turn is the open one;
`drain`'s `takeOver` applies to its first turn only. The kit checks both
(`takeover-named`, `drain-takeover`). `InboxRunner` executes exactly its borrowed writer and preserves
outcomes/errors, waiting included, without beginning or ending it. Its optional
`afterEnd` runs interruptibly after an end ACK and is advisory: durable outboxes
and reconciliation repair work skipped by a lost ACK or process death.
`WaitingInput` reads durable
queued user input only for owner-observed sessions, with typed storage
failures and an infallible cache. `DrainActivity` counts active attempts.
`ProcessActivity.busy` includes queued input; `inFlight` distinguishes work
shutdown must wait for. `awaitIdle({ queued: false })` performs no queue I/O.

`CommittedTurnObservers` is a multi-provider optional callback service. Its
`notifyCommittedTurn` helper snapshots the acknowledged turn for each
observer, runs them sequentially with a one-second bound and logs failures.
It never changes an authoritative end. The SDK invokes it only after its
owned writer's end ACK; hosts ending borrowed writers invoke it themselves.
`committedTurnObserversConformance` checks copying, order, soft failures and
timeouts; SDK journeys separately check authoritative commit ordering.

`BackgroundWorkers` is a multi-provider lifecycle service independent of
`TaskActivity`: admitted claims and claimed jobs count, idle polling and durable backlog do not.
`ProcessActivity.runningWorkers` is omitted without the service. Worker
`stop` prevents new claims while allowing durable enqueues; `interrupt`
cancels local work and leaves leases recoverable. `shutdownGracefully`
shares one absolute deadline across turn settlement, worker stop, drain
and interruption. `backgroundWorkersConformance` checks application of
the service and its coexistence with task counts. Scope finalizers must
stop workers before their store dependencies close.

Port contracts ship as conformance kits (`*.conformance.ts`, each exported
from `src/conformance/index.ts`; the `ToolRegistry`'s is the sdk's,
`@xandreed/sdk/conformance`, since it runs its turns over `TurnLive`). Run a port's kit against every adapter of it, and
when the port changes, on Node too (`verify:packages`). The kits share
the helpers in `src/conformance.functions.ts` (`check`, `expect`,
`fail`, `freshId`, `headerOf`, `atTime`), the step-loop and turn kits
`sameUsage`, the turn, sessions and memory kits the one-pixel image
`pixelPng`, and the sessions and task kits `kindsOf`, `settles` and
`eventually`; new kits use them too, and only `check` is exported
(`./conformance`). That file is test support for the kits, not an entity's behaviour,
so it is not paired with `conformance.entity.ts`.
Core has no adapter of `Sessions` or `Tasks`: their kits
(`sessionsConformance`, `tasksConformance`) run in the plugins that
implement them (`plugin-sessions` and `plugin-session-sqlite`,
`plugin-tasks`), whose tests also hold the kits' self-tests, careless
wrappers of the plugin's own adapter that must fail; `taskRunnerConformance`
has its self-test here, over fiber runners written in the test. The sdk's
`ToolRegistry` kit runs, with its self-tests, in the sdk's own tests, over
the tool discovery plugin's registry. The step-loop kit gives the loop it
checks a bus and tasks of its own (`makeTurnEvents`, `makeTurnTasks`), so it
needs no turn engine.

The `FileSystem` and `Bash` ports are what agent tools work through. Core
ships the ports, the in-memory `FileSystemMemoryLive` and the two kits; the
disk-backed `FileSystemLive` and `BashLive` live in
`@xandreed/plugin-workspace`, since core does no file-system or process IO,
and run both kits on Bun and Node. `walkGlob`
(`src/domain/file-system.entity.functions.ts`, a sorted walk over the port's
`list`) is how every backend implements `glob`, so it means the same
everywhere; `fs.glob` differs between Bun and Node. `src/workspace` holds
the in-memory backend and the kits. `resolveBashEnv` is the one place the
inherited-environment allowlist is applied. `bashConformance` has no adapter
in core: its self-test runs it against fakes that run nothing.

Images are `Media` values (`src/domain/media.entity.ts`): base64 inline,
checked from their bytes by `mediaFromBytes` / `mediaFromBase64` (the only
image sniffing and header parsing in the repository), within `MEDIA_LIMITS`.
A user's message carries them as `attachments`; `normalizeUserMessage` is
what `Sessions.begin` and `enqueue` store. A taken steer keeps them once in
its raw inbox-marked `Message`; the receipt holds only ids. Render its
images through the same media plan and omission rules, and include its
actual user intent in reference/digest transcripts, ledgers and the latest
message passed to result digesters. `userMessageIn` excludes host
correctives; text transcripts use labels rather than image data. A tool returns them inside its result: the
`ToolResult` entry keeps the encoded result whole and `MediaSlot`s into it
(an image is stored once), checked once by `toolResultMedia` when
`recordTail` writes it, and `renderLog` alone decides which images a request
sends (`RenderOptions.media`; an `OmitMedia` compaction, recorded by the
turn when a provider refuses an image, applies whatever the strategy).
Anything that turns a log into text (search, transcripts, traces,
fingerprints, estimates) goes through `elideMediaData` or
`userMessageText`, never the base64.

`ToolInterceptor` callbacks receive detached encoded JSON and return the
tagged before/after decisions in `domain/tool-interceptor.entity.ts`.
`tool.intercepted` journals each validated decision, including the replacement
input for a rewrite, but carries only the outcome kind for synthetic answers.
An audit proves a decision, not handler execution. Its optional `source`
identifies a loop invocation only when the private lexical receipt owner
was present; direct or older unqualified audits cannot supply that proof.
`toolCallStatesOf` uses this evidence or a final result's invocation id to
keep overlapping calls separate, retaining `Returned` while an after hook
has not produced a raw answer.

The private result receipt spans one call through its raw-result ACK.
Only its owner may claim and ready it; reservation precedes the memory
write permit, and the raw ACK marks it recorded before presentation work.
Foreign callbacks inherit a guard without claim or recording authority.
Matching reentry and duplicate result parts fail before taking the permit,
including parts marked provider-executed. A final `ToolResult` may retain
`interception` metadata with the invocation id and effective encoded input;
`toolInputOf` uses that input (including explicit JSON null) for reopened
views and digests without changing the assistant's original request.

Text the model reads that no user typed uses the frames in
`src/turn/model-text.ts`: `hostNote` for a note the host adds as a
user-role message (`[Host note: …]`, never "system" or "source of
truth"), `framed(tag, text)` for untrusted text such as tool output,
transcripts and summaries (the tag inside it escaped in any case or
spacing), and `clipTo` / `clippedMarker` for a cut that says how much it
dropped. Pin every such text with an exact test beside it, and list it
under "Model-facing text" below.

Skills as files: `harness/skill-files.entity.ts` and its functions read a
tree of `SKILL.md` files without IO (`readSkillFiles`, which never fails and
returns the issues; `skillsFromFiles`, strict) and collect one through the
`FileSystem` port (`collectSkillFiles`, over `glob`). The frontmatter parser
there is the skills' own YAML subset.

A context captured with `Effect.context()` to be provided again later,
around work that runs somewhere else, goes through `replayableContext`
(`src/loop/traceContent.ts`): the services tool handlers, policy and loop
callbacks run with (the registry, `stepRequestOf`, `turnOf`, `runLoop`),
a model layer's dependencies (the models plugin), the services of
`Agent.turn`'s input, bus subscribers (`turn/turn-bus.adapter.ts`) and a live layer's
dependencies (`makeLiveLayer`).
It drops the trace and log state of the place it was captured: the parent
span, so spans nest where the replayed work runs; the span annotations and
links, and the log annotations and log spans, which would replace those of
that fiber (the turn's ids); the captured span's stack frame; and
`CurrentTraceContent`, which is read per call. The one deliberate
exception is `InProcessTaskRunnerLive` (`plugin-tasks`): it starts each
piece of work on a new fiber with the services it was built with, the
only ones that work has, so the work nests under the span current where the
runner was built and reads the trace content set there. The sdk tracer
tests (`packages/sdk/src/agent.trace.test.ts`) fail when a replay
re-parents `tool.*`, handler or `engine.run` spans or drops the turn's ids
from its spans or a tool handler's logs.

Span attributes and log annotations share their keys: `turnAttributes`
(`efferent.session.id`, `efferent.run.id`, `efferent.turn`) and
`sessionAttributes` (`src/session/sessions.entity.functions.ts`), which the
sdk's `traceTurn` (`agent.turn`) and `traceTurnBegin` (`agent.turn.begin`)
put on a turn's spans and logs (`packages/sdk/AGENTS.md`).

Core's own spans are `Effect.fn` and few: `skills.collect`
(`collectSkillFiles`) and the in-memory log's `session_log.<op>`, with
`efferent.session.id` when the operation names a session. Everything else is
`Effect.fnUntraced`: entity functions and decoders; constructors (`make*`,
the bus's included, and `openLogSession`, which `TurnLive` runs between
`traceTurn` and `guardTurn`); helpers called per event or entry
(`publishToolProgress`, the memory log's `append`); and the kits.

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Native memory and document extraction prompts (the memory mode's rules for user identities and independent durable user statements included), output schema with its field descriptions, source frames and candidate budget | `src/knowledge/knowledge-extraction.entity.functions.ts` | exact tests `src/knowledge/knowledge-extraction.entity.functions.test.ts#extraction, review, query and rerank prompts are pinned in full`; `src/knowledge/knowledge-extraction.entity.functions.test.ts#the memory prompt says how to refer to the conversation's user` |
| Part note of an extraction prompt over one window of a longer source (`window`, `knowledgeExtractionWindows`) | `src/knowledge/knowledge-extraction.entity.functions.ts` | exact tests `src/knowledge/knowledge-extraction.entity.functions.test.ts#extraction, review, query and rerank prompts are pinned in full` |
| Independent extraction evidence-review prompt, including supported omissions; bounded malformed-proposal repair prompt, exact in `golden/knowledge-review-repair.prompt.txt` | `src/knowledge/knowledge-extraction.entity.functions.ts` | exact tests `src/knowledge/knowledge-extraction.entity.functions.test.ts#extraction, review, query and rerank prompts are pinned in full` |
| Bounded query-planning and evidence-reranking prompts | `src/knowledge/knowledge-query.entity.functions.ts` | exact tests `src/knowledge/knowledge-extraction.entity.functions.test.ts#extraction, review, query and rerank prompts are pinned in full` |
| Shared reporting messages for all nine model-failure kinds (`modelFailureMessageOf`), used by failed responses and native provider failure descriptions | `src/domain/model-failure.entity.functions.ts:138-148` | exact tests `packages/plugin-agent-loop/src/model-failures.test.ts#semantic model failures before the response gate` |
| Unexpected recorder defect reporting message (`recordCompletion`) | `src/domain/model-call.entity.functions.ts:14` | exact tests `src/domain/model-call.entity.test.ts#recordCompletion contains unexpected recorder defects with a fixed message and original cause` |
| Request-hook context appended to policy context once, with an empty base adding no separator (`applyModelRequestHook`) | `src/turn/model-request-hook.entity.functions.ts:37-41` | exact tests `src/turn/model-request-hook.entity.functions.test.ts#the complete hook context framing and normalized controls are exact` |
| Request-hook invalid-edge and foreign-failure reporting message (`applyModelRequestHook`) | `src/turn/model-request-hook.entity.functions.ts:12` | exact tests `src/turn/model-request-hook.entity.functions.test.ts#invalid hook edges use one exact error text and retain the original cause` |
| Tool-interceptor invalid-edge and foreign-failure reporting message (`toolInterceptError`) | `src/domain/tool-interceptor.entity.functions.ts:7` | exact tests `src/domain/tool-interceptor.entity.test.ts#interceptor failure text is exact and original TurnError identity survives` |
| A host note, `[Host note: …]` (`hostNote`) | `src/turn/model-text.ts:12` | exact tests `src/turn/model-text.test.ts#a host note and a clip marker have one form` |
| The clip marker, `[… N characters clipped]`, and the cut that leaves it (`clippedMarker`, `clipTo`) | `src/turn/model-text.ts:19`, `:40-45` | exact tests `src/turn/model-text.test.ts#a host note and a clip marker have one form`; `src/turn/model-text.test.ts#a clip keeps the text's start and counts what it cut` |
| A frame around untrusted text, `<tag>…</tag>`, with the tag made inert inside it (`framed`, `escapeFrame`) | `src/turn/model-text.ts:33`, `:29-30` | exact tests `src/turn/model-text.test.ts#text inside a frame cannot close or reopen it` |
| The summary handoff: a host note, then the summary framed as `conversation-summary` (`handoffToMessage`) | `src/domain/message-mapping.entity.functions.ts:49-56` | exact tests `src/internal/mapping.entity.functions.test.ts#frames the summary as a host-noted record the summary itself cannot close` |
| Dropped turns' preamble: `[Host note: earlier turns were condensed to free context.]`, then the ledger (a `DropTurns` compaction) | `src/memory/memory-log.entity.functions.ts:97` | exact tests `src/memory/memory-log.entity.test.ts#dropped turns: a host note, then the ledger, in their place` |
| The ledger of condensed turns: `Earlier in this conversation:`, a `- Asked: … — replied: …` line per turn, each clipped with a counted marker, then the subjects the tools reported, framed as `known-subjects` (`ledgerOf`) | `src/memory/memory-log.entity.functions.ts:699-715` | exact tests `src/memory/memory-log.entity.test.ts#a ledger of condensed turns: each request and its reply` |
| The summarizer's transcript: `User`, `Assistant`, `Tool <name>` and `Reply` entries (a reply that repeats its turn's last assistant text left out), clipped and counted (`digestTranscript`) | `src/memory/memory-log.entity.functions.ts:659-691` | exact tests `src/memory/memory-log.entity.test.ts#one entry per line; a line inside an entry is indented`; `src/memory/memory-log.entity.test.ts#a reply that repeats its turn's last assistant text is listed once` |
| A result's artifact lines: `Artifacts:`, then `- <kind> <id> (<type>): <alt>` and `- … N more` (`artifactLines`) | `src/memory/memory-log.entity.functions.ts:169-179` | exact tests `src/memory/memory-log.entity.test.ts#a result's artifacts: a reference line each, at most maxImages, then how many more` |
| An image's label line, `[image omitted: …]` (`mediaLabel`) | `src/domain/media.entity.functions.ts:181-182` | exact tests `src/domain/media.entity.test.ts#a label names the type, the size, the name and the alt` |
| A missing tool result's `ToolInterrupted` failure: no recorded result, possible side effects, check the current state before calling again (`interruptedToolResult`) | `src/memory/memory-log.entity.functions.ts:718-721` | exact tests `src/memory/memory-log.entity.test.ts#rendering an interrupted tool exchange` |
| A condensed turn's actual user instructions: initial request then each inbox-marked steer, continuation lines indented, host correctives excluded (`ledgerOf`) | `src/memory/memory-log.entity.functions.ts:699-714` | exact tests `src/memory/memory-log.entity.test.ts#the condensed ledger keeps each real user instruction in order, with continuation lines indented` |
| Actual steers in the summary transcript: a separate `User` entry with indented continuation lines; image labels in raw, reference and digest transcripts, no host corrective as user intent | `src/memory/memory-log.entity.functions.ts:572`, `:586`, `:659-673` | exact tests `src/memory/memory-log.entity.test.ts#reference, raw and digest transcripts retain actual steers as intent` |
| `recall_context` description | `src/memory/recall.entity.functions.ts:99` | exact tests `src/memory/recall.entity.functions.test.ts#recall_context says what it returns and how to page` |
| `recall_context`'s `locator` and `offset` descriptions | `src/memory/recall.entity.functions.ts:94-95` | exact tests `src/memory/recall.entity.functions.test.ts#recall_context says what it returns and how to page` |
| Spill preview (`[… N more characters kept out of context; call recall_context …]`) (`spillPreview`): one text for a result bounded as it is written (`recordTail`, cut at the bound) and for one spilled under pressure (a strategy's `maintain`); its count and offset are those of the cut, which never splits a surrogate pair and, with `cutAtLineBreaks`, falls just after a line break near the limit: the same text, with that cut's numbers | `src/memory/recall.entity.functions.ts:62` (`previewTo`) | exact tests `src/memory/recall.entity.functions.test.ts#the preview says how many characters it left out and the offset to read them from`; `src/memory/memory-session.test.ts#a result longer than the bound is recorded with its preview before any build shows it`; `src/memory/recall.entity.functions.test.ts#a preview cut inside a pair ends before it, and says so in its count and its offset`; `src/memory/recall.line-cuts.test.ts#with cutAtLineBreaks the preview ends after the last whole row within the limit`; `src/memory/memory-session.test.ts#a result of whole lines is bounded after the last line that fits` |
| `recall_context` page continuation (`[… N more characters; call recall_context …]`) (`continuation`), the line of a page with unread text right after it; a page never ends inside a surrogate pair, ends just after a line break near its limit with `cutAtLineBreaks`, and prints the offset it ended at | `src/memory/recall.entity.functions.ts:146` | exact tests `src/memory/recall.entity.functions.test.ts#a result comes back a page at a time, each page ending with the offset of the next`; `src/memory/recall.entity.functions.test.ts#the pages read from the preview's offset are well formed and join to the whole view`; `src/memory/recall.line-cuts.test.ts#an earlier turn's result comes back in pages that each end after a whole row` |
| `recall_context` page continuation where a page already read holds the text after the page, and unread text follows it: `[… the next N characters are in text you already read, shown above; M more characters after them; call recall_context with locator "…" and offset R]`, R the first offset past the text already read (`continuation`) | `src/memory/recall.entity.functions.ts:149` | exact tests `src/memory/recall.entity.functions.test.ts#a call below a page already read is cut at that page's start, and names the offset after the text already read`; `src/memory/recall.line-cuts.test.ts#a page cut where a page already read starts ends there, inside a row`; `src/memory/recall.entity.functions.test.ts#a call in a gap between two pages already read is cut at the second, and a chain of read pages is passed in one step`; `packages/sdk/src/recall-guard.journey.test.ts#is served only the text it does not have` |
| `recall_context` page continuation where pages already read hold the text after the page up to the result's end: `[… the remaining N characters are in text you already read, shown above]`. It names no offset, and says nothing of the text before the page (`continuation`) | `src/memory/recall.entity.functions.ts:148` | exact tests `src/memory/recall.entity.functions.test.ts#a page cut at text already read up to the result's end says that nothing after it is left` |
| `recall_context`'s `UnknownLocator`, `OffsetOutOfRange` failures | `src/memory/recall.entity.functions.ts:408`, `:411` | exact tests `src/memory/recall.entity.functions.test.ts#a result comes back a page at a time, each page ending with the offset of the next` |
| `recall_context`'s `ResultShown` failure for a result of the current turn shown in part when the call was made: `That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none.` It holds no offset of its own: read after memory shortened the result again, it still leads to where the result's shown form ends (`resultShownMessage`) | `src/memory/recall.entity.functions.ts:369` | exact tests `src/memory/recall.entity.functions.test.ts#a bounded result is refused anywhere in its head, and the reply sends the model to the offset its shortened form shows`; `src/memory/recall.entity.functions.test.ts#after a spill under pressure, the offset the refusal sends the model to is the new notice's`; `src/memory/recall.entity.functions.test.ts#after a compact view took the result's place in a later turn, the refusal leads to the result's start`; `packages/sdk/src/recall-guard.journey.test.ts#a model that asks for shown text is told where to read on from, and reads the next page` |
| `recall_context`'s `ResultShown` failure for a result of the current turn shown whole when the call was made: `This result was shown in full when you asked: nothing of it was left out. If it is shown shortened now, pass the offset its shortened form shows, or offset 0 if it shows none.` (`resultShownMessage`) | `src/memory/recall.entity.functions.ts:370` | exact tests `src/memory/recall.entity.functions.test.ts#a result shown whole is refused at every offset: nothing of it was left out` |
| `recall_context`'s `AlreadyRecalled` failure for an offset inside a page the run read earlier in the turn, with unread text after it: `The text from that offset is in a page you already read, shown above. To read on, pass offset N.`, N the first offset past that page whose text no page already read holds: the page's end, or the end of the last page that follows on from it, as a page's last line names it. It names no turn: read in a later turn, its pages are still above it (`recallRefusalFailure`, `readOnAfter`) | `src/memory/recall.entity.functions.ts:392` | exact tests `src/memory/recall.entity.functions.test.ts#a page already read in this turn is refused, with the next offset`; `src/memory/recall.entity.functions.test.ts#an offset inside a page already read is refused, with that page's end, whatever the offset`; `src/memory/recall.entity.functions.test.ts#an offset inside a cut page is refused with the offset after all the text read from there on, not with that page's end`; `src/memory/recall.entity.functions.test.ts#an offset inside pages read one after another is refused with the offset after the last of them`; `packages/sdk/src/recall-guard.journey.test.ts#a refusal for a page already read, read in the next turn, still has that page above it`; `packages/sdk/src/recall-guard.journey.test.ts#is sent past all of it by one reply` |
| `recall_context`'s `AlreadyRecalled` failure for an offset inside the last page, read earlier in the turn: `The text from that offset is in a page you already read, shown above. That page ends the result.` (`recallRefusalFailure`) | `src/memory/recall.entity.functions.ts:393` | exact tests `src/memory/recall.entity.functions.test.ts#the last page read again is refused as the end` |
| `recall_context`'s `AlreadyRecalled` failure for an offset inside a page that does not end the result, where pages read after it hold the text up to the result's end: `The text from that offset to the result's end is in pages you already read, shown above.` It names no offset and no page as the last (`recallRefusalFailure`) | `src/memory/recall.entity.functions.ts:394` | exact tests `src/memory/recall.entity.functions.test.ts#an offset inside a page with pages read after it up to the result's end is told that the rest is read` |

See the root AGENTS.md for the enforced zero-baseline rules and checks.
