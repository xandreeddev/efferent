# @xandreed/core

Shared schemas, service ports, message codecs and protocol helpers. Runtime
dependencies are Effect and the provider-neutral effect/ai contracts only.
No provider SDKs, filesystem IO, runtime graph, terminal, or host imports.

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

The package has three entries, each an `index.ts` of explicit named exports:

| Entry | Holds | Semver | Who imports it (boundaries) |
|---|---|---|---|
| `@xandreed/core` (`src/index.ts`) | entities, ports, events and journal kinds, `define*`, errors and their guards, model-text frames, References, in-memory adapters | yes | every package |
| `./conformance` (`src/conformance/index.ts`) | every kit of core's ports but the `ToolRegistry`'s (`@xandreed/sdk/conformance`: it runs its turns over `TurnLive`), `ConformanceCheck`, `ConformanceFailure` and `check`, the helper a kit's checks are built with | yes | every package |
| `./internal` (`src/internal/index.ts`) | what first-party packages use of the provider mapping, the stream fold, tool schemas, invocation receipts and the id helper, and what the sdk's turn engine reads of core | none | plugin-agent-loop, plugin-models, plugin-tool-discovery, sdk |

A package reaches `./internal` only when its boundaries layer grants
`core/internal` (the core entry layer's `restricted`). The root does not
repeat what these entries hold: a kit is imported from its entry. A few names
declared in `internal/` are root API too, declared again at the end of
`src/index.ts` (the same value, or a type of the same shape, since a root
entry may not re-export what that folder declares:
`scripts/api-snapshot.ts`): `compileGlob` and its types (the workspace
plugin uses them), and `assistantModel` and `assistantUsage` (documented for
hosts).

The credential and settings stores (`AuthStore`, `SettingsStore`) are not
core's: they are the models plugin's own ports, exported with their kits by
`@xandreed/plugin-models` and its `./conformance`, and they keep the service
keys they were declared with here (`@xandreed/core/AuthStore`,
`@xandreed/core/SettingsStore`). Core names them only in prose:
`HARNESS_CODES` lists their codes (`auth.corrupt`, `settings.corrupt`), as
it lists every package's. Core's own model ports, `ModelCatalog` and
`UtilityLlm`, need nothing of theirs.

`quality/exports-have-consumers` runs on all three entries (`CURATED_ENTRIES`
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
| `core-tests` | test code: `*.test.ts`, `*.bench.ts`, `testing` modules and folders | every layer, and the test libraries `bun:test`, `fast-check` and `effect/testing`, which no other layer imports |

Of the third-party modules, the model and `core` import `effect` alone; the
ports, the logic and the kits also `effect/ai`.

A port that needs a type from a functions file gets it from the entity file
(`LogQuery` is in `memory-log.entity.ts`); what code beneath the sdk's
engine needs stays in core (`sessionAttributes` and `turnAttributes`, which
the in-memory log and the sessions plugin use, are session functions; the
turn's bus is a core adapter).

`ImageResizer` is the host-neutral optional image fitting port. Its input,
target and typed error live in `domain/image-resize.entity.ts`; `fitTarget`
and `scaledSize` are pure. `imageResizerConformance` ships pure valid PNG
fixtures and tests both provider limits, aspect, no upscaling and unsupported
bytes, with careless-stub self-tests. Adapters belong in plugins; core adds
no converter or native dependency. Reuse `imageSizeOf` and `mediaFromBytes`
for output checks; header parsing stays in the media functions.

`BuiltContext.stableMessages` is a required checked prefix length from the same
render as its messages. The memory kit tests the selected run's volatile tail,
reopened history and interrupted-call repair. Request headers save the count
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
Known/Partial subtotals when ANY call exists; Unknown-only and Known-zero
ledgers never fall back. Only no ledger uses legacy `turnUsageOf`. Preserve
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
Its optional `render` scope names the calling run ordinal and tail placement;
the sdk always supplies it. Turn-end always renders with no `StepContext`,
while older callers that omit the scope keep latest-run/tail behavior for
their existing phases. Never remove the durable step context: an earlier
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

`MemorySnapshotData` records a raw render prefix and actual lineage cursors;
`MemorySnapshotCandidate` resolves those cursors to memory entry IDs. The optional
`LogHandle.checkpoint` and `TurnWriter.memorySnapshot` capabilities accelerate
rendering only: keep the full archive, reader, maintenance input and replay path.
`memory.snapshot` is a reserved protocol row, never a `LogBody` or a new `EntryId`.
The shared renderer plan retains exact request dependencies, raw presentation and
digest facts, applicable compactions and scoped step contexts in original order.
`memorySnapshotConformance` checks selection, encoded-prefix integrity, render and
media metadata, and safe full-history fallback; its self-tests exercise careless
implementations. Selected corruption fails with `session.decode`; compatible
snapshots project only after authoritative verification, while other strategies
and newly needed omitted dependencies use the complete archive.

The step loop and its event vocabulary (`LoopEvent`) live in
`@xandreed/plugin-agent-loop`, plugin activation in `@xandreed/runtime`,
sessions in `@xandreed/plugin-sessions`, and the composable agent
(`Agent.define`, `Agent.turn`) in `@xandreed/sdk`. Foundry is independent and
supplies deterministic verification when a host chooses it.

`MediaStore` holds immutable decoded bytes under `MediaHash`, their exact
SHA-256, independently of labels and the existing noncryptographic media
fingerprint. `mediaHashOf` hashes arbitrary byte windows; store operations
accept only 1 through `MEDIA_LIMITS.imageBytes` bytes. `put` copies before
waiting, repeated equal bytes reuse their key, and `get` returns a fresh
copy or `None` for a missing blob. Invalid inputs, unavailable storage and
corrupt content are distinct `MediaStoreError.reason` values. Hashes grant
no authorization. `MediaStoreMemoryLive` owns its state per layer instance.
`mediaStoreConformance` checks hash vectors, roundtrip, idempotence, missing
values, both copy boundaries and byte bounds; careless self-tests cover each
storage/copy promise. This port does not choose reference envelopes or remove
blobs when a session is removed.

`withMediaStore(inner, options?)` decorates a `SessionLog` using the supplied
`MediaStore`. It offloads canonical Media only inside known framework event
data. Exact `MediaEnvelope` roots contain a manifest of own data paths, with
`MediaReference` values at those paths; unlisted nested lookalikes remain
ordinary JSON. All metadata and extras survive, so hydration restores request
part hashes exactly. Invalid/noncanonical media-looking values stay inline.
Unknown event kinds, session headers, metadata and state pass through. Copy
the whole incoming commit before blob I/O, put every blob before committing,
preserve inner failures and uncertain ACKs, and verify physical commit echoes
against immutable expected bytes. Echoes use the operation's logical snapshot
without fresh blob reads. Apply `through` before hydration, including a
defensive clip for older backends. Missing/corrupt selected references fail
with `store.decode`; unavailable blob I/O uses `store.io`. The per-wrapper LRU
owns byte copies, bounded by both `cacheEntries` (default 32) and `cacheBytes`
(default 32 MiB); either zero disables caching. Options outside finite
nonnegative safe integers fail with `store.encode`. A warm cache can mask later
external blob corruption until eviction or reopen. The decorated SessionLog
kit and corruption, literal JSON, copy, cache and ACK regressions are in
`src/session/session-log-media.adapter.test.ts`.

`Sessions.waiting` is a bounded broadcast with an initial post-subscription
signal. `InboxRunner` executes exactly its borrowed writer and preserves
outcomes/errors, waiting included, without beginning or ending it. Its optional
`afterEnd` runs interruptibly after an end ACK and is advisory: durable outboxes
and reconciliation repair work skipped by a lost ACK or process death.
`WaitingInput` reads durable
queued user input only for owner-observed sessions, with typed storage
failures and an infallible cache. `DrainActivity` counts active attempts.
`ProcessActivity.busy` includes queued input; `inFlight` distinguishes work
shutdown must wait for. `awaitIdle({ queued: false })` performs no queue I/O.

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
| Shared reporting messages for all nine model-failure kinds (`modelFailureMessageOf`), used by failed responses and native provider failure descriptions | `src/domain/model-failure.entity.functions.ts:138-148` | exact, `packages/plugin-agent-loop/src/model-failures.test.ts:53-63`, asserted through the loop at `:76` |
| Unexpected recorder defect reporting message (`recordCompletion`) | `src/domain/model-call.entity.functions.ts:14` | exact, `src/domain/model-call.entity.test.ts:94` |
| Request-hook context appended to policy context once, with an empty base adding no separator (`applyModelRequestHook`) | `src/turn/model-request-hook.entity.functions.ts:37-41` | exact, `src/turn/model-request-hook.entity.functions.test.ts:26-32` |
| Request-hook invalid-edge and foreign-failure reporting message (`applyModelRequestHook`) | `src/turn/model-request-hook.entity.functions.ts:12` | exact, `src/turn/model-request-hook.entity.functions.test.ts:38-40` |
| Tool-interceptor invalid-edge and foreign-failure reporting message (`toolInterceptError`) | `src/domain/tool-interceptor.entity.functions.ts:7` | exact, `src/domain/tool-interceptor.entity.test.ts:33` |
| A host note, `[Host note: …]` (`hostNote`) | `src/turn/model-text.ts:12` | exact, `src/turn/model-text.test.ts:6` |
| The clip marker, `[… N characters clipped]`, and the cut that leaves it (`clippedMarker`, `clipTo`) | `src/turn/model-text.ts:19`, `:40-45` | exact, `src/turn/model-text.test.ts:7`, `:22-27` |
| A frame around untrusted text, `<tag>…</tag>`, with the tag made inert inside it (`framed`, `escapeFrame`) | `src/turn/model-text.ts:33`, `:29-30` | exact, `src/turn/model-text.test.ts:11-17` |
| The summary handoff: a host note, then the summary framed as `conversation-summary` (`handoffToMessage`) | `src/internal/mapping.entity.functions.ts:49-56` | exact, `src/internal/mapping.entity.functions.test.ts:384` |
| Dropped turns' preamble: `[Host note: earlier turns were condensed to free context.]`, then the ledger (a `DropTurns` compaction) | `src/memory/memory-log.entity.functions.ts:76` | exact, `src/memory/memory-log.entity.test.ts:409` |
| The ledger of condensed turns: `Earlier in this conversation:`, a `- Asked: … — replied: …` line per turn, each clipped with a counted marker, then the subjects the tools reported, framed as `known-subjects` (`ledgerOf`) | `src/memory/memory-log.entity.functions.ts:555-571` | exact, `src/memory/memory-log.entity.test.ts:381`, `:392`, `:409` |
| The summarizer's transcript: `User`, `Assistant`, `Tool <name>` and `Reply` entries (a reply that repeats its turn's last assistant text left out), clipped and counted (`digestTranscript`) | `src/memory/memory-log.entity.functions.ts:515-547` | exact, `src/memory/memory-log.entity.test.ts:314`, `:328`, `:347` |
| A result's artifact lines: `Artifacts:`, then `- <kind> <id> (<type>): <alt>` and `- … N more` (`artifactLines`) | `src/memory/memory-log.entity.functions.ts:137-147` | exact, `src/memory/memory-log.entity.test.ts:426-428` |
| An image's label line, `[image omitted: …]` (`mediaLabel`) | `src/domain/media.entity.functions.ts:163-164` | exact, `src/domain/media.entity.test.ts:148-150` |
| A missing tool result's `ToolInterrupted` failure: no recorded result, possible side effects, check the current state before calling again (`interruptedToolResult`) | `src/memory/memory-log.entity.functions.ts:573-576` | exact, `src/memory/memory-log.entity.test.ts:439-447` |
| A condensed turn's actual user instructions: initial request then each inbox-marked steer, continuation lines indented, host correctives excluded (`ledgerOf`) | `src/memory/memory-log.entity.functions.ts:555-570` | exact, `src/memory/memory-log.entity.test.ts:616` |
| Actual steers in the summary transcript: a separate `User` entry with indented continuation lines; image labels in raw, reference and digest transcripts, no host corrective as user intent | `src/memory/memory-log.entity.functions.ts:440`, `:454`, `:515-529` | exact, `src/memory/memory-log.entity.test.ts:605`, `:606`, `:607`, `:617` |

See the root AGENTS.md for the enforced zero-baseline rules and checks.
