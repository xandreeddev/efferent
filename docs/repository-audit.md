# Efferent repository audit

Source: `b682e58e9cecf492d19ecead8f95b96ca25c0c29` · 2026-11-09 · Node 24.16.0 · Bun 1.3.0 / 1.3.6.

This is the historical audit of that revision. The fixes, breaking contracts
and subsequent verification are tracked in [the resolution matrix](repository-audit-resolution.md).

This evaluates the checked-out source. Its shared `0.19.2` version markers coexist with Unreleased work; this report does not establish which findings exist in a published package archive. The audit adds this report and local evidence artifacts; production source and public interfaces were not changed.

## Overall assessment

The framework has substantive Effect design and unusually strong durability tests. Scoped resources, explicit state transitions, typed failures, schema decoding, acknowledged persistence and replaceable adapters carry real behavior. The highest-priority findings concern owner isolation, synchronous validation cost, provider input bounds and terminal cleanup. Dead code is localized; architectural and test-contract gaps have greater impact.

The package dependency direction is coherent and is exercised through packed Node and Bun consumers. Core is a broad shared contract package, while runtime remains small. The main architectural weakness is the ownership of invariants that cross packages: authorization versus storage incarnation, provider parsing versus tool execution, and terminal state versus advisory services. Review and tests need to follow those complete paths.

The first remediation priorities are [session owner checking](#fw-10), [incarnation fencing](#fw-11), [linear inference validation](#core-knowledge-1), [bounded provider indices](#e7), [private credential-file creation](#e2) and [model-attempt terminal acknowledgements](#e1).

## Verification and practical limits

| Check | Result |
| --- | --- |
| Frozen workspace install | Pass (`--ignore-scripts` preserved the existing hook setup) |
| Repository typecheck/gates, baseline | Pass; zero findings, empty baseline |
| Foundry self-profile and key-free demo | Pass; demo accepted on attempt 3 |
| Default full suite, Bun 1.3.0 | 4,836 pass, 104 skip, 1 failure: five-second repeated codec-boundary timeout under concurrent audit load |
| Randomized full suite, seed 1109, PostgreSQL configured | 4,928 pass, 4 skip, 9 failures during the resource-pressure interval; all affected release/private-text tests passed a fresh focused rerun (10/10) |
| Randomized full suite, seed 1110, PostgreSQL configured | 4,936 pass, 4 skip, 1 failure: SettingsStore kit restoration/order dependence |
| PostgreSQL/pgvector | 116 pass, 0 fail, 3 files; disposable container used CI's exact image digest |
| Build and packed consumer verification | Pass; public declarations/API, real Node 24.16.0 and Bun 1.3.0 scenarios and reusable kits |
| Bun 1.3.6 proxy matrix | 47 pass, 2 expected conditional skips, 0 fail |
| Documentation generation | No differences across 62 tracked documentation/data files after disposable regeneration |
| Website | 46 pages built; internal files, routes and anchors passed link check |
| Coverage run | Partial: 4,860 pass, 4 skip, 25 fail, 1 error; SQLite reported native disk-write IO failure during resource pressure. Fresh isolated SQLite recheck: 97 pass, 0 fail |
| Fresh-process timing repetitions | Socket closure 20/20 pass; masked process timeout 20/20 pass; corrected stall test 20/20 pass; representative graded codec boundary case 20/20 pass |
| Fresh-process randomized SettingsStore repetitions | 12 failures / 20 seeds (1110–1129), demonstrating order dependence; scoped clear→values reproduction independently confirms tier mutation |

The default and randomized full runs each selected 4,941 tests across 390 files. Base-runtime skips included PostgreSQL integration until configured separately, version-conditional proxy behavior and an optional shared-mount test. The real database run and configured randomized runs supplied the PostgreSQL evidence. No real provider, external exporter ingestion, benchmark accuracy or shared NFS-mount acceptance is inferred from these key-free checks. The website layout finding is based on the complete CSS/source review, not a browser screenshot.

Two audit-only probes outlived their tool calls and consumed CPU; both were identified by their fixture command lines and stopped. Temporary filesystem quota pressure also occurred. These confounders are retained in the interpretation: the codec timeout is a load-sensitive observation, the seed-1109 failures were not reproduced in isolation, and the contaminated coverage run is not reported as a clean pass. No independent product defect is inferred from the sandbox's inability to bind loopback or from the native SQLite disk-write error. The isolated SQLite recheck passed all 97 tests.

Within the partial LCOV run, 556 measured package source files (test scaffolding excluded) reported 39,926/41,881 executed lines (95.3%) and 14,071/14,972 functions (94.0%). These are conditional instrumentation counts, not whole-repository or branch coverage; subprocess/packed execution and skipped/error paths have different coverage visibility. The reproduced assertion and conformance defects show why a high percentage cannot substitute for behavioral evidence.

The repeated codec experiment selected one original graded release fixture in a disposable test copy and ran its unchanged production reader in 20 fresh processes; it did not rerun the redundant twelve-release tiny-byte matrix twenty times. A preliminary stall selector matched no tests; its attempts were discarded and the correct selector was rerun 20 times. Detailed logs and 17 fixture-only reproduction programs are retained under `.artifacts/repository-audit/evidence/`. The disposable database was stopped and removed after verification. Run reproductions from the repository root with an outer OS deadline (for example `timeout 15s bun .artifacts/repository-audit/evidence/<name>.ts`); the DAG probe deliberately includes a size that can exceed its deadline.

## Prioritized finding index

P1 denotes a high-impact correctness, isolation or liveness issue; P2 denotes a material behavior, contract, test-oracle or scaling problem; P3 denotes cleanup or lower-risk maintenance. Conditional triggers and confidence appear in each detailed finding. Design observations without an assigned priority are kept in their subsystem section. The pin-validator observations S2 and ROOT-2 are one finding.

| Priority | ID | Finding |
| --- | --- | --- |
| P1 | [FW-10](#fw-10) | Cancelling a locally sealed turn bypasses its session owner |
| P1 | [FW-11](#fw-11) | Owner checks are not fenced against session replacement for reads/removal |
| P1 | [CORE-KNOWLEDGE-1](#core-knowledge-1) | valid inference graphs make publication exponentially expensive |
| P1 | [E1](#e1) | Model-attempt completion can strand its uninterruptible ACK after a ledger defect |
| P1 | [E2](#e2) | Credential temporary files are readable before their permissions become private |
| P1 | [E7](#e7) | Provider tool-call indices control unbounded allocation and create phantom calls |
| P2 | [CORE-KNOWLEDGE-2](#core-knowledge-2) | entity attribution can satisfy a routine's recurrence threshold |
| P2 | [DATA-1](#data-1) | candidate-only provenance changes bypass comparison (correctness; high confidence) |
| P2 | [DATA-2](#data-2) | inherited object properties are executable CLI commands (correctness/error semantics; high confidence) |
| P2 | [DATA-3](#data-3) | file-log replay copies the growing result on each commit (performance/functional semantics; high confidence static evidence, no scale benchmark) |
| P2 | [DATA-4](#data-4) | repeated tiny-read fixture matrix has a load-sensitive default timeout (test reliability; high confidence structure, observed once by root) |
| P2 | [DOC-DATA-1](#doc-data-1) | website memory protocol and repair behavior lag current source (docs accuracy; high confidence) |
| P2 | [DOC-DATA-2](#doc-data-2) | documented standalone spend composition cannot define an agent (runnable example; high confidence, reproduced) |
| P2 | [DOC-DATA-3](#doc-data-3) | event guide preserves pre-durability event ordering and old platform/error claims (docs contracts; high confidence) |
| P2 | [E10](#e10) | aborting a scripted streaming endpoint leaves its pending Effect running |
| P2 | [E11](#e11) | an accepted render event name injects an SSE resume cursor |
| P2 | [E12](#e12) | provider failure tests silently accept failures of the wrong type |
| P2 | [E13](#e13) | settings kit copies fallback values into the writable tier and its test depends on order |
| P2 | [E14](#e14) | StepLoop awaiting kit fails conforming loops when planning takes over 20ms |
| P2 | [E3](#e3) | Loop prevalidation mutates provider wire arguments and executes effectful codecs twice |
| P2 | [E4](#e4) | Interrupted workspace writes leave full-content temporary files |
| P2 | [E5](#e5) | Corruption of a non-write settings/auth tier still permits successful writes |
| P2 | [E6](#e6) | Lossy result prefixes make the no-progress breaker stop progressing runs |
| P2 | [FOUNDRY-1](#foundry-1) | custom-rule crashes can pass at advisory severity |
| P2 | [FOUNDRY-2](#foundry-2) | synchronous gate construction bypasses defect-to-report handling |
| P2 | [FW-1](#fw-1) | Agent.define rejects two instances of one plugin |
| P2 | [FW-2](#fw-2) | Unconsumed provider/contribution collisions are accepted |
| P2 | [FW-3](#fw-3) | Registry shutdown closes resources under its admission gate |
| P2 | [FW-4](#fw-4) | In-memory FileSystem changes POSIX dot-path meaning |
| P2 | [FW-5](#fw-5) | Functional history folds perform quadratic work |
| P2 | [FW-6](#fw-6) | Reentry rejection test accepts successful reentry |
| P2 | [ROOT-1](#root-1) | the real implementor subprocess outlives Effect interruption |
| P2 | [ROOT-2](#root-2) | model-text citation checks do not establish exact assertions |
| P2 | [ROOT-3](#root-3) | design concern: instruction rules overstate semantic guarantees |
| P2 | [S1](#s1) | stored-shape canonicalization deletes real field schemas |
| P2 | [S3](#s3) | evaluation release fixture writer lacks journal recorder's immutability guards |
| P2 | [WEBSITE-1](#website-1) | mobile documentation is placed in a fixed 240-pixel column |
| P3 | [DATA-10](#data-10) | real-time and ungated scheduler assertions can reject correct session stores (test reliability; high confidence static risk, not observed failures) |
| P3 | [DATA-5](#data-5) | test-only evaluation helpers ship but no host can import them (dead code/docs; high confidence) |
| P3 | [DATA-6](#data-6) | Langfuse constructs each batch by concatenating all events again (performance; high confidence static evidence) |
| P3 | [DATA-7](#data-7) | RAG uses nested absence as a three-state worker protocol (semantic clarity; high confidence) |
| P3 | [DATA-8](#data-8) | eval CLI tests leave their temporary data behind (test hygiene; high confidence) |
| P3 | [DATA-9](#data-9) | SQLite publishes an unused websocket dependency (dead dependency; high confidence) |
| P3 | [DOC-DATA-4](#doc-data-4) | framework overclaims Node verification for Bun-only SQLite (docs validation; high confidence) |
| P3 | [E8](#e8) | An orphaned TUI acceptance fixture remains after application extraction |
| P3 | [E9](#e9) | Models instructions contradict the implemented spend-guard precedence |
| P3 | [FOUNDRY-3](#foundry-3) | the inner-core runner gate omits runtime runners |
| P3 | [FW12](#fw12) | SessionChannel conformance followers have detached, unclosed subscription scopes |
| P3 | [ROOT-4](#root-4) | historical documentation still presents itself as current authority |
| P3 | [ROOT-5](#root-5) | cleanup signals: unused compiler diagnostics require classification |
| P3 | [WEBSITE-2](#website-2) | obsolete landing-page assets and styles remain unreachable |
| P3 | [WEBSITE-3](#website-3) | conformance and telemetry prose retain contradictory API claims |

## Remediation sequence

| Order | Coherent change | Acceptance evidence | Indicative effort |
| --- | --- | --- | --- |
| 1 | Restore owner and incarnation fencing across session fast paths, reads, removal and derived history operations | Wrong-owner sealed cancellation refused; stale reads/removals cannot reach replacement incarnations, across all store adapters | Several days; shared-port compatibility review required |
| 2 | Bound provider stream indices and make inference validation linear | Sparse/invalid indices create no ghost calls or index-proportional allocation; diamond support DAGs traverse each node/edge once and cycles still fail | 1–3 days |
| 3 | Close lifecycle gaps in model completion, registry shutdown, atomic writes and subprocess/scripted transports | Every terminal Exit settles its ACK; finalizers run outside admission locks; interruption releases temporary resources and child/hook work | 2–4 days |
| 4 | Correct progress identity, routine evidence counting, graph instance composition and eval comparison | Long common-prefix results retain progress; only actual stated evidence qualifies routines; graph/provenance negative cases fail consistently | 1–3 days |
| 5 | Repair test oracles and fixture isolation | Mutation probes fail; randomized SettingsStore checks restore/isolate state; timing cases use causal handshakes and scoped cleanup | 1–3 days |
| 6 | Remove repeated history copying and dead paths/dependencies | Output-equivalence tests and work/scaling evidence; packed builds/API/declaration verification preserved | 2–4 days |
| 7 | Reconcile instructions and authored documentation with current behavior | Runtime-valid examples, current engine versions, accurate event ordering/runtime support; source/mirror freshness checks | 1–3 days |

Effort is an engineering estimate, not a delivery commitment. Keep fixes separate enough to review; avoid combining these findings into a framework rewrite. Preserve public service keys, historical fixtures and stored data. An audit changes no public API; proposed storage fencing changes require their own conformance, compatibility and migration assessment.

## Coverage and review method

The inventory contains **1,433 tracked paths**, **26 packages**, **366 package test files**, and **125 Markdown paths** (including instruction aliases). Every tracked path has a disposition in the ledger. Unique authored source, tests, current instructions and current documentation were substantively reviewed in bounded reads; duplicate fixture/generated material was validated by the indicated schemas, exact tests, generation comparisons or packed execution. The historical changelog was reviewed for current policy/Unreleased/0.19.2 and release-history consistency, rather than represented as a line-by-line historical prose review. Brand assets received format/reference checks rather than a visual-design evaluation.

| Code | Meaning | Paths |
| --- | --- | --- |
| R | Substantive authored contents read | 1207 |
| V | Generated, fixture, mirror or compiler artifact validated | 193 |
| A | Symlink alias verified | 28 |
| H | Historical record: current sections read and history validated | 1 |
| B | Brand asset format/reference validation | 4 |

The detailed machine-readable methods are retained in `.artifacts/repository-audit/coverage-ledger.json`; the per-file table below is a compact view. Source under `.git`, dependency installations, ignored runtime data and other projects were outside the source inventory. Review findings distinguish executed reproductions, direct structural reasoning, design concerns and unobserved timing/resource risks; this is an engineering audit rather than a formal proof of absence of defects.

## Framework and shared contracts

### Confirmed findings

<a id="fw-1"></a>

#### FW-1 — P2: Agent.define rejects two instances of one plugin

- Evidence: `packages/sdk/src/agent.adapter.ts:368` constructs the installed definitions as `entries.map(entry => entry.plugin)` while `:373` creates separate instance entries. `packages/runtime/src/graph.ts:37` correctly refuses duplicate installed definitions. `AgentPluginEntry` at SDK `:69` explicitly describes instances with optional IDs.
- Trigger: the host supplies `{ plugin: p, id: "first" }` and `{ plugin: p, id: "second" }`, using the same plugin definition with separate configuration or bindings.
- Observed: `Agent.define` fails with HarnessError/config.graph, `duplicate plugin definition: audit/contributor`, even when both instance IDs differ.
- Impact: the SDK's instance API cannot express graph composition that the underlying graph supports. This limits independent stores/contributions configured from one plugin.
- Correction: deduplicate identical installed definitions by plugin ID before resolveGraph; retain all instance entries. Refuse different definitions claiming one ID rather than arbitrarily picking one.
- Acceptance: two explicitly named instances of a contribution plugin activate separately and concatenate; duplicate instance IDs and conflicting plugin definitions still fail.
- Confidence: high; executed direct `bun -e` reproduction against source.

<a id="fw-2"></a>

#### FW-2 — P2: Unconsumed provider/contribution collisions are accepted

- Evidence: `packages/runtime/src/graph.ts:73` computes contributed keys, but `:74–77` tests the provider/contribution intersection only while visiting required/optional dependencies. `activateGraph` at `:145` then merges contributed array values with whatever was provided under the same key.
- Trigger: one runtime plugin provides a service key and another contributes the same key, with no graph node requiring/optionally reading that key. A host can consume the resulting runtime service directly.
- Observed: the graph resolves and activation yields `["provided", "contributed"]` for an ordinary service seeded with `["provided"]`. A non-array ordinary service is discarded by `asArray` instead.
- Impact: invalid graph state escapes validation and the service's shape/meaning can be corrupted. This violates runtime AGENTS' unconditional “a key is provided or contributed, never both” invariant.
- Correction: reject the intersection of all provided and contributed keys independently of dependency traversal.
- Acceptance: graphs with collision and no consumer, only a host consumer, and a normal graph consumer all fail config.graph before activation; ordinary contributions retain order.
- Confidence: high; direct source reproduction executed.

<a id="fw-3"></a>

#### FW-3 — P2: Registry shutdown closes resources under its admission gate

- Evidence: `packages/runtime/src/live-layer.adapter.ts:43–47` marks closed and runs arbitrary generation finalizers while holding `gate`. `use` acquires that gate at `:48`; acquisition inside `Effect.acquireUseRelease` is masked. Normal release/replacement close scopes outside the gate, as the public comment and runtime AGENTS promise.
- Trigger: a generation has a slow finalizer, and another fiber calls `registry.use` during shutdown. A generation finalizer can also call registry.use itself (for example cleanup routed through the registry).
- Observed: a probe withholding the generation finalizer for 100 ms made `registry.use(Effect.void).pipe(Effect.timeoutOption(20))` return only after 108 ms. The user call could not observe module.closed promptly or honor its timeout. If the finalizer itself awaits use, the gate dependency cycle has no release path.
- Correction: acquire the gate only to set closed and atomically extract generations, release it, then close generation scopes outside the gate.
- Acceptance: held finalizer does not delay a concurrent use refusal; reentrant finalizer call receives module.closed; replacement-during-close tests still prove staged cleanup.
- Confidence: high for blocking/timing reproduction; reentrant deadlock follows directly from the lock dependency.

<a id="fw-4"></a>

#### FW-4 — P2: In-memory FileSystem changes POSIX dot-path meaning

- Evidence: `packages/core/src/workspace/file-system.memory.adapter.ts:42` strips `.` segments and trailing separators before resolution. The traversal at `:80–95` consequently never sees the directory requirement. `FileSystem`'s contract says paths are POSIX and reasons match across backends. The kit tests dot suffixes for removal only.
- Trigger/observed: `makeMemoryFileSystem({"/file":"contents"})` permits `read("/file/.")` and returns contents; it permits `write("/new/.", "created")` and creates regular `/new`. Native Node/Bun filesystem reads/writes of equivalent paths fail ENOTDIR and ENOENT respectively (both executed). The real adapter maps them to NotDirectory/NotFound.
- Impact: memory-backed tests accept invalid operations that production rejects; hosts can observe different state transitions when swapping adapters.
- Correction: preserve dot and trailing-directory requirements during traversal for read/write/append/stat/mkdir/rename. Preserve the separately documented custom remove semantics.
- Acceptance: expand the shared kit with file-dot, missing-dot and trailing-slash cases; run against memory and native adapters on both runtimes.
- Confidence: high; both memory and native reproductions executed.

<a id="fw-5"></a>

#### FW-5 — P2: Functional history folds perform quadratic work

Two independent cases warrant one remediation theme:

1. `packages/plugin-sessions/src/inbox-drain.entity.functions.ts:20–35`: each Started copies all accumulated turns, and each Ended maps all accumulated turns. `inbox-drain.adapter.ts:76` reads and rebuilds full history when a session mark changes. Historical turn count therefore makes the projection quadratic, despite unchanged-session caching. One indicative Bun series of completed turn pairs gave 1,000=24.52 ms, 2,000=72.77 ms, 4,000=206.39 ms, 8,000=604.36 ms. These are observational timings, not stable thresholds.
2. `packages/core/src/memory/memory-log.entity.functions.ts:316–318`: inline media planning groups each distinct older turn by filtering every older image again, before the image cap selects its small output. With one image per historical turn this is quadratic. The same file explicitly promises linear rendering, and core AGENTS requires it.

- Correction: index turns/images once, then produce final immutable arrays; use a persistent indexed structure if mutable local builders remain prohibited. Consider incremental drainer facts for very long histories after the linear fold is correct.
- Acceptance: semantic output equivalence plus counted traversal/scaling regressions; avoid brittle millisecond thresholds.
- Confidence: high for complexity; only drainer path benchmarked.

<a id="fw-6"></a>

#### FW-6 — P2 test gap: Reentry rejection test accepts successful reentry

- Evidence: `packages/sdk/src/turn/model-call-recorder.adapter.test.ts:158–164` asserts that the timeout returned Some, then checks the error code/identity only if the contained Exit is already Failure. It never asserts Exit.isFailure.
- Mutation experiment: in a disposable SDK turn-tree copy, replaced the production same-key reentry rejection (`events.depth`) with Effect.void. Ran the targeted test with `--test-name-pattern 'same-key notification reentry'`. Both direct and child-fiber variants still passed: 2 pass, 0 fail, only 4 expect calls. Original test would execute additional error assertions.
- Impact: the test name and instruction references promise rejection semantics that the assertions fail to establish. This is a demonstrated false positive, not a suspected flake.
- Correction: assert Some(Failure) before extracting cause; separately assert second-call failure identity. Keep the mutation as a review probe until strengthened assertions kill it.
- Confidence: high; mutation experiment reproduced, original sources untouched.

### Design/policy concerns

#### FW-7 — Background event capacity is not a total memory bound

`packages/core/src/turn/turn-bus.adapter.ts:85` uses Queue.unbounded, and its background-handler publications bypass room permits at `:110–112`. This is deliberately documented to avoid producer/consumer deadlocks. However maxDepth bounds ancestry, not breadth: a single handler can emit arbitrarily many siblings at one depth, retaining unbounded queued payloads. The port cannot honestly be described as absolutely bounded. Add a finite overflow/total-event budget with an explicit failure policy if the framework must protect process memory from runaway handlers. Treat this as a resource policy tradeoff, since the current port explicitly permits overflow.

#### FW-8 — Native dependencies are hidden to satisfy a syntactic boundary

`packages/plugin-sessions/AGENTS.md` forbids node: imports and explicitly directs processLiveness to get node:os through process.getBuiltinModule. `process-liveness.adapter.ts:11–14` also reads native host environment through current.env. This has real native coupling even though import-boundary reports show no native imports. ProcessLiveness is already injectable, so a declared platform adapter dependency is clearer and more accurately represented in architecture tooling. This is sanctioned rule circumvention, not an undisclosed accidental import.

#### FW-9 — Public helper aliases bypass origin-based API policy

`packages/core/src/index.ts:437` explains that internal declarations cannot be reexported; the following declarations expose the exact same runtime values through root const aliases. This preserves runtime identity and existing API compatibility, but does not reduce actual coupling to internal implementations. If compileGlob, assistantModel/Usage and tool schema helpers are supported public API, place their definitions in public role modules and reexport directly; keep first-party-only helpers in internal. Review the gate's stated purpose to avoid optimizing declaration syntax rather than architecture.

### Strengths supported by substantive reads

- Port contracts describe expected outcomes, absence, ownership and failures in unusually concrete terms. Sessions/TurnWriter and ProcessPeer specify queueing, acknowledged persistence and interruption behavior, reducing adapter ambiguity.
- Production algorithms already show good examples of semantic functional design: ModelSpend pure transitions under one Ref.modify, WriterPhase transitions with planned I/O applied afterward, and explicit scopes for per-turn tools/tasks.
- Durable request parts, snapshots and model-call billing are detached/validated before asynchronous waits, correlate facts by stable run/turn/step identity, and distinguish durable storage ACKs from notifications.
- The model-call recorder has strong tests for caller/observer mutation, same-key facts, post-storage notification failures and masked caller interruptibility. FW-6 should be corrected without discarding that larger useful suite.
- FileSystem's shared kit has careless-stub checks and native/memory execution. FW-4 shows why extension is needed; it is not evidence that the whole kit is empty.
- Shutdown workers and committed-turn observers explicitly bound arbitrary host callback work and retain authoritative durable facts when advisory notification fails.

### Port/adapters/conformance map

This map identifies implementation and conformance ownership. Every listed core kit has now been substantively read, by this reviewer or the explicitly delegated knowledge/execution reviewer. The assertions do not prove complete behavioral coverage, as the documented gaps demonstrate.

| Contract family | Main implementation(s) | Shared runnable contract |
| --- | --- | --- |
| SessionLog | core memory; session-files; session-sqlite; withMediaStore decorator | sessionLogConformance + sessionLogRecoveryConformance |
| Sessions, TurnWriter, TurnActivity, TurnShutdown, WaitingInput | plugin-sessions SessionsLive/makeTurnWriter | sessionsConformance; activity helper tests; snapshot tests |
| SessionChannel | plugin-sessions in-memory RcMap/PubSub | sessionChannelConformance |
| InboxRunner | sdk agentInboxRunner/taskInboxRunner; host adapters | inboxRunnerConformance |
| ConversationMemory/MemorySession | core openLogSession + memory-window/summary strategies | memoryConformance + memorySnapshotConformance |
| ResultDigester | plugin-memory-digest | memory/digest behavior tests; no standalone generic kit exported |
| StepLoop | plugin-agent-loop | stepLoopConformance |
| ToolRegistry | plugin-tool-discovery | sdk toolRegistryConformance |
| TurnRunner, TurnMemory/Prompt/Toolbox, RunContext | sdk Agent/TurnLive | turnConformance plus sdk lifecycle, request and golden tests |
| TurnEvents/TurnTasks | core makeTurnEvents/makeTurnTasks | core bus tests plus turn/loop kits |
| ModelSpend | core ModelSpendMemoryLive | modelSpendConformance |
| ModelCallRecorder | sdk makeTurnModelCallRecorder | modelCallRecorderConformance |
| ModelRequestHook | host policy + core application helper | modelRequestHookConformance checks application edge |
| ToolInterceptor/receipt authority | host policy + core receipt transitions + registry | plugin-tool-discovery tests + sdk interception journeys |
| ModelCatalog | plugin-models/host catalog | modelCatalogConformance |
| UtilityLlm | plugin-models helper adapter | model/helper-specific tests; no standalone generic kit exported |
| FileSystem | core memory; plugin-workspace native | fileSystemConformance |
| Bash | plugin-workspace native | bashConformance |
| ImageResizer | plugin-workspace CLI/host implementation | imageResizerConformance |
| MediaStore | core memory; plugin-session-files filesystem | mediaStoreConformance |
| MemoryStore, KnowledgeStore, TemporalGraph | core in-memory; plugin-knowledge-postgres | memoryStoreConformance/knowledgeStoreConformance/temporalGraphConformance |
| LongTermMemory, Knowledge | plugin-memory/plugin-rag facade | longTermMemoryConformance/knowledgeConformance |
| Tasks/TaskRunner/TaskExecutor | plugin-tasks + sdk agentTaskExecutor | tasksConformance/taskRunnerConformance + journeys |
| BackgroundWorkers | host/knowledge-worker contribution | backgroundWorkersConformance checks accounting/shutdown edge |
| CommittedTurnObservers | host/capture observer contribution | committedTurnObserversConformance checks notifier semantics |
| Capabilities, IntentMatcher, PermissionGrants, ActionPolicy, SessionEnvironment, KnowledgeNarrowing | host/capability plugins | composing registry/knowledge tests; no separate generic kit for every passive policy |
| ProcessPeer | process-host StdioPeerLive | processPeerConformance + careless stubs + native subprocess tests |

### Verification executed in this stream

- Direct source repros for FW-1/FW-2/FW-3/FW-4.
- Native filesystem comparison for FW-4.
- Structural complexity inspection and indicative drainer timing series for FW-5.
- Temporary-copy mutation probe for FW-6, 2 tests passing despite wrong behavior.
- Every JSON file in assigned tracked scope parsed successfully. Every assigned TS file structurally scanned for exported symbols, ports, test declarations/assertions, native waits and broad catch sites. This is recorded separately from substantive review.
- The verification section records the full suites and CI checks.

### Later coverage update

Completed full substantive reads of all unique authored source, tests, instructions and configuration under packages/runtime and packages/process-host; inspected every protocol fixture row and its exact-byte/schema compatibility test. Updated ledger. No additional confirmed defect was found in the remaining process-host reads. The process-host tests exercise native ACK/drain combinations, cooperative worker shutdown, exact durable lifecycle rows, invalid JSON fallback and control-lane capacity with real composed services.

Instruction correction: add-port skill section 2 requires R=never except callback passthrough, but Sessions.begin, ConversationMemory.open and ToolRegistry.open deliberately require caller-owned Scope.Scope. Clarify no unresolved domain-service requirements while permitting caller-owned scopes; hiding resource ownership to satisfy never would weaken these APIs.

### Later confirmed owner-isolation defect (prioritize before FW-1)

<a id="fw-10"></a>

#### FW-10 — P1: Cancelling a locally sealed turn bypasses its session owner

- Location: `packages/plugin-sessions/src/sessions.adapter.ts:821`. `closeOpen` first invokes `endSealedLocal(address.id, turn)`. When that returns Some, line823 returns success without entering `guarded(address, ...)`, which is where owned(address) normally checks `head.header.owner === address.owner`. The local writers map is keyed only by session id; endSealedLocal at840 checks turn number, not owner. Public cancel at1049 delegates directly to closeOpen.
- Executed reproduction: create session under owner `alice`; begin turn `r`; hold `frameworkDraft("turn.reply", {entry:"r:1",runId:"r",step:0,at:0,body:{outcome:"completed",reply:"answer"}})`; seal it; call `sessions.cancel({id:aliceSessionId,owner:"mallory"},1)` on the same SessionsLive instance. Result was Success `{cancelled:true,pending:0}` and Alice's stored turn.ended count changed from0 to1. Thus the mismatched caller can mutate the other owner's session and observe pending count. An unsealed cancellation goes through guarded and rejects the owner mismatch.
- Impact: cross-owner write isolation depends on whether the reply has been sealed locally. A caller with an invalid owner address can prematurely end the victim's sealed turn, stop post-reply work and learn its pending count. Its ending remains the sealed completed/partial ending, so this probe did not corrupt the final reply or change it to cancelled.
- Correction: perform the authoritative owner check before the local sealed shortcut, and ensure local writer identity matches the whole admitted session address. Do not rely only on process-host owners allowlisting: callers can use Sessions directly, and one host may serve several owners.
- Acceptance: shared sessions kit tests a wrong owner against both an ordinary open turn and a locally held sealed turn; both fail SessionMissing and store no row, change no revision and leave the correct owner's turn active. Correct-owner sealed cancellation still preserves the reply and ends once.
- Confidence: high, direct source reproduction executed against real SessionsLive and core memory log.

<a id="fw-11"></a>

#### FW-11 — P1: Owner checks are not fenced against session replacement for reads/removal

- Locations: `packages/plugin-sessions/src/sessions.adapter.ts:1026` (remove; exact line may shift, inspect the return table), `:1036` (read). Both first call `owned(address)` and then perform an ID-only storage operation. `SessionLog.commit` supports incarnation fencing, but `SessionLog.read/remove` do not accept an expected incarnation.
- Executed read reproduction: wrap the real memory log to pause the first audit.secret read after Sessions' owner check. Instance A begins reading an Alice session. Instance B removes Alice's session and recreates the exact ID under owner Mallory, then commits audit.secret `{secret:"mallory-private-value"}`. Release A's native read: Alice's read succeeds with Mallory's private row. No casted/broken store behavior is required: the wrapper merely delays a conforming operation while concurrent operations run.
- Executed removal reproduction: pause A's authorized removal before the real log.remove. B removes the original Alice session and recreates its ID under Mallory. Release A: the stale deletion removes Mallory's replacement. Mallory get changes Success to Failure.
- Impact: `SessionAddress`'s owner check is vulnerable to a time-of-check/time-of-use gap whenever IDs can be reused. This is stronger than stale turn writes, which are already incarnation-fenced. It affects confidentiality and deletion isolation independently of the sealed-turn shortcut.
- Correction: extend the storage contract/adapter implementations with atomically checked incarnation preconditions for sensitive read/removal paths, or provide equivalent atomic owner-scoped operations. Audit fork/history/lookup paths for the same identity gap; do not claim these additional paths are reproduced. Rechecking after a read can prevent returning replacement data but still performs unauthorized blob hydration; an atomic identity guard is preferable.
- Acceptance: shared conformance race tests pause a stale operation, replace the session under another owner, then release it; stale read/removal fail and replacement data/state remain private/intact. Run over all stores and media decorators. Document the public port addition and compatibility implications.
- Confidence: high; both races executed against two actual SessionsLive instances sharing core's memory log.
- Runnable reproduction: `efferent-audit-incarnation-races.ts` in the parent's ignored evidence directory (source staged under the audit's temporary directory).

### Supplemental ordinary quality review

- All nondelegated core authored source and conformance kits have now been read in full, including the 1,630-line Sessions kit, plus SDK AGENTS.md. Knowledge + core AGENTS coverage is supplied independently by audit_data_plugins; delegated StepLoop/Tasks/SDK ToolRegistry kits remain with audit_execution_plugins. Tests remain pending exactly as recorded in the ledger.
- FW5 corroboration: `packages/core/src/memory/memory-log-render.test.ts:41-55` calls its test linear-growth evidence but times only a single 25,600-entry fixture against 2,500 ms and disables media. This establishes neither growth order nor coverage of the quadratic older-image grouping. Prefer operation-count/scaling checks with image-bearing fixtures; isolate environment-sensitive wall-clock benchmarks.
- Additional performance design concern, static evidence only: `packages/core/src/session/tool-call-state.entity.functions.ts:84-131` repeatedly reconstructs `resultFactsOf(other)` within per-request × per-lifecycle filters, and that helper scans all requests and all memory. The worst-case cost grows much faster than a single fold (potential quartic same-step-call workload). Cache/index result ownership, request intervals and lifecycle identities once. No timing threshold or fresh subprocess reproduction claimed.

<a id="fw12"></a>

#### FW12 — P3: SessionChannel conformance followers have detached, unclosed subscription scopes

**Classification:** verified cleanup omission; resource impact depends on adapter. **Confidence:** high.

`packages/core/src/session/session-channel.conformance.ts:52-56` creates `Scope.make()` and provides `Stream.toPull(channel.subscribe(address))` into it. The helper returns a manual close but never adds that close as a finalizer of the check's surrounding scope. The order, isolation, no-replay and bounded checks never call it, while the release check can also skip closes when an earlier operation/assertion fails. Custom adapters can retain subscriptions/resources after conformance completes; existing root-layer shutdown can hide this omission. Use `Effect.acquireRelease(Scope.make(), scope => Scope.close(scope, Exit.void))`, as the Sessions kit's `scopeOfCheck` already does. No runtime leak reproduction is claimed.

## Execution plugins

### Confirmed defects

<a id="e1"></a>

#### E1 — P1: Model-attempt completion can strand its uninterruptible ACK after a ledger defect

`packages/plugin-models/src/llm/model-completion.adapter.ts:74` claims `Recording` then calls `settleSend` before capturing `recordCompletion` in an Exit. `model-spend-guard.adapter.ts:80` catches expected ledger errors but permits defects through. A host-provided `ModelSpend.release` or `settle` that dies leaves phase `Recording` and `attempt.ack` permanently unset. `completePendingAttempts` then waits on that ACK during provider finalization; `withModelRequestCall` runs that finalization under `uninterruptibleMask`. An unexpected ledger defect can therefore turn a failed model call into an uncancellable turn/shutdown hang.

Reproduced with a fixture ledger whose `release` dies: first completion exited Failure, phase was still `{_tag:"Recording"}`, and `Deferred.isDone(ack)` was false. Repro: `bun .artifacts/repository-audit/evidence/efferent-audit-attempt-ack.ts`. No provider or network required. Confidence: high.

Capture the entire claimed terminal operation, including ledger settlement, in an Exit; always transition phase and resolve ACK with that Exit. Preserve the original defect. Add a defective-ledger regression covering both initial completion and cleanup/repeated completion without hanging the test. Consider explicit service bounds for ledger operations run under interruption masks.

<a id="e2"></a>

#### E2 — P1: Credential temporary files are readable before their permissions become private

`packages/plugin-models/src/storage/json-file.ts:53` writes the temporary auth JSON with default creation permissions, and only then `chmod`s it at line 54. Under umask 022 the file begins as 0644 and contains clear API/OAuth credentials while the write is happening; the containing `.efferent` directory also uses default permissions when created. Final auth.json mode 0600 does not protect this interval.

Reproduced with fixture-only credentials and an independent observer: temporary file mode 0644, 33,554,479 bytes, fixture secret readable; final mode 0600. Repro: `bun .artifacts/repository-audit/evidence/efferent-audit-auth-temp.ts` (subprocess observation needs the non-sandbox execution environment). Confidence: high. Multi-user host confidentiality risk; no actual credential was read or exposed by the audit.

Create the temp file with the requested mode from its first open, using exclusive creation to avoid following a preexisting temp path; preserve atomic rename. Test creation-time permissions rather than only the final file mode. Existing `localAuth.test.ts` checks final mode and misses the interval.

<a id="e3"></a>

#### E3 — P2: Loop prevalidation mutates provider wire arguments and executes effectful codecs twice

`packages/plugin-agent-loop/src/response-gate.entity.functions.ts:78` decodes `call.params` directly. `loop.ts:848` invokes that check before storing the assistant's tool request (`loop.ts:883`); toolkit handling later decodes the same parameters again (`loop.ts:649`). An authored decoder can mutate a nested object reachable through Schema.Unknown, so the durable assistant message and an interceptor's later snapshot lose the provider's original argument bytes. Side-effecting codecs also execute twice.

Reproduced a legal parameter codec that changes `{payload:{n:"provider-original"}}`: decoder count 2, provider raw object changed, first onTail assistant request stored `codec-mutated`. Repro: `bun .artifacts/repository-audit/evidence/efferent-audit-double-decode.ts`. Confidence: high. The interceptor's detached input protection only begins at toolkit.handle, after this earlier decode.

Prevalidation must use detached wire data, and original wire arguments must remain immutable for persistence/interceptor evidence. Decide explicitly whether decoding is once or twice; preferably validate/decode once and carry its result privately to execution. Add an Agent-turn regression using a mutating/effectful codec. Current loop test covers a harmless asynchronous delay, while interceptor mutation tests mostly invoke the registry directly.

<a id="e4"></a>

#### E4 — P2: Interrupted workspace writes leave full-content temporary files

`packages/plugin-workspace/src/write-tools.adapter.ts:48` creates a sibling `.efferent-tmp` file. Cleanup is attached only to stat/rename typed errors with tapError at lines 52/55; interruption and defects do not run those handlers, and a write that fails partway is outside their coverage. Both write and edit call save.

Reproduced with real workspaceTools over the in-memory FileSystem, suspending rename after temp creation and interrupting the write fiber. The target was not created; `.new.txt.<suffix>.efferent-tmp` remained and contained the full fixture content. Repro: `bun .artifacts/repository-audit/evidence/efferent-audit-cancel-write.ts`. Confidence: high.

Register scoped cleanup before any temporary-file IO, using acquireRelease/ensuring/onExit as appropriate. Cover interrupted write/stat/rename and partial write failures; retain the target and avoid cleanup hiding the original failure. Existing write/edit tests cover mode preservation and concurrency but not cancellation at this boundary.

<a id="e5"></a>

#### E5 — P2: Corruption of a non-write settings/auth tier still permits successful writes

The SettingsStore contract (`packages/plugin-models/src/ports/settings-store.port.ts:68`) says backing-data corruption fails load and every write. `settings/localSettings.ts:40` reads only local config inside writeKey, whereas load reads global and local. A corrupt global config plus a valid local config allows set/setRole to succeed although load fails. AuthStore similarly promises every call fails on corruption; `auth/localAuth.ts:131` set reads only loginPath, so a corrupt local override does not block a successful global login write.

Reproduced both variants: settings `{load:"Failure",set:"Success"}`, auth `{load:"Failure",set:"Success"}`; local config changed despite its store being unusable. Repro: `bun .artifacts/repository-audit/evidence/efferent-audit-corrupt-tier.ts`. Confidence: high. The corrupted tier itself is preserved, so this is a false-success/contract mismatch rather than demonstrated corruption loss.

Validate every backing tier required by the published contract before accepting writes, or deliberately narrow the documented promise with compatibility assessment. Extend corruption conformance to every tier; current fixtures damage the write target and therefore miss this branch.

<a id="e6"></a>

#### E6 — P2: Lossy result prefixes make the no-progress breaker stop progressing runs

`packages/plugin-agent-loop/src/loop.ts:410` builds a tool result's progress identity from only the first 300 JSON characters. Two results that differ later in their payload collide. After five such supposedly stale turns the default breaker halts the run, although every call returned a different result.

Repro `bun .artifacts/repository-audit/evidence/efferent-audit-progress-prefix.ts`: a nonpollable advance tool returns `{body:"x".repeat(400),counter:++n}`; with maxSteps 20 the run ends `degenerate-loop` after six calls, whose persisted counters are `[1,2,3,4,5,6]`. Confidence: high. This is reproducible without a network or wall-clock assumption.

Use a canonical full-result hash for identity and reserve clipping for diagnostic text. Add both a long-common-prefix changing-result regression and key-order equivalence cases. Keep pollable-tool exceptions and the current nudge/break thresholds.

<a id="e7"></a>

#### E7 — P1: Provider tool-call indices control unbounded allocation and create phantom calls

`packages/plugin-models/src/llm/chat-wire.entity.ts:53` declares streamed tool-call index through the same unconstrained optional nullable `Schema.Number` used for wire counts. `sse.ts:248` pads an array to `index + 1`, and flush emits every array element. Negative, fractional and infinite numbers decode; a large integer allocates proportionally to a value from the remote provider.

Repro `bun .artifacts/repository-audit/evidence/efferent-audit-sparse-tool-index.ts`: one wire call at index 10 emits 11 tool calls, ten with empty names. A sufficiently large index can exhaust the host process memory; the audit used index10 only and did not run destructive allocation stress. Confidence: high for phantom calls and proportional-allocation code path.

Validate a nonnegative safe integer index and accumulate only actual observed indices in a bounded map. Refuse oversized call counts with a typed provider protocol error; do not manufacture holes into calls. Add negative/fractional/huge/sparse-index tests and out-of-order fragment assembly.

<a id="e8"></a>

#### E8 — P3: An orphaned TUI acceptance fixture remains after application extraction

`packages/plugin-models/fixtures/tmux-model.ts` is the only tracked tmux/PTY fixture. Searches for its path, plugin id, unique screen marker, tool-check and stream-check triggers find only the fixture itself. It serves the removed terminal application and refers to the old read_file tool rather than current workspace read. No compatibility or conformance test consumes it. This is confirmed unreferenced within the repository; undocumented external/manual use is unverified.

Remove it or move it to its actual maintained consumer. It should not be retained as a release compatibility fixture without a compatibility assertion. Confidence: high for repository unreachability, medium for global removability.

<a id="e9"></a>

#### E9 — P3: Models instructions contradict the implemented spend-guard precedence

`packages/plugin-models/AGENTS.md` spend rule says an already ambient guard wins over CompatConfig.spend. `compat.ts:535` always provides the configuration's own guard when set; its API comment and the same AGENTS file's test summary correctly say the config guard wins. compat-spend tests explicitly cover that precedence.

Correct the stale rule while preserving the implemented and tested precedence. Derive shared contract prose where practical rather than repeating policy in contradictory locations. Confidence: high.

### Design and test concerns

- `toChatMessages` in compat.ts copies its complete output array per prompt message; `prepareCachePrompt` in providers.ts similarly appends with `[...state.messages, next]` in a reduce. These pure-looking folds are quadratic in history length. Use an owned local builder or a persistent/vector builder with a linear final materialization. `router.ts` stream telemetry also retains the full reasoning string although only its first 500 characters may be exported and tracing may be disabled; bound diagnostic retention at accumulation. These are code-proven complexity/retention concerns, not measured benchmark regressions.
- Models, agent-loop and discovery carry substantial behavior in large modules (`loop.ts` 1,271 lines; `providers.ts` 767; `router.ts` 701; `registry.adapter.ts` 674; compat 660). Their comments and data types explain many invariants well, but ownership across attempt, provider wrapper, decoder, registry, and durable recorder is difficult to follow. E1 and E3 demonstrate boundary gaps that syntax gates cannot see. Prefer small explicit lifecycle operations and invariants over further filename-only splits.
- Builtin grep is intentionally not time-bounded. `text-search.entity.functions.ts:79` acknowledges that overlapping alternatives such as `(a|a)*` bypass its nested-repetition filter and block the JS event loop. Package instructions accurately call this out, so treat it as a known execution-risk/design decision; host services using nonlocal filesystems default to builtin. Prefer a linear-time engine or isolated execution if serving arbitrary patterns. Do not claim a regular expression timeout inside the same JS thread solves it.
- Socket-cleanup test in `plugin-models/src/llm/openAiCodexWebSocket.test.ts:172` uses a fixed 100 ms sleep before asserting the global open-socket set is empty. This is a timing-risk candidate, not an observed flaky result. Replace with bounded observed closure/fixture acknowledgement. Several transport policy tests intentionally use tiny real deadlines; distinguish time policy tests from incidental waiting.
- `plugin-models/src/settings/localSettings.test.ts:10` and auth fixture setup create home/cwd directories without uniform per-test finalization. Repeated suites leave temporary directories behind. Prefer scoped fixtures/afterEach cleanup and include failure paths.
- ModelsTransport intentionally bridges foreign fetch/WebSocket APIs and exports a Promise-returning fetch and Node Agent type. This is a package-local adapter-edge seam; root blanket guidance that all port methods return Effect/Stream needs to explain this exception instead of encouraging a second wrapper solely to satisfy wording.

### Strengths

- Provider-profile-driven routing, provider-neutral core failures, one HTTP retry owner and explicit post-handoff no-retry semantics are thoughtful. Tests exercise status semantics, exact attempts, body-idle timeouts, accounting, and retries/fallback in combination.
- Real workspace tools use shared FileSystem/Bash contracts and per-path locks; confinement is accurately described as a guardrail, with explicit symlink and permission-mode coverage. Image resizing scopes private temporary directories and registers cleanup before creation, providing a good local example for E4.
- RenderStore contracts describe transaction fencing, generation CAS, idempotency and ownership; conformance includes careless stubs. Task delivery/reconciliation is log-based and uses durable notice identities rather than ephemeral flags.
- Discovery keeps original policy, rewritten policy, audit, actual tool result, and replacement result distinct; it has strong direct tests. Extend those invariants across the loop, as E3 demonstrates.

### Ports/adapters/conformance matrix

| Port | Implementations/consumers | Existing verification | Gap/observation |
|---|---|---|---|
| AuthStore | LocalAuthStoreLive, MemoryAuthStoreLive; router and utility model | authStoreConformance, careless stubs, local/memory tests, packed consumers | Creation-time secrecy and non-write corruption tiers missing |
| SettingsStore | LocalSettingsStoreLive, MemorySettingsStoreLive, roleModelView | settingsStoreConformance, careless stubs, local/memory tests | Corrupt global tier not tested for successful local writes |
| HostCredentials | Supplied by host; consumed by MemoryAuthStoreLive | memory-auth fixture saves/refusals/refresh tests | No independent shipped contract kit; distinguish host persistence semantics from AuthStore |
| ModelsTransport | ModelsTransportLive (Node/Bun/direct/proxy), explicit host fetch | transport tests, modelRequestConformance, Node packed proxy fixtures, Bun-version matrix | Deliberate foreign Promise/Node type seam; no raw transport conformance kit |
| StepLoop (core-owned) | StepLoopLive | core step-loop kit, package model-failure/stream/run tests, SDK journeys | Add mutating codec through complete Agent path |
| ToolRegistry (core-owned) | ToolDiscoveryLive/makeRegistry | SDK toolRegistryConformance and careless registries, policy/interceptor journeys | Loop prevalidation precedes registry's immutable evidence boundary |
| FileSystem, Bash, ImageResizer (core-owned) | workspace local adapters; ImageResizer CLI | core kits, packed Node/Bun; optional CLI execution | Write-tool temp lifecycle is above port kits and needs behavior-level regression |
| Tasks/TaskRunner/TaskActivity (core-owned) | TasksLive, InProcessTaskRunnerLive | core kits, careless stubs, SDK tasks journey, packed Bun/Node | Dense cross-session control path deserves durable failure-boundary tests |
| RenderStore/Render | makeMemoryRenderStore/MemoryRenderStoreLive, RenderLive/openSurface | renderSurfaceConformance, careless store self-tests | Preserve host transaction semantics on adapter implementations |
| JournalTail/RenderFeed | SessionsJournalTailLive, makeRenderFeed/RenderFeedLive | feed/transport kits, careless tails/feed fixtures, SDK events journey | Bounded backlog/live merge covered |
| UiOutputAdmission/Journal/Context/UiOutput/Tools | Host admission/journal/context; UiOutputLive/toolkit | render-output direct tests and packed API consumers | Mostly host seams; no standalone journal kit equivalent to RenderStore |
| Internal References | CurrentModel*, CurrentPromptCacheFrame, CurrentTaskWriter | behavior tests via owning adapters | References are scoped inputs, not interchangeable IO ports |

### Additional verified defects from continued authored pass

<a id="e10"></a>

#### E10 — P2 — aborting a scripted streaming endpoint leaves its pending Effect running

- **Location:** `packages/plugin-models/src/transport/scripted-chat.adapter.ts:39-53`.
- **Category/confidence:** verified resource/cancellation defect; high confidence.
- **Trigger/impact:** supply a `beforeChunk` hook that waits or owns resources, then abort the request or cancel the response body. `pull` runs the hook using detached `Effect.runPromise`; abort/cancel closes the Web stream and changes its cursor but never interrupts that Effect. Pending hook finalizers do not run. This shipped testing adapter can leak fibers/resources and creates misleading cancellation evidence for consumers.
- **Evidence:** `.artifacts/repository-audit/evidence/efferent-audit-scripted-abort.ts` uses `Effect.never` with a finalizer as the hook and aborts after entry. Output: `{"bodyReadRejected":true,"beforeChunkFinalized":0}`.
- **Recommendation:** own each stream's hook fiber or abort controller and interrupt it on request abort and reader cancellation; regress finalizer completion, including an already-running pull. The shipped `scripted-chat.adapter.test.ts:215` abort case itself uses `beforeChunk: () => Effect.never` and checks only that the reader rejects, so it does not detect the still-running hook.

<a id="e11"></a>

#### E11 — P2 — an accepted render event name injects an SSE resume cursor

- **Location:** `packages/plugin-render/src/domain/feed-frame.entity.ts:4`; `packages/plugin-render/src/domain/feed-frame.entity.functions.ts:42`.
- **Category/confidence:** verified wire/schema defect; high confidence.
- **Trigger/impact:** event names use trimmed nonempty strings that permit embedded CR/LF, then interpolate directly into an SSE field. A valid `FeedRecord` with event `fixture\nid: 999` and sequence 1 encodes another `id` line; decoding the resulting wire reports sequence 999. A host deriving names from data can therefore corrupt a client's resume cursor, despite the DTO passing its schema.
- **Evidence:** `.artifacts/repository-audit/evidence/efferent-audit-sse-event-name.ts` demonstrates the valid record's encoded wire and decoded cursor 999.
- **Recommendation:** use a shared protocol-safe event-name schema that rejects CR/LF, and pin roundtrip/injection cases for both records and transient frames.


<a id="e12"></a>

#### E12 — P2 — provider failure tests silently accept failures of the wrong type

- **Location:** `packages/plugin-models/src/llm/provider-client.adapter.test.ts:37` (same pattern throughout that file); HTTP-specific guards at `:45` and `provider-failure.adapter.test.ts:31`/`:65`.
- **Category/confidence:** verified test false-positive branch by code inspection; high confidence.
- **Trigger/impact:** the test first asserts `result._tag === "Failure"`, then returns successfully if `!AiError.isAiError(result.failure)`. An adapter regression returning any other expected failure satisfies the only executed assertion and skips classification, identity, HTTP evidence, usage, request-count and redaction assertions. Similar unasserted `"http" in reason` guards skip evidence checks.
- **Evidence:** the guard at line 38 has no preceding AiError assertion; the first test's remaining expectations are all below it. Nearby resilient HTTP tests already explicitly assert the type before narrowing.
- **Recommendation:** assert `AiError.isAiError(...)` and required HTTP evidence before the narrowing guard, or use a helper that throws/fails on the unexpected branch. Keep normal result-tag narrowing after its assertion.

<a id="e13"></a>

#### E13 — P2 — settings kit copies fallback values into the writable tier and its test depends on order

- **Location:** `packages/plugin-models/src/settings/settings-store.conformance.ts:57`; `packages/plugin-models/src/settings/memory-settings.adapter.test.ts:34`.
- **Category/confidence:** verified conformance restoration defect and observed order-dependent test failure; high confidence.
- **Trigger/impact:** `restoring` snapshots only effective values. After a check changes a local key, it restores the global fallback with `set(Some(before))`, creating a local override that did not exist before. The `values` check thus leaves local budgetMillis30000. The later `clear` check removes it in normal order, hiding the mutation. Random order with values after clear fails the physical-file restoration oracle. Copying a fallback can also prevent later global edits from applying to a store the kit was meant to leave untouched.
- **Evidence:** root's full seeded suite with seed1110 failed this exact assertion with `{budgetMillis:30000}` versus `{}`. Scoped reproduction `.artifacts/repository-audit/evidence/efferent-audit-settings-restore.ts` runs clear then values, both pass, and prints `afterClear:"{}", afterValues:"{\n  \"budgetMillis\": 30000\n}"`.
- **Recommendation:** support adapter-aware snapshot/restoration for tier fidelity, or explicitly limit the kit's restoration promise to effective values and run it on disposable fixtures. The port alone cannot distinguish an absent local key from an explicit override equal to the fallback. Give each registered check its own fixture; test aggregate restoration by explicitly executing the whole kit within the test's own fixture rather than relying on the runner to execute earlier tests first.

<a id="e14"></a>

#### E14 — P2 — StepLoop awaiting kit fails conforming loops when planning takes over 20ms

- **Location:** `packages/core/src/turn/step-loop.conformance.ts:1237`.
- **Category/confidence:** verified timing-dependent conformance false negative; high confidence.
- **Trigger/impact:** background work sets done after a real20ms sleep before planning/model/tool work begins. The kit demands two completion verdicts, first false then true. With ordinary planning/provider latency greater than20ms, the task is already done at the first completion and a conforming loop correctly publishes only one true verdict, failing the kit. Every adapter invoking this public kit inherits the timing assumption.
- **Evidence:** `.artifacts/repository-audit/evidence/efferent-audit-awaiting-clock.ts` runs only this check: StepLoopLive passes; the same loop with request.plan delayed50ms fails `ConformanceFailure(awaiting)` with only `[{complete:true,awaiting:[],facts:{}}]`. No external IO is involved.
- **Recommendation:** hold task completion with a Deferred until the first incomplete verdict is observed, then release it and verify the join/re-evaluation. Avoid elapsed-time coordination in a semantic ordering check.

### Additional test quality and documentation observations

- `auth/credential-input.entity.functions.test.ts:14` defines a local identity function and tests that function's reference equality; no production storage behavior is exercised. Remove the vacuous case or drive a real store.
- The Echo declaration case in `llm/compat.test.ts` says it pins the gateway's JSON-schema mapping but asserts only `Tool.isUserDefined`; inspect the outbound tools JSON instead.
- The live SSE-dribble test in `llm/sse.test.ts:636` depends on a real300ms dribble and a >150ms spread, and closes its server only after the awaited operation, without finally cleanup. A failed/timed-out assertion can retain the listener. Use an observed first-delta barrier and unconditional cleanup. `resilient-http-client.adapter.test.ts` also has an incidental <150ms real-time retry fallback assertion, although most policy tests correctly use TestClock.
- `plugin-workspace/src/bash.adapter.test.ts:72` starts a quiet infinite background writer with killBackground false, and sends its cleanup kill only after status/assertion work succeeds. An earlier failure skips the kill; temp-directory removal does not stop an escaped background process. Register PID cleanup immediately in an unconditional fixture finalizer. This is a code-evident cleanup risk; no leaking process was deliberately spawned for this finding.
- Render transport/feed conformance uses real60ms sleeps inside150ms connection lifetimes and30/40ms lag fixtures. These are unobserved load-sensitive risks; use TestClock or ready/append handshakes for semantic event ordering.
- Website `concepts/providers.md:289` and `:293` teach `String(error)` interpolation into AuthError messages for host vault errors, conflicting with the repository's preserved-cause guidance and potentially copying a host error's sensitive text. AuthError currently has no cause field. Prefer stable, nonsecret public messages and a deliberate diagnostic/cause contract. This is a documentation/port design concern, not a reproduced leak with real secrets.
- The authored website plugin pages accurately explain context versus journal versus workspace files, memory/embedding dependencies, guardrail limitations, task restart ownership and model fixture limitations. Their generated schema sections are intentionally duplicated artifacts, not dead authored code.

## Data, memory, stores and evaluation

### Findings

<a id="data-1"></a>

#### DATA-1 — P2: candidate-only provenance changes bypass comparison (correctness; high confidence)

`packages/evals/src/domain/evaluation-run.entity.functions.ts:45` filters and compares only baseline fingerprint entries. A candidate adding `protocol:retrieval` or `fixture:*` is accepted; reversing the same runs reports a mismatch. Concrete valid-run reproduction produced `forward:[]` and `reverse:["Fixture or protocol provenance differs"]` for identical graded runs with baseline `{}` and candidate `{"protocol:retrieval":"2"}`. Comparisons can silently treat changed fixture/protocol inputs as equivalent. Compare the canonical union of both provenance key sets and test added, removed and changed keys, including symmetry.

<a id="data-2"></a>

#### DATA-2 — P2: inherited object properties are executable CLI commands (correctness/error semantics; high confidence)

`packages/evals-cli/src/cli.adapter.ts:254` reads `app.commands[line.command]` without checking own properties, then calls and yields a truthy value. Normal app `commands:{}` inherits Object.prototype. Running `evaluationCli(["constructor"], {config:fixture(),output:()=>{}})` in a subprocess returned Exit Success0; `toString` terminated with `Fiber.runLoop: Not a valid effect: [` rather than an EvaluationError for an unknown command. This can break a host embedding the CLI and accepts invalid commands as successful. Guard with Object.hasOwn, preserve explicit same-named own commands, and exercise constructor/toString/hasOwnProperty in command tests. Telemetry's priceOf already makes the analogous own-key check.

<a id="data-3"></a>

#### DATA-3 — P2: file-log replay copies the growing result on each commit (performance/functional semantics; high confidence static evidence, no scale benchmark)

`packages/plugin-session-files/src/session-log.adapter.ts:532` eagerly builds an array covering every revision; `:543` reduces the entire array even after `events.length >= limit`; `:550` spreads the entire accumulated event list on every matching commit (and slices it), with analogous prepending for reverse reads. Replaying k one-event commits with no limit copies O(k²) event references. A newest-one read still allocates/traverses O(total revisions), despite avoiding old file opens. Long-lived sessions pay this on restore/recall. Retain bounded IO and chronological semantics while collecting commit chunks and flattening once, and use a lazy/early-ending revision iterator for limited reads. Test work/allocations or benchmark replay growth, plus existing after/through/kinds/from-end behavior. This is a concrete example where surface immutability obscures a poor algorithm.

<a id="data-4"></a>

#### DATA-4 — P2: repeated tiny-read fixture matrix has a load-sensitive default timeout (test reliability; high confidence structure, observed once by root)

`packages/evals-cli/src/adapters/evaluation-store.fs.adapter.test.ts:35` expands all12 released fixtures into executed and graded runs. `:69-75` rereads each sequentially with byte chunk sizes1,2,3,7,13,19,20,4096, plus normal and64-byte reads, under Bun's default5s test deadline. Every graded fixture has two trials and approximately9.3KB JSON; every executed fixture approximately3.7KB. A single graded test therefore performs roughly18k native reads, and the identical-size12-release matrix repeats hundreds of thousands of reads. The full run observed one5s timeout under concurrent audit load; the representative graded case subsequently passed all20fresh-process repetitions. This is a load-sensitive observation with the verification limitations described above. Keep every historical fixture's compatibility/normal-byte read, and run exhaustive tiny boundaries over one representative adversarial file and the pure incremental codec; size a filesystem integration timeout intentionally.

<a id="data-5"></a>

#### DATA-5 — P3: test-only evaluation helpers ship but no host can import them (dead code/docs; high confidence)

`packages/evals/src/evaluators/llm.ts:8` and `packages/evals/src/evaluators/pairwise.ts:8` have no runtime consumers or public entry exports; only llm.test and assessment.test import them. The package guide explicitly says they are unexported. `docs/composable-evaluations.md:178` nevertheless presents assessBothOrders as available. Tests and span/model-text pins keep an unreachable legacy subsystem alive. Decide whether these are supported host APIs; export/document/test via the package entry if so, otherwise remove both helpers and orphan tests/pins/ROLELESS entries and stale prose. Their direct exports are not by themselves a live production path.

<a id="data-6"></a>

#### DATA-6 — P3: Langfuse constructs each batch by concatenating all events again (performance; high confidence static evidence)

`packages/evals-langfuse/src/langfuse-export.adapter.ts:88-92` uses `[...traces,...scores].slice(...)` inside Array.from's callback for every50-event batch. For N events it recreates N entries ceil(N/50) times before network dispatch, O(N²/50) temporary copying. Large eval exports amplify allocation and GC despite bounded request concurrency. Concatenate once then chunk or iterate slices; pin batch limits, stable remote ids and event order. Existing exporter timeout starts around the effect but synchronous array construction still monopolizes the JS thread until it yields.

<a id="data-7"></a>

#### DATA-7 — P3: RAG uses nested absence as a three-state worker protocol (semantic clarity; high confidence)

`packages/plugin-rag/src/rag-engine.adapter.ts:112` uses `Option<Option<KnowledgeJob>>`: None is no claim, Some(None) is completed, Some(Some(job)) is retry; nested Option.match at around160 reconstructs those meanings. Equivalent memory processing at `packages/plugin-memory/src/memory-engine.adapter.ts` already uses named Empty/Complete/Retry decisions. Use the same tagged union locally. No behavior defect claimed, and this does not justify a generic worker framework; semantic names make lease/retry/shutdown state inspectable and avoid accidental inversion.

<a id="data-8"></a>

#### DATA-8 — P3: eval CLI tests leave their temporary data behind (test hygiene; high confidence)

`packages/evals-cli/src/adapters/evaluation-store.fs.adapter.test.ts:43` makes a new system temp directory throughout the matrix, with no rm import or teardown. `packages/evals-cli/src/cli.test.ts` and `src/run-main.adapter.test.ts` similarly leave mkdtemp artifacts. Large/cyclic-codec regressions and many release cases accumulate files on developer and persistent CI runners. Use a shared scoped temp-root helper with release even after failed assertions; retain signal-process teardown. No disk-full flake was observed.

<a id="data-9"></a>

#### DATA-9 — P3: SQLite publishes an unused websocket dependency (dead dependency; high confidence)

`packages/plugin-session-sqlite/package.json:13` lists ws although no file in that package imports it. The package uses bun:sqlite, core and Effect; the workspace boundaries grant ws only to the models plugin. Remove this direct dependency unless a concrete published runtime path requires it; do not rely on unused SQLite installation to satisfy another package's dependencies.

<a id="data-10"></a>

#### DATA-10 — P3: real-time and ungated scheduler assertions can reject correct session stores (test reliability; high confidence static risk, not observed failures)

`packages/plugin-session-files/src/session-log.adapter.test.ts:142` asserts an immediately refused call takes<100ms wall clock. An unrelated blocked CPU or paused process exceeds it despite correct IO admission; use the fault seam/native call count and TestClock for policy rather than narrow elapsed upper limits. `packages/plugin-session-files/src/session-recovery.test.ts:137` and `packages/plugin-session-sqlite/src/session-recovery.test.ts:181` require at least one CAS conflict, but release two processes before their independent loops, with no handshake forcing both to read the same revision. A scheduler may run one to completion first. Keep the real400-update check and force the first shared-head race through a barrier when conflict coverage is mandatory. SQLite ticker>20 in a1s lock test similarly measures scheduler opportunity; distinguish responsiveness from host load.

### Ports, adapters and conformance matrix

| Port / role | Owned adapter(s) | Contract evidence | Assessment |
|---|---|---|---|
| SessionLog | files, SQLite | core sessionLogConformance + recoveryConformance in both; Sessions facade conformance; corruption, lost ACK, incarnation and real-process kill/race tests; packed Node files and Bun SQLite owned by root | Strong interchangeability and recovery coverage. Files has replay scaling concern. SQLite busy retry is Effect sleep, not synchronous wait. |
| MediaStore | directory SHA256 blobs | MediaStore conformance plus Buffer copy/mutation, concurrent publication, corruption quarantine, oversized read, orphan sweep, cancellation | Strong edge ownership; media layout independent from session layout. |
| MemoryStore / KnowledgeStore / TemporalGraph | PostgreSQL scoped pool; logical memory vs RAG domains | shared store and graph kits; independent pools/CAS, lease/stage/reopen, filters-before-limit, embedding profile checks, recursive forget, index addition, corrupt row decode; root116pass real pgvector run | Correct publication transaction and scope locks; no model calls inside SQL transaction. Private snapshot's4queries are wrapped by public transaction+scope lock. |
| LongTermMemory | MemoryLive / MemoryPluginLive | longTermMemoryConformance with in-memory and PostgreSQL store; worker cancellation/heartbeat and full Agent capture/recall journeys | Strong owner, evidence, retry and temporal behavior assertions. |
| Knowledge | RagLive / RagPluginLive | knowledgeConformance plus tools/narrowing journeys, graph fallback/retries, helper context and staged restart tests | Strong data-vs-graph contract; decision representation needs clarity. |
| ConversationMemory | window, summary | shared SDK memoryConformance and composed/golden journeys (outside owned source); direct calibrated policy and per-session paid summary attempts | Pure policy/adapter split is useful. Summary paid-frontier phase explicit; storage TurnError identity retained through helper timeout cleanup. |
| ResultDigester | MemoryDigestLive | direct exact prompt/key filtering, bounded timeout tests and composed SDK golden | Model protocol framed and pinned; no external call evidence. |
| MemoryCapture + Admission setting | MemoryCaptureLive; Context.Reference default Admit | exact capture evidence, checkpoint malformed/forward ACK, partial enqueue/lost ACK, page limits, refusal/failed decision and1320-line Agent journeys | No shipped capture-specific kit; direct behavioral coverage strong. Admission is a default-valued policy reference, not a missing provided dependency. |
| EvaluationRunStore | file store | native codec equivalence property tests, byte boundaries/Unicode, atomic replace/rollback, concurrent append locks, signals/SIGKILL evidence | No reusable public conformance kit; robust direct tests with excessive duplicated IO. Separate processes correctly require separate result directories. |
| EvaluationExport | Langfuse, LangSmith | shared exportableScores unit mapping; literal stable ids, key-free HTTP stand-ins, repeat/409 behavior, deadlines/cancellation | No shared public EvaluationExport conformance kit; mapping implementations differ and edge validation not centrally proved. Real services unverified. |
| EvaluationServices / scoped execution / projector / grading / semantic judge | typed registrations, runnable bridge, native LLM/Jev judges | typed-port compile checks, scoped release/late callbacks/timeouts, grader calibration, run spend, fixture compatibility and trace assertions | Core API boundary useful; generic world never leaks into stored output. Several port methods require Scope, TrialRecorder or ModelSpend, unlike add-port's blanket R=never instruction. Treat scoped factories/execution as a documented exception or bind once into R-free methods; current dependency types are explicit, not hidden unknown. |
| Telemetry event observer / exporters | TurnTelemetryLive, OTLP Effect services, LangSmith tracer decorator | local collectors, actual Effect LanguageModel native spans, ledger replay vs fresh billing, span policy reparenting/redaction, headers/secret validation and inherited kind tests | No custom new service port needed. Metrics use isolated registries; parent span captured at layer build. Live LangSmith is explicitly UNVERIFIED in guide. |

### Qualitative architecture / Effect assessment

Most Effect usage carries semantic work: scoped leases/resources, typed foreign errors, bounded concurrency and cooperative cancellation; extraction records stay data until fenced publication. Config decode, source filtering before limits and explicit original evidence are materially stronger than syntax-only functional rules. Model-facing text is systematically framed and exactly pinned; tests assert the model's requests, journal events and durable results, not merely that helpers returned.

The no-loop/no-let gates do not establish functional quality. DATA-3 and6 are real allocation consequences of repeated immutable copying; DATA-7 shows Option used beyond meaningful absence. Conversely locally-owned Map/array mutation inside an adapter is not inherently a defect; forcing every such construction through Ref would add an effect without domain meaning. Avoid changing all branches to Match when ordinary non-union boolean branching is clearer. Pure window/summary decisions and tagged paid-attempt state are good patterns to preserve.

Instruction gaps: add-port demands R=never, a shipped kit, careless-stub self-test and packed Node verification for every adapter, while evals deliberately exposes scoped factories and ten package-owned port modules with direct integration tests instead of public kits, and SQLite is intentionally Bun-only. Document precise exceptions at the architecture/skill source; a promise that instructions impose every property today is inaccurate. Several package opening descriptions say 'imports core only' although Effect is also imported; this is boundary shorthand, not a dependency regression.

Residual verification: root's PostgreSQL116pass confirms actual SQL behavior. No remote provider/exporter ingestion or real NFS mount was exercised by this child. Root broad suite and packed checks provide execution evidence; static complexity findings are not throughput measurements. No confirmed tenant escape, stale-lease publication, source resurrection or telemetry content-consent defect found in owned code.

## Knowledge validation

<a id="core-knowledge-1"></a>

### CORE-KNOWLEDGE-1 — P1: valid inference graphs make publication exponentially expensive

- **Location:** `packages/core/src/knowledge/knowledge.entity.functions.ts:428-431`, invoked by the final condition at line 454.
- **Category/confidence:** availability/performance; confirmed, high confidence.
- **Trigger:** existing active inferred memories form a valid shared DAG, such as memory `m_i` supported by `m_(i-1)` and `m_(i-2)`. A later stage adds just one more node. All nodes have exact valid provenance; there is no cycle.
- **Evidence:** `cyclic` remembers only the current path, searches the complete memory array at each recursion, and revisits every shared subgraph. A valid 28-node DAG took approximately 376 ms; 32 nodes took 2,629 ms. In an isolated process with a 12-second external deadline, 36 nodes did not finish after the preceding 28/32 cases (external exit 124). Earlier measurements were 16 nodes ~7.5 ms, 20 ~25 ms, 24 ~67 ms. This is exponential path enumeration, not just a large-snapshot scan.
- **Impact:** normal accumulating knowledge can synchronously stall the JavaScript event loop. Both stage and publish validate; the memory adapter does so inside `Ref.modify` (`knowledge.memory.adapter.ts:164,179`) and PostgreSQL does so during the scoped transaction (`plugin-knowledge-postgres/src/knowledge-store.adapter.ts:113`). Lease heartbeats, cancellation and Effect timeouts cannot preempt this synchronous recursion.
- **Recommendation:** build an id-to-memory map and use a completed/visiting/unvisited graph traversal, memoizing completed nodes. Preserve rejection of self/transitive cycles and inactive/retiring supports. Add a valid shared-DAG test that establishes bounded traversal work, rather than a tight machine-dependent elapsed-time assertion. Current tests cover one tiny cycle and routine thresholds, not DAG work amplification.
- **Reproduction artifact:** `.artifacts/repository-audit/evidence/efferent-knowledge-dag-repro.ts` contains code suitable for evaluation from the repository root. Timings are local diagnostic measurements, not a portable performance promise.

<a id="core-knowledge-2"></a>

### CORE-KNOWLEDGE-2 — P2: entity attribution can satisfy a routine's recurrence threshold

- **Locations:** `packages/core/src/knowledge/knowledge-extraction.entity.functions.ts:484`; `packages/core/src/knowledge/knowledge.entity.functions.ts:435`.
- **Category/confidence:** domain correctness/provenance; confirmed, high confidence.
- **Trigger:** one stated supporting memory has `mentions: [said]` but its complete provenance also cites two historical entity-attribution sources. Those are three source episodes, but only one episode states the observation. A new inferred routine supports that one memory.
- **Evidence:** both gates count supporting memories' full `provenance`, while the immediately adjacent staging helper correctly uses `knowledgeMemoryMentions` to construct inferred mentions (lines 472-474). The exact reproduction stages this routine without notes and publication returns `Option.none()` (accepted). `knowledgeMemorySupport` reports the supporting memory has one episode and the new routine has only two episodes including its new own source. Existing tests explicitly establish that entity evidence does not state the memory (`knowledge-extraction.entity.functions.test.ts:455-479`, `knowledge.entity.functions.test.ts:111-142`), but do not combine that distinction with the three-episode routine gate.
- **Impact:** one observation can become an inferred routine solely because its named entity already has attribution in several earlier sources. This weakens the advertised evidence threshold without a schema/provenance violation.
- **Recommendation:** count distinct episodes from each support's `knowledgeMemoryMentions`, at both staging and publication, retaining the current source-metadata fallback and publication's actual metadata grouping. Test one observation with multi-source entity attribution, multiple revisions in one episode, and a genuinely corroborated observation across independent episodes.
- **Reproduction output:** `{"notes":[],"validation":"None","support":{"episodes":1,"sources":1,...},"inferredSupport":{"episodes":2,"sources":2,...},"mentions":[{"id":"now","revision":1},{"id":"said","revision":1}]}`. Artifact: `.artifacts/repository-audit/evidence/efferent-knowledge-routine-repro.ts`.

### Architecture, Effect semantics and test quality

- Pure schema/entity files contain data; the paired functions implement evidence, history, query, ranking and graph rules without host imports. I/O workers and PostgreSQL persistence remain behind core ports. The in-memory reference adapter makes state decisions synchronously under one `Ref.modify` and returns typed `KnowledgeError` values; these are meaningful Effect semantics, not merely replacing loops with combinators. The synchronous work inside that atomic region makes CORE-KNOWLEDGE-1 especially material.
- `extractKnowledge` correctly distinguishes provider failure/interruption from invalid extraction data: provider failures and interrupts never trigger shape review. Repair is bounded to one review per window; after a merge refusal only unreviewed windows receive that review. Invalid review output fails with a review-stage diagnostic, rather than falling through to a third provider call. Tests assert calls, complete prompts, exact stored spans and notes, not just success tags.
- Query/rerank helpers validate opaque candidate identities and repeated/invented rerank keys, budget whole records and associated evidence, and preserve temporal/history limits. The source mentions/corroboration model is a substantial domain abstraction; it is reused by narrowing and support profiles, making the inconsistent routine gate a localized defect rather than an absent design.
- `knowledgeStoreConformance` exposes 33 named behavioral checks and has careless-adapter and targeted-mutant self-tests. It covers immutable source replay, lease fencing, staging retry and diagnostics, optimistic atomic publication, exact evidence, scope/engine isolation, pre-limit source/metadata filters, cosine thresholds, tombstones and cascading privacy invalidation, revision/corroboration behavior, durable discovery, failure pagination/requeue, and bitemporal traversal.
- `temporalGraphConformance` intentionally selects the two bitemporal checks from the storage kit and permits a separate graph view over the same backing index; a fake view ignoring that index is rejected. `longTermMemoryConformance` and `knowledgeConformance` check the public facades, bounds/history, source filtering and forgetting, independently of a backend. PostgreSQL and the in-memory reference adapter run the storage kit; the memory and RAG plugins run the relevant facade kit. The configured PostgreSQL integration run supplies database execution evidence; it makes no provider-backed claim.
- The tests are largely deterministic pure values, `Ref` state and logical lease timestamps; this directory does not introduce sleep-based network scheduling. Full prompt goldens are intentionally contractual and useful, though they do not establish real-model extraction quality. A recurrence fixture and an adversarial shared-DAG fixture would catch the two confirmed blind spots more effectively than increasing unit-case counts.
- No newly confirmed dead production module was found in this directory. The reference adapter is live via core's public entry and the kits; the pure helpers are consumed by the owned plugins and adapters. The earlier evaluator-only dead helpers are reported separately in the data-package audit.

Supplemental prompt pass: all seven `packages/core/golden/knowledge-*.prompt.txt` bodies were independently read in full, including each embedded output schema. Memory/document and multipart modes, strict source identity/evidence rules, query/rerank framing, complete review and bounded malformed-proposal repair match the reviewed functions and pinning tests. These exact snapshots establish byte contracts, not live-model correctness; no additional prompt finding was confirmed.

Ledger: `.artifacts/repository-audit/evidence/efferent-audit-knowledge-ledger.json` records all 14 owned source/test paths, the independently read core instructions and the seven fully read prompt goldens (22 paths total).

## Documentation contracts

<a id="doc-data-1"></a>

### DOC-DATA-1 — P2: website memory protocol and repair behavior lag current source (docs accuracy; high confidence)

`packages/website/src/content/docs/concepts/native-knowledge.md:49` says KNOWLEDGE_EXTRACTION_VERSION is9; `plugins/memory.md:261` gives memory:8 and `plugins/rag.md:82` gives rag:8. Current code and docs/native-knowledge.md use10. More materially, website native-knowledge's review section, `plugins/memory.md:79`, `plugins/rag.md:139` and `guides/memory-engine.mdx:87` describe on-failure review as starting only after an unreviewed decoded proposal is refused by staging. Version10 also repairs malformed JSON/schema-invalid initial replies, once per window; website's mirrored guide omits the entire current shape-repair contract. Hosts diagnosing failed jobs, costs and version migration receive contradictory instructions from adjacent official pages.

Evidence: full unified diff of docs/native-knowledge.md versus website native guide identifies exactly the missingv10 section and older on-failure text; all remaining shared content read from the central source. These are authored sections outside plugin-reference markers, so docs:generate's clean result does not validate them. Keep one canonical shared source for versioned protocol prose or assert source-derived version/repair examples at generation time; retain local page introductions separately.

<a id="doc-data-2"></a>

### DOC-DATA-2 — P2: documented standalone spend composition cannot define an agent (runnable example; high confidence, reproduced)

`docs/framework.md:803-813` constructs Agent.define with only modelsPlugin and ModelSpend, then returns the agent and ledger. Graph validation now requires ConversationMemory, ToolRegistry and StepLoop. Running the exact snippet's composition under Effect.scoped returned typed HarnessError code config.graph, message `the agent has no efferent/ConversationMemory, efferent/ToolRegistry, efferent/StepLoop: no plugin provides it, and neither services nor turnServices carry it`. No model client is acquired: graph refusal precedes activation (`packages/sdk/src/agent.adapter.ts:389`). Add the usual window/discovery/step-loop plugins or explicitly bind the three host replacements. Code fences being type-correct/import-valid does not establish runtime composition. This full program has no partial-fragment caveat, unlike many plugin guide fragments that explicitly tell readers to merge into a complete graph.

<a id="doc-data-3"></a>

### DOC-DATA-3 — P2: event guide preserves pre-durability event ordering and old platform/error claims (docs contracts; high confidence)

`docs/events.md:115-116` says assistant.message is published after tools ran, while its generated progress snippet comment and current framework correctly say the response is durable/published before handlers. Late client section and limitations also say memory.message reaches the journal only once the step ended. This matters for hosts correlating assistant/tool UI and inferring committed state. The reviewed source, current framework contract and scripted journeys establish publication before tools. Website guides/events.md mirrors this through sync-guides.

The same guide's final `docs/events.md:995` says no shared SessionLog for Node ships, contradicting plugin-session-files and its Node packed tests. Aroundline502 it describes SQLite and says anything else is host-owned, omitting directory storage. `:531` describes every Agent.turn failure as HarnessError though v3 also returns typed TurnError/begin tags; `:539` leaves waiting out of the live event outcomes. Update the guide as one contract pass against the current event union, durability boundaries and supported backends. Keep exact code snippets but also pin the prose's key ordered guarantees in tests.

<a id="doc-data-4"></a>

### DOC-DATA-4 — P3: framework overclaims Node verification for Bun-only SQLite (docs validation; high confidence)

`docs/framework.md:1874-1877` lists plugin-sessions, plugin-session-sqlite, plugin-tasks and plugin-tool-discovery, then says verify:packages runs all four on Node. SQLite imports bun:sqlite, declares only a Bun engine and is deliberately excluded from Node imports. State which adapters run on Node and which on Bun. The architecture/startup text elsewhere already makes this distinction correctly.

### Cross-cutting findings corroborated

- `docs/branded-types-roadmap.md:3-11` calls itself authoritative for deleted sdk-core structures, historical ContextNodeId/TUI/banTryCatch plans and outdated brand recommendations. Unlike framework-reset, it has no historical disclaimer. Remove from active task guidance or rewrite around current branded-id gate and domain-entity skill.
- `docs/foundry.md:59` presents removed EvalContract as current exemplary domain, with later sections referring to deleted CLI/smith/scenario APIs. Some retired items have historical notes, but opening asserts all old problems are structurally solved today. Preserve useful gate architecture while explicitly dating/removing historical product directions. Imperative no-loop metrics and claiming one clean gate proves 'exemplary Effect style' overstate semantic review; data replay copying and nested Option decisions show what syntactic rules miss.
- `docs/composable-evaluations.md:178` advertises unexported/test-only assessBothOrders. The traces section in evaluation-domain/website evals likewise advertises eval.pairwise despite no public runnable path.

### Other observations

The current central native guide is unusually precise about evidence-vs-effects, UTF16 slices, capture admission/checkpoints, source narrowing, filters-before-limit, owner scopes, unknown usage, graph-vs-chunk history, stage/CAS visibility, reindex migration and failure recovery. The memory walkthrough identifies scripted models, the retained in-memory knowledge store and its lack of process restart evidence, so it avoids overstating persistence or retrieval quality. Most plugin snippets explicitly state they are incomplete graph fragments. Generated configuration blocks and event references are useful, but only a portion of the documentation is generated; clean generation leaves authored mirror drift undetected.

`docs/framework.md`'s journal vocabulary table is no longer exhaustive: memory.snapshot and tool.intercepted are described in their own sections and typed readers but absent from the hand-kept kind table around3475. Link the generated event-reference as the exhaustive list or generate this table too. This is lower impact than wrong event order or protocol versions.

No external papers/providers were live-validated as part of this code/doc consistency audit. Research links are attributed as references, not treated as benchmark evidence. Root owns website host/execution pages and external link/build checks.

## Website

<a id="website-1"></a>

### WEBSITE-1 — P2: mobile documentation is placed in a fixed 240-pixel column

- **Location:** `packages/website/src/layouts/DocLayout.astro:83` with `.col-side` hidden at line 88 and enabled only in the `min-width: 880px` query.
- **Category/confidence:** user interface/layout correctness; high confidence from the complete declared grid and DOM, no browser measurement claimed.
- **Trigger and impact:** below 880px, the sidebar is `display: none`, so `.col-main` becomes the grid's first item. The outer grid still declares `240px minmax(0, 1fr)` with a 2.5rem gap. Automatic placement therefore gives the entire documentation body a fixed 240px first column and leaves the second column unused. At tablet widths this wastes most available reading width; narrow screens also have the fixed column, gap and 1.75rem gutters competing for space. The mobile menu and main text inherit that narrow first-column geometry.
- **Recommendation:** declare one flexible outer column by default, and enable the sidebar-plus-content columns in the same 880px query that shows the sidebar. A small viewport-layout assertion at e.g. 375px and 800px would cover a behavior that the HTML link checker cannot see.

<a id="website-2"></a>

### WEBSITE-2 — P3: obsolete landing-page assets and styles remain unreachable

- **Locations:** `packages/website/src/components/ProductLogo.astro:2-6`, `packages/website/src/lib/nav.ts:16`, `packages/website/src/styles/global.css:147-179`.
- **Category/confidence:** dead code/assets; confirmed by complete authored website read and reference searches.
- **Evidence:** `ProductLogo.astro` has no importer. Only that dead component imports `logo-sdk.svg` and `logo-cli.svg`; the latter still advertises the former TUI/headless/daemon agent CLI. `src/assets/logos/logo.svg` also has no consumer. `NPM` in nav.ts is exported but never imported. The `.btn`, `.btn-primary` and `.btn-ghost` family has no markup consumer; the new landing uses its own `.primary` class. `--maxw` and `--glow` also have no `var(...)` consumer. These are not dynamically loaded public assets: the SVGs are under `src/assets`, and all current Astro entry/components were checked.
- **Impact/recommendation:** low runtime impact, but old product terminology and a second unused button system increase editing ambiguity. Remove the retired component/assets/export/style family or deliberately restore a consumer. Keep active BrandLogo/wordmark, favicon, `--maxw-wide` and current page styles.

<a id="website-3"></a>

### WEBSITE-3 — P3: conformance and telemetry prose retain contradictory API claims

- **Locations:** `packages/website/src/content/docs/concepts/conformance.md:654-655`, `:215-216`; `packages/website/src/content/docs/concepts/observability.md:60-63`.
- **Category/confidence:** documentation contract drift; high confidence for TurnLive ownership and service-name precedence, medium for the ambiguous Node wording.
- **Evidence:** the conformance page calls `TurnLive` core's, although the same page and current entries correctly put it in SDK. The Sessions-kit paragraph names SQLite immediately before saying `verify:packages` runs it on Node, which reads as a Node-capable SQLite claim; the package is Bun-only. Observability's table correctly lists explicit `resourceAttributes["service.name"]` as the service-name fallback, but the following prose says `serviceName` or `"efferent"` always names the service. The actual `optionsResource` implementation (`plugin-telemetry/src/otlp-telemetry.entity.functions.ts:34-39`) and its test (:30-32) choose explicit `serviceName`, then explicit resource attributes, then the default. Environment `OTEL_RESOURCE_ATTRIBUTES` is a separate issue and should stay distinguished from the options object.
- **Recommendation:** fix ownership and explicitly distinguish Bun's SQLite checks from Node-capable subjects. State service-name precedence consistently in table and prose. These defects supplement the previously reported central-framework/website native-protocol drift; they are not evidence that every guide is stale.

### Design and verification observations

- Website rendering stays separate from framework runtime ports. Build-time Astro code renders trusted repository Markdown/recordings; client JavaScript handles theme and playback only. Using direct DOM/JSON/array operations here is appropriate to that boundary, rather than wrapping presentation code in Effect solely for syntax consistency.
- The playback is progressive: without JavaScript all six recorded states and request details remain available. With JavaScript it reveals controls, selects stages/requests, announces status, and supports directional/Home/End keys. It labels scripted models, the recorded SDK, estimates versus billed usage, and the in-memory knowledge store limitation explicitly. The recording's SDK is 0.18.0 while current docs follow 0.19.2; because it visibly names the recorded version, this is honest historical evidence, not a claim to regenerate on every patch.
- Both JSON recording copies are byte-identical (163,306 bytes); parsed structure has six states (five turns and a processing checkpoint). Generated plugin navigation contains six groups/24 distinct slugs. The root fixture test verifies recording provenance/freshness separately; this pass does not claim every JSON value was manually read.
- `href()` and the Markdown link plugin account for the GitHub Pages `/efferent` base. The built-site link checker resolves real files and anchors, decodes paths, rejects traversal/backslashes/NUL and outside symlinks, and checks static downloads as well as pages. Its three fixture tests clean their temporary directories and cover successful downloads/query/encoded/relative links, missing assets/anchors and traversal/symlink rejection. No flake was found in these tests by inspection.
- `website check` is an Astro production build plus the static link checker. It does not exercise viewport layout or playback behavior; WEBSITE-1 illustrates that limit. There is also no explicit `astro check`/TypeScript checker in this package script. Root repository checks and docs-snippet checks supply additional evidence, but build/link resolution should not be described as runtime verification of every example.
- The current getting-started and practical context-journal compositions include memory, registry and step-loop dependencies, unlike the separately reproduced invalid central spend-cap example. Harness prose clearly distinguishes queued inputs, writer ownership, sealed replies, task questions, scope lifetimes and shutdown; its breadth creates maintenance cost but is not just nonfunctional boilerplate.
- No package-specific website AGENTS/CLAUDE file exists; the root instructions apply. The package is private. This read does not recommend applying server-side functional/Effect source gates indiscriminately to browser presentation code.

Coverage ledger: `.artifacts/repository-audit/evidence/efferent-audit-website-ledger.json`.

## Scripts and compatibility tooling

<a id="s1"></a>

### S1 — P2 — stored-shape canonicalization deletes real field schemas

- Location: `scripts/stored-format.ts:66`–`:70`.
- Category/confidence: verified gate defect by direct code reasoning; high confidence; Direct audit reproduction confirmed identical canonical forms for title:String and title:Number.
- Trigger/impact: WORDING names JSON Schema annotation keywords, but canonical strips them from every object recursively, including dictionaries such as `properties` and `definitions`. A real field named title therefore loses its entire child schema. `Schema.Struct({title:Schema.String})` and `Schema.Struct({title:Schema.Number})` both reduce their properties map to{} and keep the same required:[title], so the fingerprint does not see the type change. The existing `SessionsState.title` at `packages/plugin-sessions/src/sessions-state.entity.ts:66` is an affected stored field. This undermines the promise that a stored field/type/check change always requires a format bump.
- Recommendation: traverse schema nodes contextually and strip annotation keywords only there; preserve the dictionary keys under properties/patternProperties/definitions/$defs and arbitrary constant/default values. Add reserved-word field-name and definition-name tests alongside the existing ordinary-field tests.

<a id="s2"></a>

### S2 — P2 — model text pin validation permits completely unpinned rows

- Location: `scripts/model-text-pins.test.ts:28`–`:35`,`:58`–`:70`; root AGENTS model-facing text guarantee.
- Category/confidence: verified test/instruction mismatch by direct branch inspection; high confidence.
- Trigger/impact: a new Model-facing text row with empty Pinned by, arbitrary prose, or an unrelated existing test file passes: the first check only rejects four phrases and the citation check iterates only references its regex happened to parse. Global>40counts are satisfied by other rows. A package missing its section/header silently contributes zero rows. No check proves that each row has a recognized pin, much less that a cited assertion compares its full text. The root instructions say the script refuses a row pinned not at all, which is stronger than it implements.
- Recommendation: require a recognized nonempty pin on each row, validate citations per row, and add parser/validation self-tests for empty/missing/malformed cases. Phrase the automatic guarantee as reference validation; actual exact assertion semantics still require review or generated golden linkage.

<a id="s3"></a>

### S3 — P2 — evaluation release fixture writer lacks journal recorder's immutability guards

- Location: `scripts/record-run-fixture.ts:40`–`:42`,`:128`.
- Category/confidence: verified tooling guard gap by code inspection; high confidence for behavior; impact depends on invocation.
- Trigger/impact: --force overwrites the versioned run-<version>.json without establishing the header's claimed unreleased status. Without force, existsSync followed by default writeFile is not exclusive: two recorders can both pass the existence check and write/replace the same release target. The journal recorder has explicit --unreleased/force separation and wx release writes, with isolated CLI/concurrency tests; this recorder has neither guard parity nor an equivalent direct test file.
- Recommendation: mirror the journal recorder's explicit development target, allow force only there, and exclusively create normal versioned release fixtures. Add isolated overwrite/concurrent-creation tests. Do not regenerate any authentic historical fixture as part of the fix.

### Other observations

- `scripts/build-packages.ts:80` still filters the removed ./tui-testing export. No current package manifest has that export; remove the dead compatibility branch with the orphaned models tmux fixture unless a documented consumer remains.
- `scripts/knowledge-reference-clients.ts:33`–`:35` reads successful external bodies with unbounded response.text and does not consume/cancel rejected bodies. Optional benchmark-only resource/bounding concern; not a reproduced runtime defect. Preserve typed unavailable outcomes while bounding/canceling external reads.
- `scripts/npm-registry.ts:29`–`:36` confirmation is bounded by attempt count, not an absolute wall-clock deadline. Each request may consume30s plus5/10s intervals, so three/fifteen-minute comments are nominal propagation delays rather than total bounds. `release-publish.ts:16` still says three minutes although the tag schedule is now fifteen minutes. Prefer a shared absolute deadline and accurate comments.
- `scripts/publish-packages.ts:155` accepts mere registry presence after ambiguous upload failure, unlike preflight's exact gitHead validation. `release-publish.ts:123` also uses presence-only final confirmation. A concurrent same-version publication after preflight can therefore be counted as this release without rechecking its provenance. This is a code-evident race/design concern, not a simulated live publication; use checkRegistryProvenance(requiredPresence=true) before counting ambiguous success/tagging.
- The CI-guide guard `scripts/agents-guide.test.ts:36` recognizes only anonymous `- run:` steps. A named step's `run:` is skipped even though the test's description claims every CI command. Existing literal commands may all currently be covered; use YAML decoding, as release-workflows.test.ts already does, for future correctness.
- Many script CLI tests correctly use isolated directories, real read-only git fixtures, stubbed registry responses, OS child deadlines and finally cleanup. Some release-target/status CLI children omit an explicit OS deadline; runner timeouts alone do not guarantee their child is killed after failure. This is an unobserved cleanup risk.
- Scripts use direct async/sync host IO and plain pure functions rather than forcing production Effect rules onto development tooling. The split between pure plans and command execution is clear and tested. The strongest release tests bind exact trusted CI/check IDs, immutable source selection, source versus signing SHA, skipped-package provenance, manifest overlays and preflight no-write refusals.
- Packed verification is thorough across public exports, declaration dependencies, documented imports, Node/Bun journeys and conformance. Repeated fixture launching/report substring checking in the1010line verifier could be one small data-driven runner with deadlines and structured decoded reports; this is maintenance/test infrastructure simplification, not a demand to replace the independently authored journey assertions.

## Foundry

### Candidate findings and ordinary quality notes

<a id="foundry-1"></a>

### FOUNDRY-1 — P2: custom-rule crashes can pass at advisory severity

 `packages/foundry/src/gates/rules/custom.ts:39-61` converts thrown/non-array check results into ordinary RuleMatch values. `idiomGate.ts` assigns the configured severity to every returned match, and `domain/Verdict.ts` passes warning/info findings. Therefore a custom rule with warning/info severity can crash and still yield PASS. This conflicts with the explicit fail-closed gate/error contract. Recommend a distinct infrastructure failure path or forced error severity for wrapper failures. Direct audit reproduction confirmed a pass verdict containing the warning that the custom rule crashed.

2. **Error-path concern, static evidence:** `privateTextGate.ts:51-56` maps all lstat failures to absent/None; `boundariesGate.ts:164-168` maps all package-manifest read errors to absent; `registrationGate.ts:42-47` similarly treats any stat failure as not-a-package. Expected missing/deleted paths can be skipped, but EACCES/IO failures should fail rather than silently remove enforcement scope. Existing tests cover expected missing cases, not these distinctions. No permission-failure reproduction claimed.

3. **P3 configuration-quality note:** `cli/check.ts:125-143` catches all baseline decode/read errors as an empty baseline although its comment promises absence only. Corrupt baseline + clean sources passes; this cannot hide fresh findings, so impact is weaker than a broad fail-open claim.

4. **Style/performance example, demo only:** accepted demo `cli/demo.ts` chooses a maximum by sorting all words and constructs a new Map for every histogram word. Those are O(n log n) and worst-case O(n²) respectively; the task can be linear with an indexed fold/local builder. This supports qualifying syntactic no-let/no-loop policy rather than claiming that Effect usage throughout the repo is superficial.

5. Parent-confirmed CLI implementor cancellation defect remains applicable: `adapters/claudeImplementor.ts` ignores tryPromise AbortSignal and has no scope finalizer; no new stdout deadlock claim (parent tested large output successfully).


<a id="foundry-2"></a>

### FOUNDRY-2 — P2: synchronous gate construction bypasses defect-to-report handling

 `pipeline/runPipeline.ts:65` evaluates `gate.run(workspace)` before attaching the per-gate `catchDefect`. A callback that synchronously throws while constructing its Effect therefore escapes that handler, contrary to the promise that every gate defect folds into a report. The existing defect test (`runPipeline.test.ts`) returns `Effect.die` and does not exercise a construction-time throw. Wrap the callback in `Effect.suspend(() => gate.run(workspace))` before timing/classifying it. Direct audit reproduction confirmed Exit Failure with no GateReport for a synchronous construction-time throw.

<a id="foundry-3"></a>

### FOUNDRY-3 — P3: the inner-core runner gate omits runtime runners

 `gates/rules/effectArchitecture.ts:55-60` only rejects Effect method names starting with `runPromise` or `runSync`, whereas the root instructions describe `architecture/no-raw-promise-core` as banning `Effect.run*` in inner files. `Effect.runFork` and `Effect.runCallback` can escape managed core execution while passing this specific rule. The associated tests exercise async/Promise forms but do not pin these runner methods. This is a verified gate coverage omission, not a claim of existing production misuse. Define the exact forbidden runner set and test each of it, including aliases if enforcement is intended to be semantic.

### Port / adapter / conformance matrix

| Contract | Concrete adapters | Verification / qualification |
| --- | --- | --- |
| `Gate<R>` value callback (not Context.Service) | idiom, boundaries, typecheck, registration, private text, judge, baseline wrapper | Focused exact finding/location tests plus pipeline policies, typed crashes and returned Effect defects. Construction-time synchronous throw and advisory custom-rule crash paths are missing. |
| `TsProject` | TsProjectCachedLive for one-shot checks; TsProjectFreshLive for forge rebuilds | Exercised through idiom/boundary/typecheck tests, vendor parity and demo. No separate shipped conformance kit; source documents distinct cache lifetimes. |
| `Implementor` | ClaudeCliImplementorLive; makeScriptedImplementor; recording fakes | Scripted implementation exercised by forge/demo. Claude prompt/output parsing read; the audit verified the cancellation child leak. No standalone conformance kit pins cancellation/lifetime. |
| `RunSink` | FileRunSinkLive; in-memory/failing forge test fakes | Encode/decode/readRuns and forge incremental/final persistence tests. Strict final persistence versus best-effort partial persistence is deliberate and tested. No standalone conformance kit. |

### Effect semantics, test quality and instructions

The pipeline uses Effect for actual typed failure handling, service composition, serial gate execution, tracing, retry scheduling and clock/random access. This is substantive Effect use. Syntax policy still encourages some costly immutable rebuilds (demo histogram and lessons tallies), so a clean gate run is not complexity or cancellation evidence. Most gate tests are stronger than count-only smoke checks: they assert exact rule/file/line arrays, negative fixtures, stale allow/boundary rejection, vendor parity and full-baseline behavior. Foundry's reusable services do not have the conformance-kit coverage required of published framework ports; this is an internal development-tooling exception worth making explicit rather than pretending the same assurance applies.

The package's model-facing renderers have mixed pin strength: renderFeedback has an exact golden and exact truncation count; renderLessons tests chiefly assert selected substrings, and no dedicated Claude implementor prompt test is present under Foundry source. `packages/foundry/AGENTS.md` lacks the model-facing-text inventory table described by the root rule. This is an instruction/test consistency concern for tooling prompts, with weaker priority than incorrect gate verdicts or child lifetime. No prompt-injection or real-provider failure claim is made from these tests.

Foundry's own role rules differ deliberately from published package style (star-export index, behavior in domain files, port-adapter colocation and direct node imports); its dedicated AGENTS and self-profile document the tooling scope. Do not mechanically rename these files or impose published-package port shape without a deliberate architecture decision.

## SDK test review

### Findings and corroboration

- **P3, test hygiene, inspection-only:** `packages/sdk/src/model-failures.journey.test.ts:7-13` and `packages/sdk/src/prompt-cache.journey.test.ts:7-13` spawn a fixture process and await its streams/exit without a watchdog or `finally` kill. If the fixture stalls or the enclosing Bun test times out, these wrappers own no explicit process cleanup; a child can outlive the failed test and keep its local resources while later tests run. The newer model-retry/media/request-parts/LangSmith wrappers consistently use a child watchdog plus cleanup. Apply that same ownership pattern to the two older wrappers. No actual leaked child or timeout from these two tests was reproduced or observed in this pass.
- **P3, scheduler-sensitive assertions, inspection-only:** `packages/sdk/src/events-guide.test.ts:583-587` requires a complete real turn with a 200ms stalled-stream write to finish within one second; `:885-889` gives the equivalent 50ms journal follower a one-second elapsed ceiling. Correct abort behavior can fail these assertions under unrelated scheduler/CPU delay. Count writer attempts and assert the first timeout suppresses later writes, alongside abort/settlement and a generous outer deadline; this directly tests the intended property without requiring a machine-speed margin. No failure of these cases was observed in root's baseline; do not label them reproduced flakes.
- **Corroborates existing FW6, not a new defect:** `packages/sdk/src/turn/model-call-recorder.adapter.test.ts:158-163` makes its reentry failure assertions conditional on already receiving failure. A successful result skips them. Root/framework already proved this by replacing the production rejection with success and seeing both tests pass; this pass independently read the same hole. Require failure before narrowing, then assert code and sticky identity.

### Quality assessment

The remaining SDK tests are unusually strong on observable contracts. They drive actual `Agent.define`/`Agent.turn`, production loop/registry/memory/session compositions, and assert the requests a model received, exact journal order, replayed bytes and retained identities. They cover typed begin refusals, durable assistant-before-handler ordering, independent concurrent run ordinals, raw tool-result ACKs before views, queued user input/images, exact steering receipts, reply races and lock order, post-reply maintenance/sealing, billing through bootstrap/finalizers, overflow recovery, request-part dependencies/cursors/fork visibility, and real helper questions and deferred answers. This is substantially more than tests mirroring a few helpers.

Concurrency tests predominantly use explicit Deferred barriers, held acknowledgments and shared-state predicates. Logical time/lease behavior uses TestClock where appropriate. The few live-clock thresholds above deserve tightening; ordinary safety timeouts and a streamed endpoint held until a bus delta arrives are meaningful behavioral checks, not automatically flakes.

Conformance self-tests deliberately remove one behavior and check which contracts fail. This makes the public kits reviewable, while the recorder conditional assertion illustrates why kit/test counts alone do not prove every guarantee. The TurnPhase table tests are implementation-adjacent but substantiate the explicit domain state machine, and the independent compositions and journeys provide broader evidence.

Goldens use a fixed clock and compare complete model/journal bytes. The same golden conversation runs on memory, SQLite, files and reordered JSON keys; streamed reasoning metadata, typed tool parameters, compaction/digest text and historical reconstruction are all pinned. Golden update environment variables are deliberate explicit workflows. Golden JSON was covered through decoding/exact-byte test evidence and the root's fixture validation, not newly claimed as a manual value-by-value read.

`journal-compat.test.ts` decodes each released fixture by its historical reserved kinds and current owning schema, reconstructs memory and every request, and checks development format coverage. Its only literal release-byte digest in this file is 0.14.0; preservation of every other fixture's original provenance depends on the release workflow/other validation. This is a coverage boundary rather than a proven compatibility regression.

The events guide is executable source: generated snippets cover actual HTTP/SSE request admission, idempotency, private projection, shared-log polling, transient channels and client disconnect handling. The earlier central-prose ordering finding is not an error in these assertions: the source explicitly verifies that assistant messages precede tool execution. The published explanatory prose should follow this source.

Child-process wrappers test exported evidence from shared source/packed fixtures. Their full authored wrappers were read, but reading a wrapper is not a substitute for reading its external fixture; those sources remain covered by root/other reviewers. Live-provider correctness, real cache hits and live LangSmith ingestion remain outside these key-free tests, as their comments and assertions explicitly acknowledge.

## Sessions test review

### Useful evidence and gaps

- `packages/plugin-sessions/src/sessions.adapter.test.ts:878`: the ownership test checks get/read/cancel against a foreign owner on an idle session. It never begins a local writer first, explaining why the separate cancel-owner shortcut defect escapes. Add a wrong-owner cancel while this instance actively owns the writer; verify the writer remains open and no end is stored.
- `packages/plugin-sessions/src/sessions.conformance.test.ts:84`: its careless-incarnation mutation self-test proves an old writer cannot commit into a recreated session. That is valuable, but does not prove owner-check-to-read/remove identity stability. Add the framework review's head/read and guarded/remove race schedules as independent cases.
- `packages/plugin-sessions/src/sessions.adapter.test.ts:173` holds turn.ended commits on a Deferred, then executes refusal assertions at191–194 before releasing it at195. The release is not an ensuring/finalizer. A regression failing one of those assertions can leave writer shutdown waiting on that held end and obscure the original failure with a runner timeout. Similar held-ACK cleanup at `memory-snapshot.adapter.test.ts:223` releases only after intermediate assertions. Register release finalizers before launching blocked work, as the durable-steering and queued-input fixtures already do. Category: code-evident failure-path fixture cleanup risk, not an observed flake.
- `packages/plugin-sessions/src/inbox-drain.adapter.test.ts:74`, `:451` and `waiting-input.adapter.test.ts:81` use150–200ms live-clock waits for ordinary in-memory scheduling. These are shorter than the outer3s bounds and can create load-sensitive false negatives. Replace incidental narrow waits with observed handshakes plus a single outer deadline. Category: unobserved timing risk.
- The inbox-drain test title at277 says retry occurs without a ceiling, while recovery-policy tests at484 correctly pin parking at the configured attempt limit. The old case performs two unsuccessful runs then one successful run, all within the default limit. Rename it to describe preserved backoff rather than no ceiling; no production contradiction is established.

### Strengths

- Most lifecycle races are controlled with Deferred and TestClock, and tests assert durable records, pending slots, entry IDs and exact error identity rather than only method returns.
- Durable steering explicitly tests CAS rebasing, concurrent cancellation, lost ACKs, reused IDs, all-or-nothing batch receipts and newer-format fencing.
- Sessions conformance self-tests use many careless adapters and exact expected failed-check sets, checking the kit itself. Fresh session/owner identities permit a shared memory log without the settings kit's shared-key ordering problem.
- Snapshot tests count bounded row/media lookups, distinguish malformed selected data from ineligible future pointers and check row/pointer atomicity after rebase and lost ACK.
- Recovery policy tests distinguish own/foreign holders, startup named takeover, interrupted versus timed-out work, poisoned inputs, early task answers and failed parent reactions.

## Agent instructions and configuration

### Additional low-severity documentation findings

#### IN1 — P3 — the application environment template outlived the application

- **Location:** `.env.example:1–13`, especially `:5`, `:8`, `:10–13`; corroborating `.gitignore:24`.
- **Evidence:** The template advertises an automatic Gemini default override, a server PORT, and a Docker-compose-backed PostgreSQL default. Full authored repository source search finds no references to `EFFERENT_MODEL`, `EFFERENT_DB_URL` or `GOOGLE_GENERATIVE_AI_API_KEY` in current `packages/**/*.ts` or `scripts/**/*.ts`, and git tracks no Docker Compose service or `bin/` commands. CONTRIBUTING:3–4 correctly says the applications/CLI moved out. Current framework configuration is supplied by hosts; copying this template does not configure those services.
- **Impact:** A newcomer can copy a plausible root environment setup and assume model/database/server settings have taken effect. This is stale onboarding/configuration text, not evidence of a runtime defect.
- **Recommendation:** Remove the application template or replace it with explicitly supported development/evaluation configuration and point to host-owned model/database settings. Remove the orphaned compose-data ignore comment if no longer useful. Leave `.envrc` parent-loading preference alone unless intentionally changing developer setup.
- **Category/confidence:** stale documentation/dead configuration; high.

#### IN2 — P3 — the sessions guide blurs own journal reads and inherited turn history

- **Location:** `packages/website/src/content/docs/plugins/sessions.md:83–85`.
- **Trigger/evidence:** Immediately after documenting `Sessions.read` as an own-events query (:76–81), the guide says reading a child includes its ancestor history. `core/src/ports/sessions.port.ts:220–231` explicitly promises the session's own events, and `plugin-sessions/src/sessions.adapter.ts:1052–1054` delegates only to `log.read(address.id, ...)`. Inheritance is assembled separately by `historyOf` in `plugin-sessions/src/turn-writer.adapter.ts:613–627`, for a turn's history/context. This is source tracing, not a new runtime probe.
- **Impact:** A host implementing a forked-session transcript with the documented `Sessions.read` can omit parent history while expecting it to be present.
- **Recommendation:** Name the inherited-history API/context path in that paragraph, preserve the own-events contract for Sessions.read and explain how a host intentionally obtains lineage history.
- **Category/confidence:** API documentation accuracy; high for contract mismatch, medium-high for reader interpretation.

### Instructions and architecture assessment

The instructions are unusually concrete and mostly internally consistent: exact Effect version, stable service keys, typed expected errors, scoped resources, per-port kits and careless-stub tests, exact model-text pins, recorded-format compatibility, frozen exceptions, package registration and packed consumers. CI command order agrees with the root definition of done, including Bun 1.3.0 followed by the isolated Bun 1.3.6 proxy matrix. Release workflow permissions/conditions, pinned release actions, pipeline/source checkout separation, same-source retry, immutable tags and explicit docs dispatch agree with the release skills and CONTRIBUTING. This pass did not independently verify hosted branch rules, npm settings or historical releases.

The add-port skill's universal `R = never`/kit/packed-Node wording is stronger than the existing deliberate scoped/generic ports and Bun-only SQLite exception; those are already captured in the primary architecture matrix and root review, not new findings here. AGENTS' shorthand saying every `packages/*/src` file is typechecked should be read with the explicit website exemption in CONTRIBUTING, registration and tsconfig; website `check` is separate. The root no-unknown-requirements and erasure exceptions are explicit/frozen, rather than silently widened. Passing these syntactic gates still cannot establish semantic cancellation, graph complexity, evidence support or trustworthy conformance; the previously reported concrete bugs demonstrate that limit.

The Changesets README's prepared-0.16.0 sentence is explicitly historical rollout context. It is not treated as a new current-version contradiction. Current source/version markers read here agree on 0.19.2 and the current extraction migration is version 10. No additional high-severity instruction or release-process inconsistency was established in this pass.

## Repository instructions, semantic style and subprocess ownership

### Additional repository findings

<a id="root-1"></a>

#### ROOT-1 — P2: the real implementor subprocess outlives Effect interruption

`packages/foundry/src/adapters/claudeImplementor.ts:38` wraps subprocess work in `Effect.tryPromise` without using its AbortSignal or a scoped child finalizer. A ten-minute native timer is the only kill path. A controlled temporary executable wrote its PID and waited; interrupting the adapter with a 500 ms Effect timeout returned Failure while the child remained alive. The audit explicitly killed that fixture afterward. This can leave an abandoned implementor editing its workspace after the caller cancels. Acquire the child in a scope, connect cancellation, clear timers in finalization, and drain/close its streams. Test cancellation with a harmless child and an outer OS deadline. No claim that unread stdout deadlocks Bun: a separate large-output probe completed successfully.

<a id="root-2"></a>

#### ROOT-2 — P2 test gap: model-text citation checks do not establish exact assertions

`scripts/model-text-pins.test.ts:54` checks table wording and whether cited test files/line numbers exist. It does not inspect assertions or establish that a referenced test exercises its claimed text. In a disposable copy, replacing all assertions in the cited tasks-capability test with blank lines of equal length left all three citation tests passing. This is a demonstrated false-positive boundary; many actual text tests elsewhere are substantive and exact. Describe this check as citation validation, strengthen actual template assertions and their negative controls, and avoid treating a valid line number as semantic pinning evidence. Stable named tests or a curated template registry would survive refactors more reliably than line numbers.

<a id="root-3"></a>

#### ROOT-3 — P2 design concern: instruction rules overstate semantic guarantees

The root gate table and skills make useful constraints explicit, but blanket `let`/loop bans and file-origin rules also reward syntax substitutions. Repeated copying in the history folds and nested Option worker protocol are concrete costs. `packages/plugin-sessions/AGENTS.md` explicitly directs native access through `process.getBuiltinModule` while banning native imports; root core exports redeclare aliases of internal helpers to satisfy declaration-origin policy. These patterns preserve the dependency while hiding it from a syntactic check.

Keep rules for typed errors, decoding, scoped ownership, dependency direction, public keys and bounded work. Permit confined builders inside referentially transparent helpers when they make linear algorithms clear; reserve Ref for state whose lifetime or sharing requires it. Prefer explicit tagged domain decisions to nested absence. State the invariant each gate establishes and its limitations. `CONTRIBUTING.md:26` should replace the claim that gates constitute review with the additional semantic review obligations demonstrated by this report.

The add-port skill's `R = never` rule also needs precise exceptions for caller-owned Scope and scoped evaluation factories; several intended public methods already require them. Promise-returning foreign transport edges and intentionally Bun-only adapters need explicit treatment. These are instruction corrections, rather than reasons to conceal lifetimes or add redundant wrappers.

<a id="root-4"></a>

#### ROOT-4 — P3: historical documentation still presents itself as current authority

`docs/branded-types-roadmap.md:11` calls itself authoritative while naming removed modules, an earlier package structure and a removed gate script. `docs/foundry.md:57` presents the retired EvalContract API as current domain behavior, while later prose says that gate was retired. The earlier audit also treats the absence of Effect.iterate as evidence of poor style even though the current skill correctly says that API does not exist. Archive or clearly label historical implementation claims, retain history, and make current contracts and instructions the authoritative entrypoints.

<a id="root-5"></a>

#### ROOT-5 — P3 cleanup signals: unused compiler diagnostics require classification

A separate TypeScript run with `--noUnusedLocals --noUnusedParameters` reported 35 diagnostics across production and tests. Some UserMessage imports explicitly anchor inferred declarations inside their owning package, so mechanically deleting every diagnostic could regress packed declaration dependencies. Clear ordinary unused imports and parameters, preserve or replace documented declaration anchors, and verify emitted declarations. This scan is evidence of cleanup opportunities, not proof of 35 dead behaviors. The reachability analysis of 582 production modules found the two test-only eval helpers after CLI entrypoints were accounted for; supported host exports were retained as roots.

### Instruction and documentation judgment

The task map, package-local rules, stable service keys, storage compatibility policy, exact model-visible contracts and runnable conformance guidance are useful. Their implementation notes are extensive: core AGENTS alone has 602 lines, and the ten repository skills total 1,248. Keep mandatory rules concise, move rationale and historical implementation detail into linked documentation, and generate mechanical inventories where practical. CLAUDE symlinks correctly avoid maintaining second copies.

Generated references are well controlled: regeneration in a disposable checkout matched all 62 tracked documentation/data outputs examined, and the 46-page website passed its internal link check. Authored mirrors need the same attention: generated defaults can be current while nearby examples, protocol versions and ordering claims are stale. Runtime-smoke-test composition examples in addition to compiling them. Preserve the useful distinction between scripted implementation evidence and real provider or benchmark evidence.
## Per-file coverage ledger

<details>
<summary>All 1,433 tracked paths and their review methods</summary>

| Path | Method |
| --- | --- |
| `.agents/skills/add-plugin/SKILL.md` | R |
| `.agents/skills/add-port/SKILL.md` | R |
| `.agents/skills/change-event/SKILL.md` | R |
| `.agents/skills/commit-style/SKILL.md` | R |
| `.agents/skills/domain-entity/SKILL.md` | R |
| `.agents/skills/effect-idioms/SKILL.md` | R |
| `.agents/skills/journey-test/SKILL.md` | R |
| `.agents/skills/release/SKILL.md` | R |
| `.agents/skills/trusted-publishing/SKILL.md` | R |
| `.agents/skills/write-model-text/SKILL.md` | R |
| `.changeset/README.md` | R |
| `.changeset/config.json` | R |
| `.claude/skills` | A |
| `.env.example` | R |
| `.envrc` | R |
| `.foundry/baseline.json` | V |
| `.github/workflows/ci.yml` | R |
| `.github/workflows/docs.yml` | R |
| `.github/workflows/release-pr.yml` | R |
| `.github/workflows/release.yml` | R |
| `.gitignore` | R |
| `AGENTS.md` | R |
| `CHANGELOG.md` | H |
| `CLAUDE.md` | A |
| `CONTRIBUTING.md` | R |
| `LICENSE` | R |
| `README.md` | R |
| `api/core--conformance.api.txt` | V |
| `api/core--internal.api.txt` | V |
| `api/core.api.txt` | V |
| `api/evals--stats.api.txt` | V |
| `api/evals-cli.api.txt` | V |
| `api/evals-langfuse.api.txt` | V |
| `api/evals-langsmith.api.txt` | V |
| `api/evals.api.txt` | V |
| `api/plugin-agent-loop.api.txt` | V |
| `api/plugin-knowledge-postgres.api.txt` | V |
| `api/plugin-memory-digest.api.txt` | V |
| `api/plugin-memory-summary.api.txt` | V |
| `api/plugin-memory-window.api.txt` | V |
| `api/plugin-memory.api.txt` | V |
| `api/plugin-models--compat.api.txt` | V |
| `api/plugin-models--conformance.api.txt` | V |
| `api/plugin-models--testing.api.txt` | V |
| `api/plugin-models.api.txt` | V |
| `api/plugin-rag.api.txt` | V |
| `api/plugin-render--output.api.txt` | V |
| `api/plugin-render.api.txt` | V |
| `api/plugin-session-files.api.txt` | V |
| `api/plugin-session-sqlite.api.txt` | V |
| `api/plugin-sessions.api.txt` | V |
| `api/plugin-tasks.api.txt` | V |
| `api/plugin-telemetry.api.txt` | V |
| `api/plugin-tool-discovery.api.txt` | V |
| `api/plugin-workspace.api.txt` | V |
| `api/process-host.api.txt` | V |
| `api/runtime.api.txt` | V |
| `api/sdk--conformance.api.txt` | V |
| `api/sdk.api.txt` | V |
| `assets/avatar.png` | B |
| `assets/avatar.svg` | B |
| `assets/logo-mark.svg` | B |
| `assets/logo.svg` | B |
| `bun.lock` | V |
| `docs/branded-types-roadmap.md` | R |
| `docs/composable-evaluations.md` | R |
| `docs/evaluation-domain.md` | R |
| `docs/event-reference.json` | V |
| `docs/event-reference.md` | V |
| `docs/events.md` | R |
| `docs/foundry.md` | R |
| `docs/framework-reset.md` | R |
| `docs/framework.md` | R |
| `docs/knowledge-evaluation.md` | R |
| `docs/native-knowledge.md` | R |
| `docs/plugin-reference.json` | V |
| `docs/process-protocol.md` | R |
| `docs/roadmap.md` | R |
| `docs/service-generations.md` | R |
| `docs/stored-format.json` | V |
| `foundry.config.ts` | R |
| `package.json` | R |
| `packages/core/AGENTS.md` | R |
| `packages/core/CLAUDE.md` | A |
| `packages/core/golden/knowledge-document.prompt.txt` | R |
| `packages/core/golden/knowledge-extraction-part.prompt.txt` | R |
| `packages/core/golden/knowledge-extraction.prompt.txt` | R |
| `packages/core/golden/knowledge-query.prompt.txt` | R |
| `packages/core/golden/knowledge-rerank.prompt.txt` | R |
| `packages/core/golden/knowledge-review-repair.prompt.txt` | R |
| `packages/core/golden/knowledge-review.prompt.txt` | R |
| `packages/core/package.json` | R |
| `packages/core/src/conformance.entity.ts` | R |
| `packages/core/src/conformance.functions.ts` | R |
| `packages/core/src/conformance/index.ts` | R |
| `packages/core/src/decision-record.entity.functions.ts` | R |
| `packages/core/src/decision-record.entity.ts` | R |
| `packages/core/src/domain/accepted-model-input.entity.functions.test.ts` | R |
| `packages/core/src/domain/accepted-model-input.entity.functions.ts` | R |
| `packages/core/src/domain/accepted-model-input.entity.ts` | R |
| `packages/core/src/domain/bash.entity.functions.test.ts` | R |
| `packages/core/src/domain/bash.entity.functions.ts` | R |
| `packages/core/src/domain/bash.entity.ts` | R |
| `packages/core/src/domain/engine-stamp.entity.functions.test.ts` | R |
| `packages/core/src/domain/engine-stamp.entity.functions.ts` | R |
| `packages/core/src/domain/engine-stamp.entity.ts` | R |
| `packages/core/src/domain/failure.entity.functions.test.ts` | R |
| `packages/core/src/domain/failure.entity.functions.ts` | R |
| `packages/core/src/domain/failure.entity.ts` | R |
| `packages/core/src/domain/file-system.entity.functions.ts` | R |
| `packages/core/src/domain/file-system.entity.ts` | R |
| `packages/core/src/domain/image-resize.entity.functions.test.ts` | R |
| `packages/core/src/domain/image-resize.entity.functions.ts` | R |
| `packages/core/src/domain/image-resize.entity.ts` | R |
| `packages/core/src/domain/loop-limits.entity.ts` | R |
| `packages/core/src/domain/media-store.entity.functions.test.ts` | R |
| `packages/core/src/domain/media-store.entity.functions.ts` | R |
| `packages/core/src/domain/media-store.entity.ts` | R |
| `packages/core/src/domain/media.entity.functions.ts` | R |
| `packages/core/src/domain/media.entity.test.ts` | R |
| `packages/core/src/domain/media.entity.ts` | R |
| `packages/core/src/domain/message.entity.ts` | R |
| `packages/core/src/domain/model-call-policy.entity.ts` | R |
| `packages/core/src/domain/model-call.entity.functions.ts` | R |
| `packages/core/src/domain/model-call.entity.test.ts` | R |
| `packages/core/src/domain/model-call.entity.ts` | R |
| `packages/core/src/domain/model-catalog.conformance.test.ts` | R |
| `packages/core/src/domain/model-catalog.conformance.ts` | R |
| `packages/core/src/domain/model-catalog.entity.ts` | R |
| `packages/core/src/domain/model-failure.entity.functions.test.ts` | R |
| `packages/core/src/domain/model-failure.entity.functions.ts` | R |
| `packages/core/src/domain/model-failure.entity.ts` | R |
| `packages/core/src/domain/model-overflow.entity.functions.test.ts` | R |
| `packages/core/src/domain/model-selection.entity.functions.ts` | R |
| `packages/core/src/domain/model-selection.entity.ts` | R |
| `packages/core/src/domain/model-spend.entity.functions.test.ts` | R |
| `packages/core/src/domain/model-spend.entity.functions.ts` | R |
| `packages/core/src/domain/model-spend.entity.ts` | R |
| `packages/core/src/domain/prompt-provenance.entity.ts` | R |
| `packages/core/src/domain/run.entity.functions.ts` | R |
| `packages/core/src/domain/run.entity.test.ts` | R |
| `packages/core/src/domain/run.entity.ts` | R |
| `packages/core/src/domain/token-usage.entity.functions.ts` | R |
| `packages/core/src/domain/token-usage.entity.test.ts` | R |
| `packages/core/src/domain/token-usage.entity.ts` | R |
| `packages/core/src/domain/tool-call-summary.entity.ts` | R |
| `packages/core/src/domain/tool-choice.entity.ts` | R |
| `packages/core/src/domain/tool-interceptor.entity.functions.ts` | R |
| `packages/core/src/domain/tool-interceptor.entity.test.ts` | R |
| `packages/core/src/domain/tool-interceptor.entity.ts` | R |
| `packages/core/src/domain/tool-result-receipt.entity.functions.test.ts` | R |
| `packages/core/src/domain/tool-result-receipt.entity.functions.ts` | R |
| `packages/core/src/domain/tool-result-receipt.entity.ts` | R |
| `packages/core/src/domain/trace-parent.entity.functions.test.ts` | R |
| `packages/core/src/domain/trace-parent.entity.functions.ts` | R |
| `packages/core/src/domain/trace-parent.entity.ts` | R |
| `packages/core/src/domain/turn-vocabulary.entity.ts` | R |
| `packages/core/src/harness/capability.entity.functions.ts` | R |
| `packages/core/src/harness/capability.entity.ts` | R |
| `packages/core/src/harness/capability.test.ts` | R |
| `packages/core/src/harness/config.entity.ts` | R |
| `packages/core/src/harness/harness-code.entity.functions.test.ts` | R |
| `packages/core/src/harness/harness-code.entity.functions.ts` | R |
| `packages/core/src/harness/harness-code.entity.ts` | R |
| `packages/core/src/harness/plugin-stack.adapter.test.ts` | R |
| `packages/core/src/harness/plugin-stack.adapter.ts` | R |
| `packages/core/src/harness/plugin.adapter.test.ts` | R |
| `packages/core/src/harness/plugin.adapter.ts` | R |
| `packages/core/src/harness/plugin.entity.functions.test.ts` | R |
| `packages/core/src/harness/plugin.entity.functions.ts` | R |
| `packages/core/src/harness/plugin.entity.ts` | R |
| `packages/core/src/harness/skill-files.entity.functions.test.ts` | R |
| `packages/core/src/harness/skill-files.entity.functions.ts` | R |
| `packages/core/src/harness/skill-files.entity.ts` | R |
| `packages/core/src/index.ts` | R |
| `packages/core/src/internal/glob.entity.functions.test.ts` | R |
| `packages/core/src/internal/glob.entity.functions.ts` | R |
| `packages/core/src/internal/index.ts` | R |
| `packages/core/src/internal/mapping.entity.functions.test.ts` | R |
| `packages/core/src/internal/mapping.entity.functions.ts` | R |
| `packages/core/src/internal/random-id.entity.functions.test.ts` | R |
| `packages/core/src/internal/random-id.entity.functions.ts` | R |
| `packages/core/src/internal/stream-fold.entity.functions.test.ts` | R |
| `packages/core/src/internal/stream-fold.entity.functions.ts` | R |
| `packages/core/src/internal/tool-schema.entity.functions.test.ts` | R |
| `packages/core/src/internal/tool-schema.entity.functions.ts` | R |
| `packages/core/src/internal/volatile-context.entity.functions.test.ts` | R |
| `packages/core/src/internal/volatile-context.entity.functions.ts` | R |
| `packages/core/src/knowledge/knowledge-extraction-repair.test.ts` | R |
| `packages/core/src/knowledge/knowledge-extraction.entity.functions.test.ts` | R |
| `packages/core/src/knowledge/knowledge-extraction.entity.functions.ts` | R |
| `packages/core/src/knowledge/knowledge-extraction.entity.ts` | R |
| `packages/core/src/knowledge/knowledge-facade.conformance.test.ts` | R |
| `packages/core/src/knowledge/knowledge-facade.conformance.ts` | R |
| `packages/core/src/knowledge/knowledge-query.entity.functions.ts` | R |
| `packages/core/src/knowledge/knowledge-query.entity.ts` | R |
| `packages/core/src/knowledge/knowledge-store.conformance.test.ts` | R |
| `packages/core/src/knowledge/knowledge-store.conformance.ts` | A |
| `packages/core/src/knowledge/knowledge.entity.functions.test.ts` | R |
| `packages/core/src/knowledge/knowledge.entity.functions.ts` | R |
| `packages/core/src/knowledge/knowledge.entity.ts` | R |
| `packages/core/src/knowledge/knowledge.memory.adapter.ts` | R |
| `packages/core/src/loop/cacheKey.ts` | R |
| `packages/core/src/loop/modelPolicy.ts` | R |
| `packages/core/src/loop/promptProvenance.ts` | R |
| `packages/core/src/loop/stepContext.ts` | R |
| `packages/core/src/loop/traceContent.test.ts` | R |
| `packages/core/src/loop/traceContent.ts` | R |
| `packages/core/src/media/media-store.conformance.test.ts` | R |
| `packages/core/src/media/media-store.conformance.ts` | R |
| `packages/core/src/media/media-store.memory.adapter.test.ts` | R |
| `packages/core/src/media/media-store.memory.adapter.ts` | R |
| `packages/core/src/memory/memory-checkpoint.adapter.test.ts` | R |
| `packages/core/src/memory/memory-log-render.test.ts` | R |
| `packages/core/src/memory/memory-log.entity.functions.ts` | R |
| `packages/core/src/memory/memory-log.entity.test.ts` | R |
| `packages/core/src/memory/memory-log.entity.ts` | R |
| `packages/core/src/memory/memory-log.unavailable-media.test.ts` | R |
| `packages/core/src/memory/memory-maintenance.conformance.test.ts` | R |
| `packages/core/src/memory/memory-maintenance.entity.functions.test.ts` | R |
| `packages/core/src/memory/memory-maintenance.entity.functions.ts` | R |
| `packages/core/src/memory/memory-maintenance.entity.ts` | R |
| `packages/core/src/memory/memory-session.test.ts` | R |
| `packages/core/src/memory/memory-session.ts` | R |
| `packages/core/src/memory/memory-snapshot.conformance.test.ts` | R |
| `packages/core/src/memory/memory-snapshot.conformance.ts` | R |
| `packages/core/src/memory/memory-snapshot.entity.functions.test.ts` | R |
| `packages/core/src/memory/memory-snapshot.entity.functions.ts` | R |
| `packages/core/src/memory/memory-snapshot.entity.test.ts` | R |
| `packages/core/src/memory/memory-snapshot.entity.ts` | R |
| `packages/core/src/memory/memory-tool-inputs.test.ts` | R |
| `packages/core/src/memory/memory.conformance.ts` | R |
| `packages/core/src/memory/tool-interception.adapter.test.ts` | R |
| `packages/core/src/memory/tool-interception.entity.functions.test.ts` | R |
| `packages/core/src/ports/activity.port.ts` | R |
| `packages/core/src/ports/background-workers.port.ts` | R |
| `packages/core/src/ports/bash.port.ts` | R |
| `packages/core/src/ports/capability.port.ts` | R |
| `packages/core/src/ports/committed-turn-observers.port.ts` | R |
| `packages/core/src/ports/file-system.port.ts` | R |
| `packages/core/src/ports/harness.port.ts` | R |
| `packages/core/src/ports/image-resizer.port.ts` | R |
| `packages/core/src/ports/inbox-runner.port.ts` | R |
| `packages/core/src/ports/knowledge.port.ts` | R |
| `packages/core/src/ports/media-store.port.ts` | R |
| `packages/core/src/ports/memory.port.ts` | R |
| `packages/core/src/ports/model-call-recorder.port.ts` | R |
| `packages/core/src/ports/model-catalog.port.ts` | R |
| `packages/core/src/ports/model-request-hook.port.ts` | R |
| `packages/core/src/ports/model-spend.port.ts` | R |
| `packages/core/src/ports/permission.port.ts` | R |
| `packages/core/src/ports/run-context.port.ts` | R |
| `packages/core/src/ports/session-channel.port.ts` | R |
| `packages/core/src/ports/session-log.port.ts` | R |
| `packages/core/src/ports/sessions.port.ts` | R |
| `packages/core/src/ports/step-loop.port.ts` | R |
| `packages/core/src/ports/tasks.port.ts` | R |
| `packages/core/src/ports/tool-interceptor.port.ts` | R |
| `packages/core/src/ports/tool-registry.port.test.ts` | R |
| `packages/core/src/ports/tool-registry.port.ts` | R |
| `packages/core/src/ports/tool-result-receipt.port.ts` | R |
| `packages/core/src/ports/turn-admission.port.ts` | R |
| `packages/core/src/ports/turn-events.port.ts` | R |
| `packages/core/src/ports/turn-scope.port.ts` | R |
| `packages/core/src/ports/turn.port.ts` | R |
| `packages/core/src/ports/utility-llm.port.ts` | R |
| `packages/core/src/session/activity.entity.functions.test.ts` | R |
| `packages/core/src/session/activity.entity.functions.ts` | R |
| `packages/core/src/session/activity.entity.ts` | R |
| `packages/core/src/session/background-workers.conformance.test.ts` | R |
| `packages/core/src/session/background-workers.conformance.ts` | R |
| `packages/core/src/session/durable-steering.entity.test.ts` | R |
| `packages/core/src/session/inbox-runner.conformance.test.ts` | R |
| `packages/core/src/session/inbox-runner.conformance.ts` | R |
| `packages/core/src/session/media-reference.entity.functions.ts` | R |
| `packages/core/src/session/media-reference.entity.ts` | R |
| `packages/core/src/session/model-call.readers.test.ts` | R |
| `packages/core/src/session/session-channel.conformance.test.ts` | R |
| `packages/core/src/session/session-channel.conformance.ts` | R |
| `packages/core/src/session/session-channel.entity.functions.test.ts` | R |
| `packages/core/src/session/session-channel.entity.functions.ts` | R |
| `packages/core/src/session/session-channel.entity.ts` | R |
| `packages/core/src/session/session-event.entity.functions.ts` | R |
| `packages/core/src/session/session-event.entity.test.ts` | R |
| `packages/core/src/session/session-event.entity.ts` | R |
| `packages/core/src/session/session-log-media.adapter.test.ts` | R |
| `packages/core/src/session/session-log-media.adapter.ts` | R |
| `packages/core/src/session/session-log.conformance.ts` | R |
| `packages/core/src/session/session-log.entity.functions.test.ts` | R |
| `packages/core/src/session/session-log.entity.functions.ts` | R |
| `packages/core/src/session/session-log.entity.ts` | R |
| `packages/core/src/session/session-log.memory.adapter.test.ts` | R |
| `packages/core/src/session/session-log.memory.adapter.ts` | R |
| `packages/core/src/session/session-log.recovery.conformance.test.ts` | R |
| `packages/core/src/session/session-log.recovery.conformance.ts` | R |
| `packages/core/src/session/sessions.conformance.ts` | R |
| `packages/core/src/session/sessions.entity.functions.ts` | R |
| `packages/core/src/session/sessions.entity.test.ts` | R |
| `packages/core/src/session/sessions.entity.ts` | R |
| `packages/core/src/session/stored-format.entity.ts` | R |
| `packages/core/src/session/task-question.entity.test.ts` | R |
| `packages/core/src/session/task-question.entity.ts` | R |
| `packages/core/src/session/tasks.conformance.test.ts` | R |
| `packages/core/src/session/tasks.conformance.ts` | R |
| `packages/core/src/session/tasks.entity.ts` | R |
| `packages/core/src/session/tool-call-state.entity.functions.test.ts` | R |
| `packages/core/src/session/tool-call-state.entity.functions.ts` | R |
| `packages/core/src/session/tool-call-state.entity.ts` | R |
| `packages/core/src/session/turn-admission.open.adapter.ts` | R |
| `packages/core/src/turn/committed-turn-observers.conformance.test.ts` | R |
| `packages/core/src/turn/committed-turn-observers.conformance.ts` | R |
| `packages/core/src/turn/committed-turn.entity.functions.ts` | R |
| `packages/core/src/turn/committed-turn.entity.ts` | R |
| `packages/core/src/turn/model-call-recorder.conformance.test.ts` | R |
| `packages/core/src/turn/model-call-recorder.conformance.ts` | R |
| `packages/core/src/turn/model-request-header.entity.functions.test.ts` | R |
| `packages/core/src/turn/model-request-header.entity.functions.ts` | R |
| `packages/core/src/turn/model-request-header.entity.ts` | R |
| `packages/core/src/turn/model-request-hook.conformance.test.ts` | R |
| `packages/core/src/turn/model-request-hook.conformance.ts` | R |
| `packages/core/src/turn/model-request-hook.entity.functions.test.ts` | R |
| `packages/core/src/turn/model-request-hook.entity.functions.ts` | R |
| `packages/core/src/turn/model-request-hook.entity.test.ts` | R |
| `packages/core/src/turn/model-request-hook.entity.ts` | R |
| `packages/core/src/turn/model-request.entity.functions.test.ts` | R |
| `packages/core/src/turn/model-request.entity.functions.ts` | R |
| `packages/core/src/turn/model-request.entity.test.ts` | R |
| `packages/core/src/turn/model-request.entity.ts` | R |
| `packages/core/src/turn/model-spend.conformance.test.ts` | R |
| `packages/core/src/turn/model-spend.conformance.ts` | R |
| `packages/core/src/turn/model-spend.memory.adapter.ts` | R |
| `packages/core/src/turn/model-text.test.ts` | R |
| `packages/core/src/turn/model-text.ts` | R |
| `packages/core/src/turn/prompt-sections.test.ts` | R |
| `packages/core/src/turn/prompt-sections.ts` | R |
| `packages/core/src/turn/request-header.conformance.test.ts` | R |
| `packages/core/src/turn/request-header.conformance.ts` | R |
| `packages/core/src/turn/request-part.entity.functions.test.ts` | R |
| `packages/core/src/turn/request-part.entity.functions.ts` | R |
| `packages/core/src/turn/request-part.entity.ts` | R |
| `packages/core/src/turn/step-loop.conformance.ts` | R |
| `packages/core/src/turn/turn-bus.adapter.test.ts` | R |
| `packages/core/src/turn/turn-bus.adapter.ts` | R |
| `packages/core/src/turn/turn-event.entity.functions.test.ts` | R |
| `packages/core/src/turn/turn-event.entity.functions.ts` | R |
| `packages/core/src/turn/turn-event.entity.test.ts` | R |
| `packages/core/src/turn/turn-event.entity.ts` | R |
| `packages/core/src/turn/turn.conformance.ts` | R |
| `packages/core/src/turn/user-message.entity.functions.ts` | R |
| `packages/core/src/turn/user-message.entity.test.ts` | R |
| `packages/core/src/turn/user-message.entity.ts` | R |
| `packages/core/src/workspace/bash.conformance.test.ts` | R |
| `packages/core/src/workspace/bash.conformance.ts` | R |
| `packages/core/src/workspace/file-system.conformance.test.ts` | R |
| `packages/core/src/workspace/file-system.conformance.ts` | R |
| `packages/core/src/workspace/file-system.memory.adapter.ts` | R |
| `packages/core/src/workspace/image-resizer.conformance.test.ts` | R |
| `packages/core/src/workspace/image-resizer.conformance.ts` | R |
| `packages/core/tsconfig.json` | R |
| `packages/evals-cli/AGENTS.md` | R |
| `packages/evals-cli/CLAUDE.md` | A |
| `packages/evals-cli/package.json` | R |
| `packages/evals-cli/src/adapters/bounded-json.adapter.test.ts` | R |
| `packages/evals-cli/src/adapters/bounded-json.adapter.ts` | R |
| `packages/evals-cli/src/adapters/evaluation-store.fs.adapter.test.ts` | R |
| `packages/evals-cli/src/adapters/evaluation-store.fs.adapter.ts` | R |
| `packages/evals-cli/src/cli-fixture.testing.ts` | R |
| `packages/evals-cli/src/cli.adapter.ts` | R |
| `packages/evals-cli/src/cli.test.ts` | R |
| `packages/evals-cli/src/config-loader.adapter.ts` | R |
| `packages/evals-cli/src/hanging-run.testing.ts` | R |
| `packages/evals-cli/src/index.ts` | R |
| `packages/evals-cli/src/main.ts` | R |
| `packages/evals-cli/src/run-main.adapter.test.ts` | R |
| `packages/evals-cli/src/run-main.adapter.ts` | R |
| `packages/evals-langfuse/AGENTS.md` | R |
| `packages/evals-langfuse/CLAUDE.md` | A |
| `packages/evals-langfuse/package.json` | R |
| `packages/evals-langfuse/src/export.test.ts` | R |
| `packages/evals-langfuse/src/index.ts` | R |
| `packages/evals-langfuse/src/langfuse-export.adapter.ts` | R |
| `packages/evals-langsmith/AGENTS.md` | R |
| `packages/evals-langsmith/CLAUDE.md` | A |
| `packages/evals-langsmith/package.json` | R |
| `packages/evals-langsmith/src/export.test.ts` | R |
| `packages/evals-langsmith/src/index.ts` | R |
| `packages/evals-langsmith/src/langsmith-export.adapter.ts` | R |
| `packages/evals/AGENTS.md` | R |
| `packages/evals/CLAUDE.md` | A |
| `packages/evals/fixtures/run-0.14.0.json` | V |
| `packages/evals/fixtures/run-0.15.0.json` | V |
| `packages/evals/fixtures/run-0.15.1.json` | V |
| `packages/evals/fixtures/run-0.16.0.json` | V |
| `packages/evals/fixtures/run-0.16.1.json` | V |
| `packages/evals/fixtures/run-0.16.2.json` | V |
| `packages/evals/fixtures/run-0.17.0.json` | V |
| `packages/evals/fixtures/run-0.17.1.json` | V |
| `packages/evals/fixtures/run-0.18.0.json` | V |
| `packages/evals/fixtures/run-0.19.0.json` | V |
| `packages/evals/fixtures/run-0.19.1.json` | V |
| `packages/evals/fixtures/run-0.19.2.json` | V |
| `packages/evals/package.json` | R |
| `packages/evals/src/adapters/evaluation-services.adapter.ts` | R |
| `packages/evals/src/adapters/evaluator-grader.adapter.ts` | R |
| `packages/evals/src/adapters/grader-calibration.adapter.ts` | R |
| `packages/evals/src/adapters/isolated-services.adapter.ts` | R |
| `packages/evals/src/adapters/run-spend.adapter.test.ts` | R |
| `packages/evals/src/adapters/run-spend.adapter.ts` | R |
| `packages/evals/src/adapters/runnable.adapter.ts` | R |
| `packages/evals/src/adapters/semantic-jev.adapter.ts` | R |
| `packages/evals/src/adapters/semantic-llm.adapter.ts` | R |
| `packages/evals/src/assessment.entity.functions.ts` | R |
| `packages/evals/src/assessment.entity.ts` | R |
| `packages/evals/src/assessment.test.ts` | R |
| `packages/evals/src/assessment.usecase.functions.ts` | R |
| `packages/evals/src/assessment.usecase.ts` | R |
| `packages/evals/src/cli.functions.ts` | R |
| `packages/evals/src/completeness.entity.functions.ts` | R |
| `packages/evals/src/completeness.entity.ts` | R |
| `packages/evals/src/contracts/evaluation-app.contract.functions.ts` | R |
| `packages/evals/src/contracts/evaluation-app.contract.ts` | R |
| `packages/evals/src/decision-comparison.entity.functions.ts` | R |
| `packages/evals/src/decision-comparison.entity.ts` | R |
| `packages/evals/src/decision-comparison.test.ts` | R |
| `packages/evals/src/domain/calibration.entity.ts` | R |
| `packages/evals/src/domain/candidate.entity.ts` | R |
| `packages/evals/src/domain/evaluation-run.entity.functions.ts` | R |
| `packages/evals/src/domain/evaluation-run.entity.ts` | R |
| `packages/evals/src/domain/evidence-projection.entity.ts` | R |
| `packages/evals/src/domain/grader-calibration.entity.functions.ts` | R |
| `packages/evals/src/domain/grader-calibration.entity.ts` | R |
| `packages/evals/src/domain/grader.entity.ts` | R |
| `packages/evals/src/domain/grading-context.entity.functions.ts` | R |
| `packages/evals/src/domain/grading-context.entity.ts` | R |
| `packages/evals/src/domain/identity.entity.functions.test.ts` | R |
| `packages/evals/src/domain/identity.entity.functions.ts` | R |
| `packages/evals/src/domain/identity.entity.ts` | R |
| `packages/evals/src/domain/journey.entity.ts` | R |
| `packages/evals/src/domain/outcome.entity.ts` | R |
| `packages/evals/src/domain/review.entity.functions.ts` | R |
| `packages/evals/src/domain/review.entity.ts` | R |
| `packages/evals/src/domain/runnable.entity.ts` | R |
| `packages/evals/src/domain/spend.entity.functions.test.ts` | R |
| `packages/evals/src/domain/spend.entity.functions.ts` | R |
| `packages/evals/src/domain/spend.entity.ts` | R |
| `packages/evals/src/domain/suite.entity.ts` | R |
| `packages/evals/src/domain/task.entity.functions.ts` | R |
| `packages/evals/src/domain/task.entity.ts` | R |
| `packages/evals/src/domain/transcript.entity.ts` | R |
| `packages/evals/src/domain/trial.entity.ts` | R |
| `packages/evals/src/evaluation-contract.test.ts` | R |
| `packages/evals/src/evaluation-score.entity.functions.ts` | R |
| `packages/evals/src/evaluation-score.entity.ts` | R |
| `packages/evals/src/evaluation-score.test.ts` | R |
| `packages/evals/src/evaluators/llm.test.ts` | R |
| `packages/evals/src/evaluators/llm.ts` | R |
| `packages/evals/src/evaluators/pairwise.ts` | R |
| `packages/evals/src/evaluators/semantic.ts` | R |
| `packages/evals/src/graders/retrieval/contextual-precision.functions.ts` | R |
| `packages/evals/src/graders/retrieval/contextual-recall.functions.ts` | R |
| `packages/evals/src/graders/retrieval/contextual-relevancy.functions.ts` | R |
| `packages/evals/src/graders/retrieval/ranking.functions.ts` | R |
| `packages/evals/src/graders/retrieval/semantic-grader.adapter.ts` | R |
| `packages/evals/src/graders/retrieval/semantic-retrieval.entity.functions.ts` | R |
| `packages/evals/src/graders/retrieval/semantic-retrieval.entity.ts` | R |
| `packages/evals/src/graders/retrieval/semantic-retrieval.test.ts` | R |
| `packages/evals/src/index.ts` | R |
| `packages/evals/src/ports/evaluation-environment.port.ts` | R |
| `packages/evals/src/ports/evaluation-export.port.ts` | R |
| `packages/evals/src/ports/evaluation-services.port.ts` | R |
| `packages/evals/src/ports/evaluation-store.port.ts` | R |
| `packages/evals/src/ports/evidence-projector.port.ts` | R |
| `packages/evals/src/ports/grader-assessment.port.ts` | R |
| `packages/evals/src/ports/runnable-execution.port.ts` | R |
| `packages/evals/src/ports/semantic-judge.port.ts` | R |
| `packages/evals/src/ports/trial-execution.port.ts` | R |
| `packages/evals/src/ports/trial-recorder.port.ts` | R |
| `packages/evals/src/run-compat.test.ts` | R |
| `packages/evals/src/semantic.entity.functions.ts` | R |
| `packages/evals/src/semantic.entity.ts` | R |
| `packages/evals/src/semantic.test.ts` | R |
| `packages/evals/src/stats.test.ts` | R |
| `packages/evals/src/stats.ts` | R |
| `packages/evals/src/testing/evaluation.test.ts` | R |
| `packages/evals/src/testing/evaluator-grader.test.ts` | R |
| `packages/evals/src/testing/fixture.testing.ts` | R |
| `packages/evals/src/testing/grader-calibration.test.ts` | R |
| `packages/evals/src/testing/scoped-layers.test.ts` | R |
| `packages/evals/src/testing/spend.test.ts` | R |
| `packages/evals/src/testing/traces.test.ts` | R |
| `packages/evals/src/testing/typed-ports.test.ts` | R |
| `packages/evals/src/usecases/run-evaluation.usecase.functions.ts` | R |
| `packages/evals/tsconfig.json` | R |
| `packages/foundry/AGENTS.md` | R |
| `packages/foundry/CLAUDE.md` | A |
| `packages/foundry/examples/specs/stringStats.md` | R |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/package.json` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/checks/fixture-reach.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/escape.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/index.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/local.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/restricted.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/scaffolding.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/undeclared.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/app/src/unexported.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/package.json` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/hidden.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/index.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/internal.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/kits/check.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/public.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/base/src/testing/fixture.testing.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/other/package.json` | V |
| `packages/foundry/fixtures/boundaries-workspace/packages/other/src/index.ts` | V |
| `packages/foundry/fixtures/boundaries-workspace/tsconfig.json` | V |
| `packages/foundry/fixtures/boundaries/src/adapters/db.ts` | V |
| `packages/foundry/fixtures/boundaries/src/barrels/model.ts` | V |
| `packages/foundry/fixtures/boundaries/src/domain/bad.ts` | V |
| `packages/foundry/fixtures/boundaries/src/domain/entity.ts` | V |
| `packages/foundry/fixtures/boundaries/src/dynamic/load.ts` | V |
| `packages/foundry/fixtures/boundaries/src/named/services.ts` | V |
| `packages/foundry/fixtures/boundaries/tsconfig.json` | V |
| `packages/foundry/fixtures/exports/CHANGELOG.md` | V |
| `packages/foundry/fixtures/exports/docs/guide.md` | V |
| `packages/foundry/fixtures/exports/packages/app/package.json` | V |
| `packages/foundry/fixtures/exports/packages/app/src/main.ts` | V |
| `packages/foundry/fixtures/exports/packages/lib/package.json` | V |
| `packages/foundry/fixtures/exports/packages/lib/src/extra.ts` | V |
| `packages/foundry/fixtures/exports/packages/lib/src/impl.ts` | V |
| `packages/foundry/fixtures/exports/packages/lib/src/index.ts` | V |
| `packages/foundry/fixtures/exports/packages/lib/src/self.ts` | V |
| `packages/foundry/fixtures/exports/packages/lib/src/tools/hammer.ts` | V |
| `packages/foundry/fixtures/exports/scripts/report.ts` | V |
| `packages/foundry/fixtures/exports/tsconfig.json` | V |
| `packages/foundry/fixtures/idioms/ambientTimeRandom.adapter.ts` | V |
| `packages/foundry/fixtures/idioms/ambientTimeRandom.ts` | V |
| `packages/foundry/fixtures/idioms/asAny.ts` | V |
| `packages/foundry/fixtures/idioms/asNever.ts` | V |
| `packages/foundry/fixtures/idioms/boundedPubSub.ts` | V |
| `packages/foundry/fixtures/idioms/callbackBufferSize.ts` | V |
| `packages/foundry/fixtures/idioms/causePretty.ts` | V |
| `packages/foundry/fixtures/idioms/clean.ts` | V |
| `packages/foundry/fixtures/idioms/codeGuard.testing.ts` | V |
| `packages/foundry/fixtures/idioms/codeGuard.ts` | V |
| `packages/foundry/fixtures/idioms/concurrencyOption.ts` | V |
| `packages/foundry/fixtures/idioms/decoding.testing.ts` | V |
| `packages/foundry/fixtures/idioms/discriminantChains.ts` | V |
| `packages/foundry/fixtures/idioms/effectFn.ts` | V |
| `packages/foundry/fixtures/idioms/effectPromise.ts` | V |
| `packages/foundry/fixtures/idioms/emptyCatch.ts` | V |
| `packages/foundry/fixtures/idioms/errorCode.ts` | V |
| `packages/foundry/fixtures/idioms/errorCodeCompare.ts` | V |
| `packages/foundry/fixtures/idioms/instanceofTaggedError.ts` | V |
| `packages/foundry/fixtures/idioms/jsonParse.ts` | V |
| `packages/foundry/fixtures/idioms/localeCompare.ts` | V |
| `packages/foundry/fixtures/idioms/loops.ts` | V |
| `packages/foundry/fixtures/idioms/noLet.ts` | V |
| `packages/foundry/fixtures/idioms/nullableReturn.ts` | V |
| `packages/foundry/fixtures/idioms/optionUnwrap.ts` | V |
| `packages/foundry/fixtures/idioms/parallelInterface.ts` | V |
| `packages/foundry/fixtures/idioms/processEnv.ts` | V |
| `packages/foundry/fixtures/idioms/promiseAll.ts` | V |
| `packages/foundry/fixtures/idioms/providerNamespace.ts` | V |
| `packages/foundry/fixtures/idioms/recordCast.ts` | V |
| `packages/foundry/fixtures/idioms/silentIgnore.ts` | V |
| `packages/foundry/fixtures/idioms/skippedTests.ts` | V |
| `packages/foundry/fixtures/idioms/sortComparator.ts` | V |
| `packages/foundry/fixtures/idioms/stringifiedCause.ts` | V |
| `packages/foundry/fixtures/idioms/syncCodec.ts` | V |
| `packages/foundry/fixtures/idioms/tagSwitch.ts` | V |
| `packages/foundry/fixtures/idioms/tryCatch.ts` | V |
| `packages/foundry/fixtures/idioms/tsconfig.json` | V |
| `packages/foundry/fixtures/idioms/unbrandedId.ts` | V |
| `packages/foundry/fixtures/idioms/unknownJson.ts` | V |
| `packages/foundry/fixtures/idioms/unknownRequirements.ts` | V |
| `packages/foundry/fixtures/typecheck/tsconfig.json` | V |
| `packages/foundry/fixtures/typecheck/typeError.ts` | V |
| `packages/foundry/foundry.config.ts` | R |
| `packages/foundry/package.json` | R |
| `packages/foundry/src/adapters/claudeImplementor.ts` | R |
| `packages/foundry/src/adapters/fileRunSink.ts` | R |
| `packages/foundry/src/adapters/readRuns.test.ts` | R |
| `packages/foundry/src/adapters/readRuns.ts` | R |
| `packages/foundry/src/adapters/scriptedImplementor.ts` | R |
| `packages/foundry/src/adapters/tempWorkspace.test.ts` | R |
| `packages/foundry/src/adapters/tempWorkspace.ts` | R |
| `packages/foundry/src/cli/check.test.ts` | R |
| `packages/foundry/src/cli/check.ts` | R |
| `packages/foundry/src/cli/demo.ts` | R |
| `packages/foundry/src/cli/report.ts` | R |
| `packages/foundry/src/domain/Brands.test.ts` | R |
| `packages/foundry/src/domain/Brands.ts` | R |
| `packages/foundry/src/domain/Errors.test.ts` | R |
| `packages/foundry/src/domain/Errors.ts` | R |
| `packages/foundry/src/domain/FactoryRun.ts` | R |
| `packages/foundry/src/domain/Finding.ts` | R |
| `packages/foundry/src/domain/Rules.test.ts` | R |
| `packages/foundry/src/domain/Rules.ts` | R |
| `packages/foundry/src/domain/Spec.ts` | R |
| `packages/foundry/src/domain/Verdict.test.ts` | R |
| `packages/foundry/src/domain/Verdict.ts` | R |
| `packages/foundry/src/domain/baseline.test.ts` | R |
| `packages/foundry/src/domain/baseline.ts` | R |
| `packages/foundry/src/gates/TsProject.port.ts` | R |
| `packages/foundry/src/gates/astWalk.ts` | R |
| `packages/foundry/src/gates/boundariesGate.test.ts` | R |
| `packages/foundry/src/gates/boundariesGate.ts` | R |
| `packages/foundry/src/gates/idiomGate.test.ts` | R |
| `packages/foundry/src/gates/idiomGate.ts` | R |
| `packages/foundry/src/gates/judgeGate.test.ts` | R |
| `packages/foundry/src/gates/judgeGate.ts` | R |
| `packages/foundry/src/gates/privateTextGate.test.ts` | R |
| `packages/foundry/src/gates/privateTextGate.ts` | R |
| `packages/foundry/src/gates/registrationGate.test.ts` | R |
| `packages/foundry/src/gates/registrationGate.ts` | R |
| `packages/foundry/src/gates/renderQualityBar.test.ts` | R |
| `packages/foundry/src/gates/renderQualityBar.ts` | R |
| `packages/foundry/src/gates/rules/ambientServices.ts` | R |
| `packages/foundry/src/gates/rules/boundaryDecoding.ts` | R |
| `packages/foundry/src/gates/rules/brandedIdFields.ts` | R |
| `packages/foundry/src/gates/rules/callbackBufferSize.ts` | R |
| `packages/foundry/src/gates/rules/concurrencyOption.ts` | R |
| `packages/foundry/src/gates/rules/custom.ts` | R |
| `packages/foundry/src/gates/rules/deterministicOrder.ts` | R |
| `packages/foundry/src/gates/rules/effectArchitecture.test.ts` | R |
| `packages/foundry/src/gates/rules/effectArchitecture.ts` | R |
| `packages/foundry/src/gates/rules/effectFn.ts` | R |
| `packages/foundry/src/gates/rules/errorValues.ts` | R |
| `packages/foundry/src/gates/rules/exportsHaveConsumers.test.ts` | R |
| `packages/foundry/src/gates/rules/exportsHaveConsumers.ts` | R |
| `packages/foundry/src/gates/rules/index.ts` | R |
| `packages/foundry/src/gates/rules/matchOverTagSwitch.ts` | R |
| `packages/foundry/src/gates/rules/noAsAny.ts` | R |
| `packages/foundry/src/gates/rules/noAsNever.ts` | R |
| `packages/foundry/src/gates/rules/noEmptyCatch.ts` | R |
| `packages/foundry/src/gates/rules/noLet.ts` | R |
| `packages/foundry/src/gates/rules/noLoopStatements.ts` | R |
| `packages/foundry/src/gates/rules/noNullableReturn.ts` | R |
| `packages/foundry/src/gates/rules/noParallelInterface.ts` | R |
| `packages/foundry/src/gates/rules/noSkippedTests.ts` | R |
| `packages/foundry/src/gates/rules/noTryCatch.ts` | R |
| `packages/foundry/src/gates/rules/optionUnwrap.ts` | R |
| `packages/foundry/src/gates/rules/packs.ts` | R |
| `packages/foundry/src/gates/rules/promiseInterop.ts` | R |
| `packages/foundry/src/gates/rules/providerNamespace.ts` | R |
| `packages/foundry/src/gates/rules/silentFailures.ts` | R |
| `packages/foundry/src/gates/rules/syntax.ts` | R |
| `packages/foundry/src/gates/rules/unknownRequirements.ts` | R |
| `packages/foundry/src/gates/typecheckGate.test.ts` | R |
| `packages/foundry/src/gates/typecheckGate.ts` | R |
| `packages/foundry/src/gates/withBaseline.test.ts` | R |
| `packages/foundry/src/gates/withBaseline.ts` | R |
| `packages/foundry/src/index.ts` | R |
| `packages/foundry/src/main.ts` | R |
| `packages/foundry/src/pipeline/forge.test.ts` | R |
| `packages/foundry/src/pipeline/forge.ts` | R |
| `packages/foundry/src/pipeline/lessons.test.ts` | R |
| `packages/foundry/src/pipeline/lessons.ts` | R |
| `packages/foundry/src/pipeline/renderFeedback.test.ts` | R |
| `packages/foundry/src/pipeline/renderFeedback.ts` | R |
| `packages/foundry/src/pipeline/runPipeline.test.ts` | R |
| `packages/foundry/src/pipeline/runPipeline.ts` | R |
| `packages/foundry/src/ports/Gate.ts` | R |
| `packages/foundry/src/ports/Implementor.ts` | R |
| `packages/foundry/src/ports/RunSink.ts` | R |
| `packages/foundry/tsconfig.json` | R |
| `packages/foundry/vendor/effect-architecture/rules.ts` | V |
| `packages/foundry/vendor/effect/rules.ts` | V |
| `packages/foundry/vendor/quality/rules.ts` | V |
| `packages/plugin-agent-loop/AGENTS.md` | R |
| `packages/plugin-agent-loop/CLAUDE.md` | A |
| `packages/plugin-agent-loop/package.json` | R |
| `packages/plugin-agent-loop/src/accepted-input.test.ts` | R |
| `packages/plugin-agent-loop/src/context-overflow.test.ts` | R |
| `packages/plugin-agent-loop/src/index.ts` | R |
| `packages/plugin-agent-loop/src/loop-event.entity.ts` | R |
| `packages/plugin-agent-loop/src/loop.test.ts` | R |
| `packages/plugin-agent-loop/src/loop.ts` | R |
| `packages/plugin-agent-loop/src/model-failures.test.ts` | R |
| `packages/plugin-agent-loop/src/request-attempt.entity.functions.test.ts` | R |
| `packages/plugin-agent-loop/src/request-attempt.entity.functions.ts` | R |
| `packages/plugin-agent-loop/src/request-attempt.entity.ts` | R |
| `packages/plugin-agent-loop/src/response-gate.entity.functions.test.ts` | R |
| `packages/plugin-agent-loop/src/response-gate.entity.functions.ts` | R |
| `packages/plugin-agent-loop/src/response-gate.entity.ts` | R |
| `packages/plugin-agent-loop/src/step-ledger.entity.functions.test.ts` | R |
| `packages/plugin-agent-loop/src/step-ledger.entity.functions.ts` | R |
| `packages/plugin-agent-loop/src/step-ledger.entity.ts` | R |
| `packages/plugin-agent-loop/src/step-loop.adapter.test.ts` | R |
| `packages/plugin-agent-loop/src/step-loop.adapter.ts` | R |
| `packages/plugin-agent-loop/src/tool-result-receipt.test.ts` | R |
| `packages/plugin-agent-loop/tsconfig.json` | R |
| `packages/plugin-knowledge-postgres/AGENTS.md` | R |
| `packages/plugin-knowledge-postgres/CLAUDE.md` | A |
| `packages/plugin-knowledge-postgres/package.json` | R |
| `packages/plugin-knowledge-postgres/src/index.ts` | R |
| `packages/plugin-knowledge-postgres/src/knowledge-postgres.entity.functions.test.ts` | R |
| `packages/plugin-knowledge-postgres/src/knowledge-postgres.entity.functions.ts` | R |
| `packages/plugin-knowledge-postgres/src/knowledge-postgres.entity.ts` | R |
| `packages/plugin-knowledge-postgres/src/knowledge-store.adapter.test.ts` | R |
| `packages/plugin-knowledge-postgres/src/knowledge-store.adapter.ts` | R |
| `packages/plugin-knowledge-postgres/src/plugin.adapter.ts` | R |
| `packages/plugin-knowledge-postgres/src/postgres-connection.adapter.test.ts` | R |
| `packages/plugin-knowledge-postgres/src/postgres-connection.adapter.ts` | R |
| `packages/plugin-knowledge-postgres/tsconfig.json` | R |
| `packages/plugin-memory-digest/AGENTS.md` | R |
| `packages/plugin-memory-digest/CLAUDE.md` | A |
| `packages/plugin-memory-digest/package.json` | R |
| `packages/plugin-memory-digest/src/index.ts` | R |
| `packages/plugin-memory-digest/src/plugin.adapter.test.ts` | R |
| `packages/plugin-memory-digest/src/plugin.adapter.ts` | R |
| `packages/plugin-memory-digest/tsconfig.json` | R |
| `packages/plugin-memory-summary/AGENTS.md` | R |
| `packages/plugin-memory-summary/CLAUDE.md` | A |
| `packages/plugin-memory-summary/package.json` | R |
| `packages/plugin-memory-summary/src/index.ts` | R |
| `packages/plugin-memory-summary/src/maintenance-policy.adapter.test.ts` | R |
| `packages/plugin-memory-summary/src/plugin.adapter.test.ts` | R |
| `packages/plugin-memory-summary/src/plugin.adapter.ts` | R |
| `packages/plugin-memory-summary/src/summary-attempt.entity.functions.test.ts` | R |
| `packages/plugin-memory-summary/src/summary-attempt.entity.functions.ts` | R |
| `packages/plugin-memory-summary/src/summary-attempt.entity.ts` | R |
| `packages/plugin-memory-summary/tsconfig.json` | R |
| `packages/plugin-memory-window/AGENTS.md` | R |
| `packages/plugin-memory-window/CLAUDE.md` | A |
| `packages/plugin-memory-window/package.json` | R |
| `packages/plugin-memory-window/src/index.ts` | R |
| `packages/plugin-memory-window/src/maintenance-policy.adapter.test.ts` | R |
| `packages/plugin-memory-window/src/plugin.adapter.test.ts` | R |
| `packages/plugin-memory-window/src/plugin.adapter.ts` | R |
| `packages/plugin-memory-window/tsconfig.json` | R |
| `packages/plugin-memory/AGENTS.md` | R |
| `packages/plugin-memory/CLAUDE.md` | A |
| `packages/plugin-memory/package.json` | R |
| `packages/plugin-memory/src/index.ts` | R |
| `packages/plugin-memory/src/memory-capability.adapter.test.ts` | R |
| `packages/plugin-memory/src/memory-capability.adapter.ts` | R |
| `packages/plugin-memory/src/memory-capture.adapter.test.ts` | R |
| `packages/plugin-memory/src/memory-capture.adapter.ts` | R |
| `packages/plugin-memory/src/memory-capture.testing.ts` | R |
| `packages/plugin-memory/src/memory-engine.adapter.test.ts` | R |
| `packages/plugin-memory/src/memory-engine.adapter.ts` | R |
| `packages/plugin-memory/src/memory-worker.test.ts` | R |
| `packages/plugin-memory/src/memory.conformance.test.ts` | R |
| `packages/plugin-memory/src/memory.entity.functions.test.ts` | R |
| `packages/plugin-memory/src/memory.entity.functions.ts` | R |
| `packages/plugin-memory/src/memory.entity.ts` | R |
| `packages/plugin-memory/src/memory.journey.test.ts` | R |
| `packages/plugin-memory/src/memory.testing.ts` | R |
| `packages/plugin-memory/src/plugin.adapter.ts` | R |
| `packages/plugin-memory/src/ports/memory-capture.port.ts` | R |
| `packages/plugin-memory/tsconfig.json` | R |
| `packages/plugin-models/AGENTS.md` | R |
| `packages/plugin-models/CLAUDE.md` | A |
| `packages/plugin-models/fixtures/config-0.14.0.json` | R |
| `packages/plugin-models/fixtures/tmux-model.ts` | R |
| `packages/plugin-models/package.json` | R |
| `packages/plugin-models/src/auth/anthropicOAuth.test.ts` | R |
| `packages/plugin-models/src/auth/anthropicOAuth.ts` | R |
| `packages/plugin-models/src/auth/auth-store.conformance.test.ts` | R |
| `packages/plugin-models/src/auth/auth-store.conformance.ts` | R |
| `packages/plugin-models/src/auth/credential-input.entity.functions.test.ts` | R |
| `packages/plugin-models/src/auth/credential-input.entity.functions.ts` | R |
| `packages/plugin-models/src/auth/credential-input.entity.ts` | R |
| `packages/plugin-models/src/auth/credential-refresh.entity.functions.test.ts` | R |
| `packages/plugin-models/src/auth/credential-refresh.entity.functions.ts` | R |
| `packages/plugin-models/src/auth/credential-refresh.entity.ts` | R |
| `packages/plugin-models/src/auth/localAuth.test.ts` | R |
| `packages/plugin-models/src/auth/localAuth.ts` | R |
| `packages/plugin-models/src/auth/memory-auth.adapter.test.ts` | R |
| `packages/plugin-models/src/auth/memory-auth.adapter.ts` | R |
| `packages/plugin-models/src/auth/openAiCodexOAuth.test.ts` | R |
| `packages/plugin-models/src/auth/openAiCodexOAuth.ts` | R |
| `packages/plugin-models/src/auth/token-response.entity.functions.test.ts` | R |
| `packages/plugin-models/src/auth/token-response.entity.functions.ts` | R |
| `packages/plugin-models/src/auth/token-response.entity.ts` | R |
| `packages/plugin-models/src/compat/index.ts` | R |
| `packages/plugin-models/src/conformance/index.ts` | R |
| `packages/plugin-models/src/index.ts` | R |
| `packages/plugin-models/src/llm/anthropic-endpoints.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/anthropic-sdk-config.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/chat-wire.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/chat-wire.entity.ts` | R |
| `packages/plugin-models/src/llm/compat-request-policy.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/compat-spend.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/compat-telemetry.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/compat-telemetry.adapter.ts` | R |
| `packages/plugin-models/src/llm/compat.test.ts` | R |
| `packages/plugin-models/src/llm/compat.ts` | R |
| `packages/plugin-models/src/llm/messages-descriptor.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/messages-transport-failures.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/model-completion.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/model-completion.adapter.ts` | R |
| `packages/plugin-models/src/llm/model-completion.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/model-completion.entity.ts` | R |
| `packages/plugin-models/src/llm/model-retry-policy.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/model-retry-policy.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/model-retry-policy.entity.test.ts` | R |
| `packages/plugin-models/src/llm/model-retry-policy.entity.ts` | R |
| `packages/plugin-models/src/llm/model-settings.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/model-settings.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/model-settings.entity.ts` | R |
| `packages/plugin-models/src/llm/model-spend-guard.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/model-spend-guard.adapter.ts` | R |
| `packages/plugin-models/src/llm/model-spend.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/model-spend.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/model-spend.entity.ts` | R |
| `packages/plugin-models/src/llm/model-usage.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/model-usage.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/model-usage.entity.ts` | R |
| `packages/plugin-models/src/llm/modelCatalog.test.ts` | R |
| `packages/plugin-models/src/llm/modelCatalog.ts` | R |
| `packages/plugin-models/src/llm/openAiCodex-request-policy.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/openAiCodex.test.ts` | R |
| `packages/plugin-models/src/llm/openAiCodex.ts` | R |
| `packages/plugin-models/src/llm/openAiCodexWebSocket.test.ts` | R |
| `packages/plugin-models/src/llm/openAiCodexWebSocket.ts` | R |
| `packages/plugin-models/src/llm/prompt-cache-frame.entity.ts` | R |
| `packages/plugin-models/src/llm/prompt-cache-wire.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/prompt-cache.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/prompt-cache.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/prompt-cache.entity.ts` | R |
| `packages/plugin-models/src/llm/provider-client.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/provider-client.adapter.ts` | R |
| `packages/plugin-models/src/llm/provider-failure.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/provider-failure.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/provider-failure.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/provider-failure.entity.ts` | R |
| `packages/plugin-models/src/llm/provider-overflow.adapter.test.ts` | R |
| `packages/plugin-models/src/llm/provider-profile.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/provider-profile.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/provider-profile.entity.ts` | R |
| `packages/plugin-models/src/llm/providers.test.ts` | R |
| `packages/plugin-models/src/llm/providers.ts` | R |
| `packages/plugin-models/src/llm/retry.test.ts` | R |
| `packages/plugin-models/src/llm/retry.ts` | R |
| `packages/plugin-models/src/llm/router.test.ts` | R |
| `packages/plugin-models/src/llm/router.ts` | R |
| `packages/plugin-models/src/llm/sse.test.ts` | R |
| `packages/plugin-models/src/llm/sse.ts` | R |
| `packages/plugin-models/src/llm/thinking-binding.entity.functions.test.ts` | R |
| `packages/plugin-models/src/llm/thinking-binding.entity.functions.ts` | R |
| `packages/plugin-models/src/llm/thinking-binding.entity.ts` | R |
| `packages/plugin-models/src/llm/utilityLlm.test.ts` | R |
| `packages/plugin-models/src/llm/utilityLlm.ts` | R |
| `packages/plugin-models/src/plugin.adapter.test.ts` | R |
| `packages/plugin-models/src/plugin.adapter.ts` | R |
| `packages/plugin-models/src/ports/auth-store.port.ts` | R |
| `packages/plugin-models/src/ports/host-credentials.port.ts` | R |
| `packages/plugin-models/src/ports/model-call-completion.port.ts` | R |
| `packages/plugin-models/src/ports/model-endpoints.port.ts` | R |
| `packages/plugin-models/src/ports/model-retry-policy.port.ts` | R |
| `packages/plugin-models/src/ports/model-settings.port.ts` | R |
| `packages/plugin-models/src/ports/model-spend-guard.port.ts` | R |
| `packages/plugin-models/src/ports/models-transport.port.ts` | R |
| `packages/plugin-models/src/ports/prompt-cache-frame.port.ts` | R |
| `packages/plugin-models/src/ports/settings-store.port.ts` | R |
| `packages/plugin-models/src/ports/thinking-binding.port.ts` | R |
| `packages/plugin-models/src/scripted/index.ts` | R |
| `packages/plugin-models/src/settings/localSettings.test.ts` | R |
| `packages/plugin-models/src/settings/localSettings.ts` | R |
| `packages/plugin-models/src/settings/memory-settings.adapter.test.ts` | R |
| `packages/plugin-models/src/settings/memory-settings.adapter.ts` | R |
| `packages/plugin-models/src/settings/roleView.test.ts` | R |
| `packages/plugin-models/src/settings/roleView.ts` | R |
| `packages/plugin-models/src/settings/settings-store.conformance.test.ts` | R |
| `packages/plugin-models/src/settings/settings-store.conformance.ts` | R |
| `packages/plugin-models/src/settings/settings-value.entity.functions.test.ts` | R |
| `packages/plugin-models/src/settings/settings-value.entity.functions.ts` | R |
| `packages/plugin-models/src/settings/settings-value.entity.ts` | R |
| `packages/plugin-models/src/storage/json-file.ts` | R |
| `packages/plugin-models/src/testing.ts` | R |
| `packages/plugin-models/src/transport/http-proxy.entity.functions.test.ts` | R |
| `packages/plugin-models/src/transport/http-proxy.entity.functions.ts` | R |
| `packages/plugin-models/src/transport/http-proxy.entity.ts` | R |
| `packages/plugin-models/src/transport/model-call-accounting.adapter.test.ts` | R |
| `packages/plugin-models/src/transport/model-request.conformance.test.ts` | R |
| `packages/plugin-models/src/transport/model-request.conformance.ts` | R |
| `packages/plugin-models/src/transport/models-transport.adapter.test.ts` | R |
| `packages/plugin-models/src/transport/models-transport.adapter.ts` | R |
| `packages/plugin-models/src/transport/models-transport.node.adapter.test.ts` | R |
| `packages/plugin-models/src/transport/models-transport.node.testing.ts` | R |
| `packages/plugin-models/src/transport/recording-proxy.testing.ts` | R |
| `packages/plugin-models/src/transport/resilient-http-client.adapter.test.ts` | R |
| `packages/plugin-models/src/transport/resilient-http-client.adapter.ts` | R |
| `packages/plugin-models/src/transport/scripted-chat.adapter.test.ts` | R |
| `packages/plugin-models/src/transport/scripted-chat.adapter.ts` | R |
| `packages/plugin-models/src/transport/scripted-chat.entity.functions.ts` | R |
| `packages/plugin-models/src/transport/scripted-chat.entity.ts` | R |
| `packages/plugin-models/src/transport/undici-fetch.adapter.ts` | R |
| `packages/plugin-models/tsconfig.json` | R |
| `packages/plugin-rag/AGENTS.md` | R |
| `packages/plugin-rag/CLAUDE.md` | A |
| `packages/plugin-rag/package.json` | R |
| `packages/plugin-rag/src/index.ts` | R |
| `packages/plugin-rag/src/plugin.adapter.ts` | R |
| `packages/plugin-rag/src/rag-capability.adapter.test.ts` | R |
| `packages/plugin-rag/src/rag-capability.adapter.ts` | R |
| `packages/plugin-rag/src/rag-engine.adapter.test.ts` | R |
| `packages/plugin-rag/src/rag-engine.adapter.ts` | R |
| `packages/plugin-rag/src/rag-narrowing.journey.test.ts` | R |
| `packages/plugin-rag/src/rag-query-controls.test.ts` | R |
| `packages/plugin-rag/src/rag-worker.test.ts` | R |
| `packages/plugin-rag/src/rag.conformance.test.ts` | R |
| `packages/plugin-rag/src/rag.entity.functions.ts` | R |
| `packages/plugin-rag/src/rag.entity.ts` | R |
| `packages/plugin-rag/src/rag.journey.test.ts` | R |
| `packages/plugin-rag/src/rag.testing.ts` | R |
| `packages/plugin-rag/tsconfig.json` | R |
| `packages/plugin-render/AGENTS.md` | R |
| `packages/plugin-render/CLAUDE.md` | A |
| `packages/plugin-render/README.md` | R |
| `packages/plugin-render/package.json` | R |
| `packages/plugin-render/src/domain/feed-frame.entity.functions.ts` | R |
| `packages/plugin-render/src/domain/feed-frame.entity.ts` | R |
| `packages/plugin-render/src/domain/render-output.entity.ts` | R |
| `packages/plugin-render/src/domain/render-surface.entity.functions.ts` | R |
| `packages/plugin-render/src/domain/render-surface.entity.ts` | R |
| `packages/plugin-render/src/domain/sse-encoding.entity.functions.ts` | R |
| `packages/plugin-render/src/domain/sse-encoding.entity.ts` | R |
| `packages/plugin-render/src/index.ts` | R |
| `packages/plugin-render/src/output.ts` | R |
| `packages/plugin-render/src/plugin.adapter.ts` | R |
| `packages/plugin-render/src/ports/render-output.port.ts` | R |
| `packages/plugin-render/src/ports/render.port.ts` | R |
| `packages/plugin-render/src/render-feed.adapter.ts` | R |
| `packages/plugin-render/src/render-live.sessions.adapter.ts` | R |
| `packages/plugin-render/src/render-live.sessions.test.ts` | R |
| `packages/plugin-render/src/render-output.adapter.ts` | R |
| `packages/plugin-render/src/render-output.test.ts` | R |
| `packages/plugin-render/src/render-output.tools.ts` | R |
| `packages/plugin-render/src/render-store.memory.adapter.ts` | R |
| `packages/plugin-render/src/render-surface.adapter.ts` | R |
| `packages/plugin-render/src/render-surface.conformance.test.ts` | R |
| `packages/plugin-render/src/render-surface.conformance.ts` | R |
| `packages/plugin-render/src/render-surface.test.ts` | R |
| `packages/plugin-render/src/render-tail.sessions.adapter.ts` | R |
| `packages/plugin-render/src/render-tail.sessions.test.ts` | R |
| `packages/plugin-render/src/render-transport.adapter.ts` | R |
| `packages/plugin-render/src/render-transport.conformance.ts` | R |
| `packages/plugin-render/src/render-transport.test.ts` | R |
| `packages/plugin-render/tsconfig.json` | R |
| `packages/plugin-session-files/AGENTS.md` | R |
| `packages/plugin-session-files/CLAUDE.md` | A |
| `packages/plugin-session-files/fixtures/session-files-holder.mjs` | R |
| `packages/plugin-session-files/package.json` | R |
| `packages/plugin-session-files/src/bounded-call.adapter.test.ts` | R |
| `packages/plugin-session-files/src/bounded-call.adapter.ts` | R |
| `packages/plugin-session-files/src/files-io.adapter.test.ts` | R |
| `packages/plugin-session-files/src/files-io.adapter.ts` | R |
| `packages/plugin-session-files/src/index.ts` | R |
| `packages/plugin-session-files/src/media-store-directory.adapter.test.ts` | R |
| `packages/plugin-session-files/src/media-store-directory.adapter.ts` | R |
| `packages/plugin-session-files/src/media-store-directory.entity.ts` | R |
| `packages/plugin-session-files/src/plugin.adapter.ts` | R |
| `packages/plugin-session-files/src/session-files.entity.functions.test.ts` | R |
| `packages/plugin-session-files/src/session-files.entity.functions.ts` | R |
| `packages/plugin-session-files/src/session-files.entity.ts` | R |
| `packages/plugin-session-files/src/session-log.adapter.test.ts` | R |
| `packages/plugin-session-files/src/session-log.adapter.ts` | R |
| `packages/plugin-session-files/src/session-recovery.test.ts` | R |
| `packages/plugin-session-files/src/sessions.conformance.test.ts` | R |
| `packages/plugin-session-files/tsconfig.json` | R |
| `packages/plugin-session-sqlite/AGENTS.md` | R |
| `packages/plugin-session-sqlite/CLAUDE.md` | A |
| `packages/plugin-session-sqlite/package.json` | R |
| `packages/plugin-session-sqlite/src/index.ts` | R |
| `packages/plugin-session-sqlite/src/session-holder.testing.ts` | R |
| `packages/plugin-session-sqlite/src/session-log.adapter.test.ts` | R |
| `packages/plugin-session-sqlite/src/session-log.adapter.ts` | R |
| `packages/plugin-session-sqlite/src/session-recovery.test.ts` | R |
| `packages/plugin-session-sqlite/src/sessions.conformance.test.ts` | R |
| `packages/plugin-session-sqlite/tsconfig.json` | R |
| `packages/plugin-sessions/AGENTS.md` | R |
| `packages/plugin-sessions/CLAUDE.md` | A |
| `packages/plugin-sessions/package.json` | R |
| `packages/plugin-sessions/src/durable-steering.adapter.test.ts` | V |
| `packages/plugin-sessions/src/inbox-drain-after-end.test.ts` | V |
| `packages/plugin-sessions/src/inbox-drain.adapter.test.ts` | V |
| `packages/plugin-sessions/src/inbox-drain.adapter.ts` | R |
| `packages/plugin-sessions/src/inbox-drain.entity.functions.test.ts` | V |
| `packages/plugin-sessions/src/inbox-drain.entity.functions.ts` | R |
| `packages/plugin-sessions/src/inbox-drain.entity.ts` | R |
| `packages/plugin-sessions/src/index.ts` | R |
| `packages/plugin-sessions/src/memory-snapshot.adapter.test.ts` | V |
| `packages/plugin-sessions/src/memory-snapshot.adapter.ts` | R |
| `packages/plugin-sessions/src/opening-commit.adapter.test.ts` | R |
| `packages/plugin-sessions/src/plugin.adapter.ts` | R |
| `packages/plugin-sessions/src/process-liveness.adapter.ts` | R |
| `packages/plugin-sessions/src/queued-input.adapter.test.ts` | V |
| `packages/plugin-sessions/src/session-channel.entity.ts` | R |
| `packages/plugin-sessions/src/session-channel.memory.adapter.test.ts` | R |
| `packages/plugin-sessions/src/session-channel.memory.adapter.ts` | R |
| `packages/plugin-sessions/src/sessions-state.entity.functions.test.ts` | V |
| `packages/plugin-sessions/src/sessions-state.entity.functions.ts` | R |
| `packages/plugin-sessions/src/sessions-state.entity.ts` | R |
| `packages/plugin-sessions/src/sessions.adapter.test.ts` | V |
| `packages/plugin-sessions/src/sessions.adapter.ts` | R |
| `packages/plugin-sessions/src/sessions.conformance.test.ts` | V |
| `packages/plugin-sessions/src/sessions.media-store.test.ts` | V |
| `packages/plugin-sessions/src/turn-writer.adapter.ts` | R |
| `packages/plugin-sessions/src/turn-writer.entity.functions.test.ts` | V |
| `packages/plugin-sessions/src/turn-writer.entity.functions.ts` | R |
| `packages/plugin-sessions/src/turn-writer.entity.ts` | R |
| `packages/plugin-sessions/src/waiting-input.adapter.test.ts` | V |
| `packages/plugin-sessions/tsconfig.json` | R |
| `packages/plugin-tasks/AGENTS.md` | R |
| `packages/plugin-tasks/CLAUDE.md` | A |
| `packages/plugin-tasks/package.json` | R |
| `packages/plugin-tasks/src/index.ts` | R |
| `packages/plugin-tasks/src/plugin.adapter.ts` | R |
| `packages/plugin-tasks/src/task-controls.entity.functions.test.ts` | R |
| `packages/plugin-tasks/src/task-controls.entity.functions.ts` | R |
| `packages/plugin-tasks/src/task-records.entity.ts` | R |
| `packages/plugin-tasks/src/task-runner.adapter.test.ts` | R |
| `packages/plugin-tasks/src/task-runner.adapter.ts` | R |
| `packages/plugin-tasks/src/task.entity.functions.test.ts` | R |
| `packages/plugin-tasks/src/task.entity.functions.ts` | R |
| `packages/plugin-tasks/src/tasks-capability.adapter.test.ts` | R |
| `packages/plugin-tasks/src/tasks-capability.adapter.ts` | R |
| `packages/plugin-tasks/src/tasks-context.port.ts` | R |
| `packages/plugin-tasks/src/tasks-trace.adapter.test.ts` | R |
| `packages/plugin-tasks/src/tasks.adapter.test.ts` | R |
| `packages/plugin-tasks/src/tasks.adapter.ts` | R |
| `packages/plugin-tasks/src/tasks.conformance.test.ts` | R |
| `packages/plugin-tasks/tsconfig.json` | R |
| `packages/plugin-telemetry/AGENTS.md` | R |
| `packages/plugin-telemetry/CLAUDE.md` | A |
| `packages/plugin-telemetry/package.json` | R |
| `packages/plugin-telemetry/src/index.ts` | R |
| `packages/plugin-telemetry/src/langsmith-inheritance.journey.test.ts` | R |
| `packages/plugin-telemetry/src/langsmith-telemetry.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/langsmith-telemetry.adapter.ts` | R |
| `packages/plugin-telemetry/src/langsmith-telemetry.entity.functions.test.ts` | R |
| `packages/plugin-telemetry/src/langsmith-telemetry.entity.functions.ts` | R |
| `packages/plugin-telemetry/src/langsmith-telemetry.entity.ts` | R |
| `packages/plugin-telemetry/src/langsmith-tracer.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/langsmith-tracer.adapter.ts` | R |
| `packages/plugin-telemetry/src/model-call-telemetry.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/otlp-span-policy.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/otlp-span-policy.adapter.ts` | R |
| `packages/plugin-telemetry/src/otlp-telemetry.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/otlp-telemetry.adapter.ts` | R |
| `packages/plugin-telemetry/src/otlp-telemetry.entity.functions.test.ts` | R |
| `packages/plugin-telemetry/src/otlp-telemetry.entity.functions.ts` | R |
| `packages/plugin-telemetry/src/otlp-telemetry.entity.ts` | R |
| `packages/plugin-telemetry/src/plugin.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/plugin.adapter.ts` | R |
| `packages/plugin-telemetry/src/scripted-turn.testing.ts` | R |
| `packages/plugin-telemetry/src/telemetry-metrics.ts` | R |
| `packages/plugin-telemetry/src/telemetry.entity.functions.test.ts` | R |
| `packages/plugin-telemetry/src/telemetry.entity.functions.ts` | R |
| `packages/plugin-telemetry/src/telemetry.entity.ts` | R |
| `packages/plugin-telemetry/src/turn-telemetry.adapter.test.ts` | R |
| `packages/plugin-telemetry/src/turn-telemetry.adapter.ts` | R |
| `packages/plugin-telemetry/tsconfig.json` | R |
| `packages/plugin-tool-discovery/AGENTS.md` | R |
| `packages/plugin-tool-discovery/CLAUDE.md` | A |
| `packages/plugin-tool-discovery/package.json` | R |
| `packages/plugin-tool-discovery/src/index.ts` | R |
| `packages/plugin-tool-discovery/src/plugin.adapter.ts` | R |
| `packages/plugin-tool-discovery/src/registry.adapter.test.ts` | R |
| `packages/plugin-tool-discovery/src/registry.adapter.ts` | R |
| `packages/plugin-tool-discovery/src/tool-interceptor.adapter.test.ts` | R |
| `packages/plugin-tool-discovery/src/tool-interceptor.adapter.ts` | R |
| `packages/plugin-tool-discovery/src/tool-policy.entity.functions.test.ts` | R |
| `packages/plugin-tool-discovery/src/tool-policy.entity.functions.ts` | R |
| `packages/plugin-tool-discovery/src/tool-policy.entity.ts` | R |
| `packages/plugin-tool-discovery/tsconfig.json` | R |
| `packages/plugin-workspace/AGENTS.md` | R |
| `packages/plugin-workspace/CLAUDE.md` | A |
| `packages/plugin-workspace/package.json` | R |
| `packages/plugin-workspace/src/bash-tool.adapter.ts` | R |
| `packages/plugin-workspace/src/bash.adapter.test.ts` | R |
| `packages/plugin-workspace/src/bash.adapter.ts` | R |
| `packages/plugin-workspace/src/file-system.adapter.test.ts` | R |
| `packages/plugin-workspace/src/file-system.adapter.ts` | R |
| `packages/plugin-workspace/src/image-resizer.adapter.test.ts` | R |
| `packages/plugin-workspace/src/image-resizer.adapter.ts` | R |
| `packages/plugin-workspace/src/image-resizer.entity.functions.ts` | R |
| `packages/plugin-workspace/src/image-resizer.entity.ts` | R |
| `packages/plugin-workspace/src/index.ts` | R |
| `packages/plugin-workspace/src/local-system.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/local-system.entity.functions.ts` | R |
| `packages/plugin-workspace/src/local-system.entity.ts` | R |
| `packages/plugin-workspace/src/plugin.adapter.test.ts` | R |
| `packages/plugin-workspace/src/plugin.adapter.ts` | R |
| `packages/plugin-workspace/src/read-tools.adapter.ts` | R |
| `packages/plugin-workspace/src/ripgrep.adapter.test.ts` | R |
| `packages/plugin-workspace/src/ripgrep.adapter.ts` | R |
| `packages/plugin-workspace/src/ripgrep.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/ripgrep.entity.functions.ts` | R |
| `packages/plugin-workspace/src/ripgrep.entity.ts` | R |
| `packages/plugin-workspace/src/shell.entity.functions.ts` | R |
| `packages/plugin-workspace/src/skills/skills-directory.adapter.test.ts` | R |
| `packages/plugin-workspace/src/skills/skills-directory.adapter.ts` | R |
| `packages/plugin-workspace/src/skills/skills-directory.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/skills/skills-directory.entity.functions.ts` | R |
| `packages/plugin-workspace/src/skills/skills-directory.entity.ts` | R |
| `packages/plugin-workspace/src/text-edit.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/text-edit.entity.functions.ts` | R |
| `packages/plugin-workspace/src/text-edit.entity.ts` | R |
| `packages/plugin-workspace/src/text-search.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/text-search.entity.functions.ts` | R |
| `packages/plugin-workspace/src/text-search.entity.ts` | R |
| `packages/plugin-workspace/src/text-window.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/text-window.entity.functions.ts` | R |
| `packages/plugin-workspace/src/text-window.entity.ts` | R |
| `packages/plugin-workspace/src/workspace-path.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/workspace-path.entity.functions.ts` | R |
| `packages/plugin-workspace/src/workspace-path.entity.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.adapter.test.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.adapter.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.entity.functions.test.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.entity.functions.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.entity.ts` | R |
| `packages/plugin-workspace/src/workspace-tools.journey.test.ts` | R |
| `packages/plugin-workspace/src/write-tools.adapter.ts` | R |
| `packages/plugin-workspace/tsconfig.json` | R |
| `packages/process-host/AGENTS.md` | R |
| `packages/process-host/CLAUDE.md` | A |
| `packages/process-host/fixtures/protocol-1.ndjson` | V |
| `packages/process-host/package.json` | R |
| `packages/process-host/src/index.ts` | R |
| `packages/process-host/src/peer-mask.adapter.test.ts` | R |
| `packages/process-host/src/ports/process-peer.port.ts` | R |
| `packages/process-host/src/process-host-lifecycle.journey.test.ts` | R |
| `packages/process-host/src/process-host.adapter.ts` | R |
| `packages/process-host/src/process-host.entity.functions.ts` | R |
| `packages/process-host/src/process-host.entity.ts` | R |
| `packages/process-host/src/process-host.journey.test.ts` | R |
| `packages/process-host/src/process-peer.conformance.test.ts` | R |
| `packages/process-host/src/process-peer.conformance.ts` | R |
| `packages/process-host/src/process-peer.entity.ts` | R |
| `packages/process-host/src/process-protocol-fixtures.test.ts` | R |
| `packages/process-host/src/process-protocol.entity.functions.test.ts` | R |
| `packages/process-host/src/process-protocol.entity.functions.ts` | R |
| `packages/process-host/src/process-protocol.entity.test.ts` | R |
| `packages/process-host/src/process-protocol.entity.ts` | R |
| `packages/process-host/src/process-runtime.adapter.ts` | R |
| `packages/process-host/src/process-runtime.entity.ts` | R |
| `packages/process-host/src/process-shutdown-review.test.ts` | R |
| `packages/process-host/src/stdio-peer.adapter.test.ts` | R |
| `packages/process-host/src/stdio-peer.adapter.ts` | R |
| `packages/process-host/src/stdio-peer.testing.ts` | R |
| `packages/process-host/tsconfig.json` | R |
| `packages/runtime/AGENTS.md` | R |
| `packages/runtime/CLAUDE.md` | A |
| `packages/runtime/package.json` | R |
| `packages/runtime/src/graph.test.ts` | R |
| `packages/runtime/src/graph.ts` | R |
| `packages/runtime/src/index.ts` | R |
| `packages/runtime/src/live-layer.adapter.ts` | R |
| `packages/runtime/src/live-layer.test.ts` | R |
| `packages/runtime/src/testing.port.ts` | R |
| `packages/runtime/src/testing/version.port.ts` | R |
| `packages/runtime/tsconfig.json` | R |
| `packages/sdk/AGENTS.md` | R |
| `packages/sdk/CLAUDE.md` | A |
| `packages/sdk/fixtures/journal-0.13.0.json` | V |
| `packages/sdk/fixtures/journal-0.14.0.json` | V |
| `packages/sdk/fixtures/journal-0.15.0.json` | V |
| `packages/sdk/fixtures/journal-0.15.1.json` | V |
| `packages/sdk/fixtures/journal-0.16.0.json` | V |
| `packages/sdk/fixtures/journal-0.16.1.json` | V |
| `packages/sdk/fixtures/journal-0.16.2.json` | V |
| `packages/sdk/fixtures/journal-0.17.0.json` | V |
| `packages/sdk/fixtures/journal-0.17.1.json` | V |
| `packages/sdk/fixtures/journal-0.18.0.json` | V |
| `packages/sdk/fixtures/journal-0.19.0.json` | V |
| `packages/sdk/fixtures/journal-0.19.1.json` | V |
| `packages/sdk/fixtures/journal-0.19.2.json` | V |
| `packages/sdk/fixtures/journal-unreleased.json` | V |
| `packages/sdk/golden/agent-compaction.model.json` | V |
| `packages/sdk/golden/agent-stream.model.json` | V |
| `packages/sdk/golden/agent-turn.journal.json` | V |
| `packages/sdk/golden/agent-turn.model.json` | V |
| `packages/sdk/package.json` | R |
| `packages/sdk/src/activity.test.ts` | R |
| `packages/sdk/src/after-reply.journey.test.ts` | R |
| `packages/sdk/src/agent-services.journey.test.ts` | R |
| `packages/sdk/src/agent.adapter.test.ts` | R |
| `packages/sdk/src/agent.adapter.ts` | R |
| `packages/sdk/src/agent.backends.test.ts` | R |
| `packages/sdk/src/agent.compaction-golden.test.ts` | R |
| `packages/sdk/src/agent.golden.test.ts` | R |
| `packages/sdk/src/agent.stream-golden.test.ts` | R |
| `packages/sdk/src/agent.trace.test.ts` | R |
| `packages/sdk/src/anthropic-endpoints.journey.test.ts` | R |
| `packages/sdk/src/background-workers.journey.test.ts` | R |
| `packages/sdk/src/committed-turn.journey.test.ts` | R |
| `packages/sdk/src/compat-model-spend.journey.test.ts` | R |
| `packages/sdk/src/compat-tool-params.journey.test.ts` | R |
| `packages/sdk/src/conformance/index.ts` | R |
| `packages/sdk/src/context-overflow.journey.test.ts` | R |
| `packages/sdk/src/durable-results.journey.test.ts` | R |
| `packages/sdk/src/durable-steering.journey.test.ts` | R |
| `packages/sdk/src/eval-spend.journey.test.ts` | R |
| `packages/sdk/src/events-guide.test.ts` | R |
| `packages/sdk/src/helper-executor-admission.journey.test.ts` | R |
| `packages/sdk/src/helper-executor-recovery.journey.test.ts` | R |
| `packages/sdk/src/helper-executor.journey.test.ts` | R |
| `packages/sdk/src/inbox-restart.journey.test.ts` | R |
| `packages/sdk/src/inbox-runner.adapter.test.ts` | R |
| `packages/sdk/src/inbox-runner.adapter.ts` | R |
| `packages/sdk/src/index.ts` | R |
| `packages/sdk/src/invalid-calls.journey.test.ts` | R |
| `packages/sdk/src/journal-compat.test.ts` | R |
| `packages/sdk/src/keyed-action.journey.test.ts` | R |
| `packages/sdk/src/langsmith-telemetry.journey.test.ts` | R |
| `packages/sdk/src/media-store.journey.test.ts` | R |
| `packages/sdk/src/memory-maintenance.journey.test.ts` | R |
| `packages/sdk/src/memory-snapshot.journey.test.ts` | R |
| `packages/sdk/src/memory-window-current-turn.journey.test.ts` | R |
| `packages/sdk/src/memory.conformance.test.ts` | R |
| `packages/sdk/src/model-call-usage.journey.test.ts` | R |
| `packages/sdk/src/model-call.journey.test.ts` | R |
| `packages/sdk/src/model-failures.journey.test.ts` | R |
| `packages/sdk/src/model-request-hook.journey.test.ts` | R |
| `packages/sdk/src/model-retry.journey.test.ts` | R |
| `packages/sdk/src/model-spend.journey.test.ts` | R |
| `packages/sdk/src/models-plugin.test.ts` | R |
| `packages/sdk/src/plugin-stack.test.ts` | R |
| `packages/sdk/src/prompt-cache.journey.test.ts` | R |
| `packages/sdk/src/queued-input.journey.test.ts` | R |
| `packages/sdk/src/request-hook.journey.test.ts` | R |
| `packages/sdk/src/request-parts.journey.test.ts` | R |
| `packages/sdk/src/resume.journey.test.ts` | R |
| `packages/sdk/src/scripted-compat.journey.test.ts` | R |
| `packages/sdk/src/session-channel.journey.test.ts` | R |
| `packages/sdk/src/sessions-begin-trace.test.ts` | R |
| `packages/sdk/src/stored-format.journey.test.ts` | R |
| `packages/sdk/src/stored-records.journey.test.ts` | R |
| `packages/sdk/src/task-executor.adapter.ts` | R |
| `packages/sdk/src/task-inbox-runner.adapter.test.ts` | R |
| `packages/sdk/src/task-inbox-runner.adapter.ts` | R |
| `packages/sdk/src/tasks.journey.test.ts` | R |
| `packages/sdk/src/testing.port.ts` | R |
| `packages/sdk/src/tool-discovery-turn.test.ts` | R |
| `packages/sdk/src/tool-interceptor-recovery.journey.test.ts` | R |
| `packages/sdk/src/tool-interceptor.journey.test.ts` | R |
| `packages/sdk/src/tool-policy.journey.test.ts` | R |
| `packages/sdk/src/tool-registry.conformance.test.ts` | R |
| `packages/sdk/src/turn-composition.test.ts` | R |
| `packages/sdk/src/turn/memory-checkpoint.adapter.test.ts` | R |
| `packages/sdk/src/turn/memory-checkpoint.adapter.ts` | R |
| `packages/sdk/src/turn/model-call-recorder.adapter.test.ts` | R |
| `packages/sdk/src/turn/model-call-recorder.adapter.ts` | R |
| `packages/sdk/src/turn/model-call-recorder.entity.functions.ts` | R |
| `packages/sdk/src/turn/model-call-recorder.entity.ts` | R |
| `packages/sdk/src/turn/model-request-hook.adapter.test.ts` | R |
| `packages/sdk/src/turn/request-parts.adapter.test.ts` | R |
| `packages/sdk/src/turn/testing.ts` | R |
| `packages/sdk/src/turn/tool-registry.conformance.ts` | R |
| `packages/sdk/src/turn/turn-after-reply.entity.functions.ts` | R |
| `packages/sdk/src/turn/turn-lifecycle.usecase.functions.test.ts` | R |
| `packages/sdk/src/turn/turn-lifecycle.usecase.functions.ts` | R |
| `packages/sdk/src/turn/turn-observation.entity.functions.ts` | R |
| `packages/sdk/src/turn/turn-observation.entity.ts` | R |
| `packages/sdk/src/turn/turn-overflow.adapter.test.ts` | R |
| `packages/sdk/src/turn/turn-overflow.entity.functions.test.ts` | R |
| `packages/sdk/src/turn/turn-overflow.entity.functions.ts` | R |
| `packages/sdk/src/turn/turn-overflow.entity.ts` | R |
| `packages/sdk/src/turn/turn-phase.entity.functions.test.ts` | R |
| `packages/sdk/src/turn/turn-phase.entity.functions.ts` | R |
| `packages/sdk/src/turn/turn-phase.entity.ts` | R |
| `packages/sdk/src/turn/turn-run.lifecycle.test.ts` | R |
| `packages/sdk/src/turn/turn-run.usecase.functions.ts` | R |
| `packages/sdk/src/turn/turn.adapter.test.ts` | R |
| `packages/sdk/src/turn/turn.adapter.ts` | R |
| `packages/sdk/tsconfig.json` | R |
| `packages/website/.gitignore` | R |
| `packages/website/astro.config.mjs` | R |
| `packages/website/package.json` | R |
| `packages/website/public/examples/memory-walkthrough.json` | V |
| `packages/website/public/favicon.svg` | R |
| `packages/website/scripts/linkcheck.mjs` | R |
| `packages/website/src/assets/logos/logo-cli.svg` | R |
| `packages/website/src/assets/logos/logo-sdk.svg` | R |
| `packages/website/src/assets/logos/logo-wordmark.svg` | R |
| `packages/website/src/assets/logos/logo.svg` | R |
| `packages/website/src/components/BrandLogo.astro` | R |
| `packages/website/src/components/Footer.astro` | R |
| `packages/website/src/components/Icon.astro` | R |
| `packages/website/src/components/MemoryGraph.astro` | R |
| `packages/website/src/components/MemoryWalkthrough.astro` | R |
| `packages/website/src/components/Nav.astro` | R |
| `packages/website/src/components/ProductLogo.astro` | R |
| `packages/website/src/components/Sidebar.astro` | R |
| `packages/website/src/components/SourceFile.astro` | R |
| `packages/website/src/components/Toc.astro` | R |
| `packages/website/src/content.config.ts` | R |
| `packages/website/src/content/docs/concepts/architecture.md` | R |
| `packages/website/src/content/docs/concepts/conformance.md` | R |
| `packages/website/src/content/docs/concepts/context-journal.md` | R |
| `packages/website/src/content/docs/concepts/engine.md` | R |
| `packages/website/src/content/docs/concepts/evals.md` | R |
| `packages/website/src/content/docs/concepts/event-reference.md` | V |
| `packages/website/src/content/docs/concepts/foundry.md` | R |
| `packages/website/src/content/docs/concepts/harness.md` | R |
| `packages/website/src/content/docs/concepts/knowledge-evaluation.md` | R |
| `packages/website/src/content/docs/concepts/native-knowledge.md` | R |
| `packages/website/src/content/docs/concepts/observability.md` | R |
| `packages/website/src/content/docs/concepts/plugin-reference.md` | V |
| `packages/website/src/content/docs/concepts/providers.md` | R |
| `packages/website/src/content/docs/concepts/workspace.md` | R |
| `packages/website/src/content/docs/getting-started.md` | R |
| `packages/website/src/content/docs/guides/events.md` | R |
| `packages/website/src/content/docs/guides/memory-engine.mdx` | R |
| `packages/website/src/content/docs/guides/memory-walkthrough.mdx` | R |
| `packages/website/src/content/docs/guides/process-protocol.md` | R |
| `packages/website/src/content/docs/plugins/agent-loop-steps.md` | R |
| `packages/website/src/content/docs/plugins/index.md` | R |
| `packages/website/src/content/docs/plugins/knowledge-postgres.md` | R |
| `packages/website/src/content/docs/plugins/memory-capture.md` | R |
| `packages/website/src/content/docs/plugins/memory-digest.md` | R |
| `packages/website/src/content/docs/plugins/memory-summary.md` | R |
| `packages/website/src/content/docs/plugins/memory-window.md` | R |
| `packages/website/src/content/docs/plugins/memory.md` | R |
| `packages/website/src/content/docs/plugins/models.md` | R |
| `packages/website/src/content/docs/plugins/rag.md` | R |
| `packages/website/src/content/docs/plugins/render-feed.md` | R |
| `packages/website/src/content/docs/plugins/render-output.md` | R |
| `packages/website/src/content/docs/plugins/render-surface.md` | R |
| `packages/website/src/content/docs/plugins/session-files-log.md` | R |
| `packages/website/src/content/docs/plugins/session-files.md` | R |
| `packages/website/src/content/docs/plugins/session-sqlite-log.md` | R |
| `packages/website/src/content/docs/plugins/session-sqlite.md` | R |
| `packages/website/src/content/docs/plugins/sessions.md` | R |
| `packages/website/src/content/docs/plugins/tasks.md` | R |
| `packages/website/src/content/docs/plugins/telemetry.md` | R |
| `packages/website/src/content/docs/plugins/tool-discovery.md` | R |
| `packages/website/src/content/docs/plugins/workspace-images.md` | R |
| `packages/website/src/content/docs/plugins/workspace-local.md` | R |
| `packages/website/src/content/docs/plugins/workspace-skills.md` | R |
| `packages/website/src/content/docs/plugins/workspace-tools.md` | R |
| `packages/website/src/data/memory-walkthrough.json` | V |
| `packages/website/src/data/plugin-navigation.json` | R |
| `packages/website/src/layouts/BaseLayout.astro` | R |
| `packages/website/src/layouts/DocLayout.astro` | R |
| `packages/website/src/lib/nav.ts` | R |
| `packages/website/src/pages/docs/[...slug].astro` | R |
| `packages/website/src/pages/docs/index.astro` | R |
| `packages/website/src/pages/index.astro` | R |
| `packages/website/src/plugins/rehype-base-links.mjs` | R |
| `packages/website/src/plugins/remark-callouts.mjs` | R |
| `packages/website/src/styles/global.css` | R |
| `packages/website/src/styles/prose.css` | R |
| `packages/website/tsconfig.json` | R |
| `scripts/agents-guide.test.ts` | R |
| `scripts/anthropic-messages-consumer.fixture.mjs` | V |
| `scripts/api-snapshot.test.ts` | R |
| `scripts/api-snapshot.ts` | R |
| `scripts/build-check.test.ts` | R |
| `scripts/build-check.ts` | R |
| `scripts/build-packages.ts` | R |
| `scripts/context-overflow-consumer.fixture.mjs` | V |
| `scripts/declaration-imports.test.ts` | R |
| `scripts/declaration-imports.ts` | R |
| `scripts/distribution-manifest.test.ts` | R |
| `scripts/distribution-manifest.ts` | R |
| `scripts/error-codes.test.ts` | R |
| `scripts/error-codes.ts` | R |
| `scripts/evaluation-consumer.fixture.mjs` | V |
| `scripts/events-consumer.fixture.mjs` | V |
| `scripts/generate-event-reference.ts` | R |
| `scripts/generate-plugin-reference.ts` | R |
| `scripts/generate-stored-format.ts` | R |
| `scripts/guide-snippets.test.ts` | R |
| `scripts/guide-snippets.ts` | R |
| `scripts/helper-executor-consumer.fixture.mjs` | V |
| `scripts/inbox-restart-consumer.fixture.mjs` | V |
| `scripts/installHooks.ts` | R |
| `scripts/knowledge-consumer.fixture.mjs` | V |
| `scripts/knowledge-evaluation.test.ts` | R |
| `scripts/knowledge-evaluation.ts` | R |
| `scripts/knowledge-reference-clients.ts` | R |
| `scripts/langsmith-telemetry-consumer.fixture.mjs` | V |
| `scripts/media-store-consumer.fixture.mjs` | V |
| `scripts/memory-maintenance-consumer.fixture.mjs` | V |
| `scripts/memory-snapshot-consumer.fixture.mjs` | V |
| `scripts/memory-walkthrough.test.ts` | R |
| `scripts/memory-walkthrough.ts` | R |
| `scripts/model-call-consumer.fixture.mjs` | V |
| `scripts/model-call-recorder-consumer.fixture.mjs` | V |
| `scripts/model-failures-consumer.fixture.mjs` | V |
| `scripts/model-retry-consumer.fixture.mjs` | V |
| `scripts/model-spend-consumer.fixture.mjs` | V |
| `scripts/model-text-pins.test.ts` | R |
| `scripts/models-consumer.fixture.mjs` | V |
| `scripts/npm-landing.test.ts` | R |
| `scripts/npm-landing.ts` | R |
| `scripts/npm-registry.ts` | R |
| `scripts/plugin-docs.test.ts` | R |
| `scripts/plugin-docs.ts` | R |
| `scripts/process-host-consumer.fixture.mjs` | V |
| `scripts/proxy-consumer.fixture.mjs` | V |
| `scripts/publish-npm-landing.ts` | R |
| `scripts/publish-packages.ts` | R |
| `scripts/publish-plan.test.ts` | R |
| `scripts/publish-plan.ts` | R |
| `scripts/record-journal-fixture.test.ts` | R |
| `scripts/record-journal-fixture.ts` | R |
| `scripts/record-run-fixture.ts` | R |
| `scripts/release-notes.test.ts` | R |
| `scripts/release-notes.ts` | R |
| `scripts/release-patch.test.ts` | R |
| `scripts/release-patch.ts` | R |
| `scripts/release-publish.test.ts` | R |
| `scripts/release-publish.ts` | R |
| `scripts/release-status.test.ts` | R |
| `scripts/release-status.ts` | R |
| `scripts/release-target-plan.ts` | R |
| `scripts/release-target.test.ts` | R |
| `scripts/release-target.ts` | R |
| `scripts/release-version-plan.test.ts` | R |
| `scripts/release-version-plan.ts` | R |
| `scripts/release-version.test.ts` | R |
| `scripts/release-version.ts` | R |
| `scripts/release-workflows.test.ts` | R |
| `scripts/request-header-consumer.fixture.mjs` | V |
| `scripts/request-hook-consumer.fixture.mjs` | V |
| `scripts/request-parts-consumer.fixture.mjs` | V |
| `scripts/stored-format.test.ts` | R |
| `scripts/stored-format.ts` | R |
| `scripts/sync-guides.ts` | R |
| `scripts/telemetry-consumer.fixture.mjs` | V |
| `scripts/tool-interceptor-consumer.fixture.mjs` | V |
| `scripts/tsconfig.json` | R |
| `scripts/verify-packages.ts` | R |
| `scripts/website-linkcheck.test.ts` | R |
| `tsconfig.base.json` | R |
| `tsconfig.json` | R |

</details>
