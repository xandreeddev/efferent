# Repository audit resolution

The [original audit](repository-audit.md) records revision
`b682e58e9cecf492d19ecead8f95b96ca25c0c29`. This matrix records the resulting
changes and the tests that exercise them. All 52 indexed findings are addressed;
the additional observations are recorded below the matrix.

## Breaking contracts

- Session stores require file layout 2, SQLite schema 3 and stored format 19.
  Open a fresh location. Older formats and nonempty unmarked stores are rejected
  without migration, deletion or mutation: the [files store tests](../packages/plugin-session-files/src/session-log.adapter.test.ts)
  open a layout 1 store with a session and an abandoned staging entry, and
  unmarked roots, comparing the whole tree before and after; the
  [journal tests](../packages/sdk/src/journal-compat.test.ts) store each
  released fixture's first session with its format stamp and check that
  Sessions refuses it and leaves its head and events unchanged. Released journal fixtures remain
  historical evidence; only the development fixture is regenerated.
- `SessionRef` contains `id`, `owner` and `incarnation`. Log reads, commits,
  removals, list-parent filters and fork lineage use the full reference. Creation
  supplies the header and initial state atomically. Admitted and committed turn
  callbacks receive that reference. An operation keeps its captured identity
  through retries instead of rebinding to a replacement session.
- `SessionLog.remove` is no longer idempotent: removing a missing, already
  removed, stale or wrong-owner reference fails with `SessionMissing` (the
  log kit requires it, reading, committing to and removing the captured
  references directly). A direct caller that retries a removal, or removes
  children before their parent, handles `SessionMissing`. The file log first
  finishes what a removal stopped part way left (children, payloads), and
  keeps of a removed session only its claim and tombstone. `Sessions.remove`
  is unchanged: it already refused a missing session.
- Standalone loops and custom tool registries supply a `PreparedToolkit` using
  `prepareToolkit`. Parameter codecs decode once before any handler in a batch
  runs. Raw provider arguments stay detached and immutable; the decoded value
  belongs to the execution closure. Custom execution wrappers use the explicit
  execution hook described in [the framework contract](framework.md#host-planned-initial-tool-batch).
- Auth/settings conformance subjects open a fresh scoped fixture per check and
  declare writable, refresh and corruption probes. Sessions conformance subjects
  supply an unsupported-format probe (`newerFormat`) that stamps any format
  but the current one and returns a snapshot of the stored head.
- A background handler's publication into its own full queue fails with
  `events.capacity`; other producers, other lanes' handlers included, wait
  interruptibly. Background capacity is a positive safe integer. Provider SSE permits 128 tool
  calls and 1 MiB of accumulated arguments per call; indices must be nonnegative
  safe integers.
- The blanket `no-let` and `no-loop-statements` rules are retired. Confined local
  builders are allowed; typed failures, scoped ownership, decoding, bounded work,
  architectural boundaries and stable service keys remain required.

No package version, release tag or publication is created by this remediation.
The changeset records the intended minor release of the fixed package group.

## Indexed findings

| Finding | Status | Change and evidence |
| --- | --- | --- |
| FW-10 | Resolved | Authorize before checking a locally sealed writer. [Sessions tests](../packages/plugin-sessions/src/sessions.adapter.test.ts) seal a locally held turn, cancel it as the wrong owner and verify it stays open with nothing stored, then cancel it as its owner: one sealed ending with its reply. The shared [Sessions kit](../packages/core/src/session/sessions.conformance.ts) checks a wrong owner's cancel of an open turn (`cancel`) and of a locally sealed one (`sealed`), and its [self-tests](../packages/plugin-sessions/src/sessions.conformance.test.ts) include a backend taking the sealed shortcut before the owner check. |
| FW-11 | Resolved | Capture full references, fence every adapter and preserve immutable file generations/tombstones. [Sessions race tests](../packages/plugin-sessions/src/sessions.adapter.test.ts) pause reads/removals across owner replacement; the [log kit](../packages/core/src/session/session-log.conformance.ts) rejects stale and foreign references, including another owner's fork parent, and reads, commits to and removes removed references directly (its [self-tests](../packages/core/src/session/session-log.memory.adapter.test.ts) run it against stores that still answer for them). The [file log's removal tests](../packages/plugin-session-files/src/session-log.adapter.test.ts) check that nothing of a removed family stays on disk, that listing and removal work does not grow with removed sessions, and that a removal or creation stopped part way is finished. |
| CORE-KNOWLEDGE-1 | Resolved | Topological inference validation visits each node/edge once. [Knowledge tests](../packages/core/src/knowledge/knowledge.entity.functions.test.ts) count visits in an 80-node shared DAG and retain cycle checks. Only supports present in the validated graph count toward a cycle, so retiring the support of an active inference still publishes and closes the dependent: a unit repro and the [knowledge kit](../packages/core/src/knowledge/knowledge-store.conformance.ts)'s `knowledge.supersede-support`, run on the in-memory and PostgreSQL stores. |
| E1 | Resolved | Capture every terminal Exit before completing the attempt ACK and phase. [Completion tests](../packages/plugin-models/src/llm/model-completion.adapter.test.ts) inject a ledger defect and require repeated settlement to terminate; accounting tests retain durable interruption facts. |
| E2 | Resolved | Open exclusive credential temporaries at mode 0600 before serialization and scope their handles/removal. [Storage tests](../packages/plugin-models/src/storage/json-file.test.ts) inspect permissions during serialization and exercise failed serialization cleanup. |
| E7 | Resolved | Validate a present index (an absent or `null` one is call 0, as in 0.19.2), keep actual keys in a Map, and enforce call/argument limits. [SSE tests](../packages/plugin-models/src/llm/sse.test.ts) cover sparse maximum indices, invalid indices, absent and `null` indices, interleaved out-of-order assembly (calls emitted in index order), bounds on both sides of each limit and absence of ghost calls. |
| CORE-KNOWLEDGE-2 | Resolved | Count supporting memory mentions separately from entity attribution. [Knowledge tests](../packages/core/src/knowledge/knowledge.entity.functions.test.ts) reject entity-only recurrence evidence. |
| DATA-1 | Resolved | Compare the union of fixture/protocol provenance keys. [CLI comparison tests](../packages/evals-cli/src/cli.test.ts) reject candidate-only additions in both comparison directions. |
| DATA-2 | Resolved | Dispatch only own command-table properties. [CLI tests](../packages/evals-cli/src/cli.test.ts) reject constructor, toString and __proto__ through the normal usage error. |
| DATA-3 | Resolved | Accumulate replay chunks and flatten once, preserving filters, limits and newest-first queries. A read after a position finds its first commit by a binary search over the commits' first lines and stops past its ceiling (forward) or its position (from the end). [File log tests](../packages/plugin-session-files/src/session-log.adapter.test.ts) count the commit files a cold handle opens for a point read, a newest-first read and a read after a position, and packed restart consumers exercise replay behavior. |
| DATA-4 | Resolved | Keep tiny byte/token-boundary combinations on the adversarial Unicode/delimiter fixture; retain normal reads/writes for every historical fixture. [Filesystem eval-store tests](../packages/evals-cli/src/adapters/evaluation-store.fs.adapter.test.ts) preserve boundary coverage without the redundant cross product. |
| DOC-DATA-1 | Resolved | Document extraction protocol 10 and its bounded repair behavior. [Docs tests](../scripts/knowledge-docs.test.ts) compare the canonical and website guides and require the current version. |
| DOC-DATA-2 | Resolved | Include memory, discovery and step-loop dependencies in the standalone spend example. [Docs tests](../scripts/knowledge-docs.test.ts) import and execute that exact extracted example. |
| DOC-DATA-3 | Resolved | Correct assistant-before-tool durability order, begin/ending outcomes, event capacity and platform claims. [Executable events guide](../packages/sdk/src/events-guide.test.ts), generated references and packed HTTP consumers validate the recipes. |
| E10 | Resolved | Own a pending scripted hook with an AbortController and scoped fiber. An abort interrupts the hook and rejects the pending read at once with the signal's reason, as fetch does; a reader cancellation interrupts it and waits for its finalization. A hook that dies fails the body with its defect. [Scripted transport tests](../packages/plugin-models/src/transport/scripted-chat.adapter.test.ts) observe a slow hook finalizer on both paths and the defect. |
| E11 | Resolved | Render event names reject CR, LF and NUL using the shared ID contract. [Feed schema tests](../packages/plugin-render/src/domain/feed-frame.entity.test.ts) exercise cursor-injection strings. |
| E12 | Resolved | Require failure before inspecting the exact failure tag/code. [Provider tests](../packages/plugin-models/src/llm/providers.test.ts) and related failure/router/client tests no longer skip assertions on an unexpected result. |
| E13 | Resolved | Each conformance check owns a fresh subject; tests run checks in reverse order and inspect writable/fallback tiers. [Settings kit tests](../packages/plugin-models/src/settings/settings-store.conformance.test.ts) and memory subjects preserve tier identity. |
| E14 | Resolved | Release background work only after observing the first awaiting verdict. [Step-loop tests](../packages/plugin-agent-loop/src/step-loop.adapter.test.ts) also run the kit with a slow planner. |
| E3 | Resolved | Introduce explicit once-only preparation; preflight all calls before running any. [Prepared toolkit tests](../packages/core/src/turn/prepared-toolkit.adapter.test.ts) use a mutating effectful decoder and check raw evidence, handler timing and result encoding. A [loop test](../packages/plugin-agent-loop/src/loop.test.ts) runs a counting, mutating codec through `runLoop`: one decode per call, the provider's arguments unchanged in the stored request, `tool_start` and the provider's object. Input is normalised as JSON text (undefined keys left out, `toJSON` applied), so host-planned batches with optional fields run (loop test and the step-loop kit's `planned-json`). Views, compaction and digests decode detached copies of the stored input and result ([registry tests](../packages/plugin-tool-discovery/src/registry.adapter.test.ts)). |
| E4 | Resolved | Register temporary cleanup before workspace writes and handle only the expected missing-file cleanup case. [Workspace tests](../packages/plugin-workspace/src/workspace-tools.adapter.test.ts) interrupt at rename and require the temporary to disappear. |
| E5 | Resolved | Validate every auth/settings tier before opening a write. [Auth](../packages/plugin-models/src/auth/auth-store.conformance.ts) and [settings](../packages/plugin-models/src/settings/settings-store.conformance.ts) kits corrupt each backing tier and assert unchanged state: the settings kit compares every value before and after, the auth kit that the repaired store reads what it held and that a refused `set` wrote nothing (a self-test store that writes and then fails is caught). The local auth subject damages all four tiers, global and local; [localAuth tests](../packages/plugin-models/src/auth/localAuth.test.ts) refuse a global login over a corrupt local override. |
| E6 | Resolved | Use full canonical result JSON for progress identity. [Loop tests](../packages/plugin-agent-loop/src/loop.test.ts) continue through results whose shared prefix exceeds the former clipping limit, and through results that differ only in a `Date` (the identity reads a result as JSON text, `toJSON` applied). |
| FOUNDRY-1 | Resolved | Classify malformed/crashed custom rules as infrastructure failures before severity, allowances or baseline processing. [Idiom gate tests](../packages/foundry/src/gates/idiomGate.test.ts) cover advisory rules failing closed. |
| FOUNDRY-2 | Resolved | Suspend construction of each gate Effect inside defect handling. [Pipeline tests](../packages/foundry/src/pipeline/runPipeline.test.ts) require a failure report for a synchronous construction throw. |
| FW-1 | Resolved | Deduplicate identical plugin definitions while retaining independent instance entries/options. [Agent tests](../packages/sdk/src/agent.adapter.test.ts) define two instances of one plugin. Conflicting definitions still fail graph validation. |
| FW-2 | Resolved | Reject the full provided/contributed key intersection before consumer traversal. [Graph tests](../packages/runtime/src/graph.test.ts) cover collisions without graph consumers. |
| FW-3 | Resolved | Detach generations under admission and close them after releasing it. [Registry tests](../packages/runtime/src/live-layer.test.ts) hold a finalizer and require prompt concurrent refusal. |
| FW-4 | Resolved | Preserve dot and trailing-directory requirements during in-memory path traversal, for reads, `stat` without following links (a trailing separator follows the last link and requires a directory), both sides of `rename`, and writes and appends (refused with `IsDirectory`, creating only the parents `dirname` names). The [filesystem kit](../packages/core/src/workspace/file-system.conformance.ts)'s `dot-paths` runs the cases on memory and packed native adapters on Node/Bun. |
| FW-5 | Resolved | Fold inbox history with a turn index and group historical media once before sorting. [Inbox tests](../packages/plugin-sessions/src/inbox-drain.entity.functions.test.ts), memory tests and golden conversations preserve output. Complexity follows the single traversal and indexed lookups; no machine-speed threshold is claimed. |
| FW-6 | Resolved | Require a failed reentry result before narrowing; keep code and sticky-error identity checks. [Recorder tests](../packages/sdk/src/turn/model-call-recorder.adapter.test.ts) cover direct and child-fiber reentry. |
| ROOT-1 | Resolved | Scope, deadline, kill and reap the real implementor child while draining stdout/stderr. [Implementor tests](../packages/foundry/src/adapters/claudeImplementor.test.ts) cancel a harmless child and verify termination. |
| ROOT-2 / S2 | Resolved | Validate every inventory row, known package tables, stable assertion-suite IDs and presence of exact assertions. [Inventory tests](../scripts/model-text-pins.test.ts) reject empty/malformed pins and assertion deletion with preserved line count. Actual rendered prompts/lessons/quality bar have exact tests; semantic row coverage remains a review obligation. |
| ROOT-3 | Resolved | Retire blanket mutation/loop bans, declare real native imports and move supported helpers into public role modules. [Contribution guidance](../CONTRIBUTING.md), root/package instructions and skills distinguish syntactic gates from semantic review and clarify scoped/generic/Bun-only port exceptions. |
| S1 | Resolved | Strip annotations only at schema nodes, preserving property/definition dictionaries and constant/default JSON. [Stored-format tests](../scripts/stored-format.test.ts) distinguish reserved-word field types and names. |
| S3 | Resolved | Restrict force to an explicit unreleased target and publish release fixtures with exclusive creation. [Recorder tests](../scripts/record-run-fixture.test.ts) cover refusal and concurrent creation without rewriting historical fixtures. |
| WEBSITE-1 | Resolved | Use one documentation column below 880 px. Browser measurements at 375/800/1280 px confirm readable widths, hidden/mobile versus visible/desktop sidebar, and no horizontal overflow. |
| DATA-10 | Resolved | Use TestClock for logical expiry and explicit child/read/commit barriers for CAS and SQLite holder responsiveness. [SQLite recovery tests](../packages/plugin-session-sqlite/src/session-recovery.test.ts) and [file recovery tests](../packages/plugin-session-files/src/session-recovery.test.ts) establish the race before releasing it. |
| DATA-5 | Resolved | Delete unreachable llm/pairwise eval helpers and their implementation-only tests; remove the unsupported docs claims. Public graders and supported host exports remain. Reachability and packed API checks validate the remaining surface. |
| DATA-6 | Resolved | Concatenate each Langfuse batch once. [Exporter tests](../packages/evals-langfuse/src/export.test.ts) preserve payloads and batching semantics. |
| DATA-7 | Resolved | Replace nested absence with a tagged attempt decision. [RAG tests](../packages/plugin-rag/src/rag-engine.adapter.test.ts) retain retry/abstain/completion behavior. |
| DATA-8 | Resolved | Track and remove eval CLI test directories in afterEach, including failures. [Eval-store](../packages/evals-cli/src/adapters/evaluation-store.fs.adapter.test.ts) and [run-main tests](../packages/evals-cli/src/run-main.adapter.test.ts) retain disk behavior assertions. |
| DATA-9 | Resolved | Remove SQLite's unused ws dependency and lockfile entry. Frozen install, package build and declaration dependency checks cover the manifest. |
| DOC-DATA-4 | Resolved | Distinguish Bun-only SQLite from the file/memory stores tested on Node in framework, conformance and SQLite guides. Packed consumers validate the stated runtime split. |
| E8 | Resolved | Delete the unreferenced models tmux/TUI acceptance fixture and the removed tui-testing build branch. Packed builds preserve supported entrypoints. |
| E9 | Resolved | Align models instructions with implemented spend-guard precedence and scoped accounting ownership. Existing model-call accounting and late-finalizer journeys retain their assertions. |
| FOUNDRY-3 | Resolved | Ban every Effect.run* runner in inner files, including runFork/runCallback, in library and vendored rules. [Architecture gate tests](../packages/foundry/src/gates/idiomGate.test.ts) and vendor parity tests exercise the runner cases. |
| FW12 | Resolved | Acquire/release follower subscription scopes with the enclosing conformance check. [Channel kit](../packages/core/src/session/session-channel.conformance.ts) exercises publication and cleanup without detached scopes. |
| ROOT-4 | Resolved | Mark the Foundry design and branded-types roadmap as historical and point to current contracts/instructions. Historical implementation claims remain visibly historical. |
| ROOT-5 | Resolved | Remove ordinary unused imports/parameters; retain five documented UserMessage imports that anchor emitted declarations. Packed declaration imports remain within declared dependencies. See the classification below. |
| WEBSITE-2 | Resolved | Remove the unused ProductLogo component, obsolete logo assets, NPM nav export and unused button/layout CSS. Website build and link checks cover remaining references. |
| WEBSITE-3 | Resolved | Correct SDK ownership of TurnLive and service-name precedence; distinguish Bun-only conformance subjects. Guides agree with package exports and telemetry option tests. |

## Additional observations

| Observation | Resolution and evidence |
| --- | --- |
| FW-7: queue breadth | Finite event queues, interruptible external offers and explicit `events.capacity`; [bus tests](../packages/core/src/turn/turn-bus.adapter.test.ts) cover reentrant overflow, a cross-lane publication that waits for room and is delivered, and the capacity bounds; the turn kit waits for actual delivery. |
| FW-8: hidden native coupling | ProcessLiveness imports node:os/node:process explicitly; the boundary profile declares those dependencies, and the injectable service remains. |
| FW-9: public helper aliases | Public glob, message mapping and tool-schema implementations live in public role modules and are named root exports. Internal exports remain explicit. |
| Regex native backtracking | Builtin regex execution uses one scoped worker per grep, one file at a time, with the remaining grep deadline. Cancellation terminates native backtracking. [Workspace regression](../packages/plugin-workspace/src/workspace-tools.adapter.test.ts) and [packed fixture](../scripts/regex-search-consumer.fixture.mjs) cover overlapping alternatives on Bun and Node. Literal searches stay local. |
| Other repeated folds | Stream folding uses ordered slots and chunk buffers, glob escaping is linear, tool-call lifecycle projection indexes ownership/intervals, and Foundry lesson tallies use a confined Map. Existing model, lifecycle, glob and lesson tests retain output semantics. |
| Auth causes | AuthError preserves its foreign cause as a value while reports retain secret-safe messages. Auth conformance and local/memory tests exercise failures. |
| Foundry IO failures | Only ENOENT is absence in private-text, registration and manifest reads. Corrupt/unreadable baselines fail configuration. [Boundary tests](../packages/foundry/src/gates/boundariesGate.test.ts) use an actual non-readable manifest path; CLI tests exercise malformed baselines. |
| Foundry prompt evidence | Add a model-text inventory, exact implementor prompt and lesson assertions, and a complete quality-bar snapshot. Prompt text is unchanged except the deliberately retired gate requirements. |
| SDK/process test ownership | Model-failure/cache journeys and release-target/status CLI children own native deadlines and final cleanup. Bash child fixtures register cleanup before assertions. |
| SDK/session scheduling | SSE tests count the single timed-out writer attempt and verify abort/settlement with an outer deadline. Inbox/waiting tests await observed signals rather than 150–200 ms scheduling margins; held snapshot/end ACK fixtures register release finalizers. |
| IN1: stale environment setup | Replace application-era environment defaults with supported optional integration-test configuration; describe the local data ignore without the removed Compose setup. |
| IN2: fork reads | Clarify that Sessions.read returns own events, TurnWriter.history adds inherited history, and hosts follow recorded lineage boundaries for transcripts. |
| Reference HTTP clients | Bound response bodies at 8 MiB, cancel rejected bodies and cancel stalled reads at the deadline. [HTTP tests](../scripts/knowledge-reference-clients.test.ts) use real local responses. |
| Registry/release confirmation | Bound registry metadata at 4 MiB and include requests/waits in the wall deadline. Ambiguous publication and final confirmation require the exact gitHead. [Registry tests](../scripts/npm-registry.test.ts) exercise wrong-source metadata and stalled reads; no real publication is performed. |
| CI instruction guard | Decode YAML steps, including named/block run steps, rather than matching anonymous run lines only. [Guide tests](../scripts/agents-guide.test.ts) pin the parser and CI command coverage. |
| Packed launcher duplication | Use a typed fixture launcher for repeated protocol scenarios, owning subprocess deadlines and required evidence. Remove temporary consumer installs on exit unless --keep-consumer is explicit. Independent scenario assertions remain in their fixtures. |

The unused-diagnostic scan retains only UserMessage declaration anchors in
`core/memory/memory-snapshot.entity.ts`, its functions pair,
`core/session/session-event.entity.functions.ts`,
`core/turn/model-request.entity.functions.ts` and `sdk/turn/turn-phase.entity.ts`.
Comments explain their declaration role. This is a classification of compiler
signals, not a claim that every unused import denotes dead runtime behavior.

## Decisions and limits

`SessionLog.head(id)` remains the trusted bootstrap lookup: callers cannot know
an incarnation before resolving the head. Hosts authorize its owner before use;
all data reads/writes/removals are fenced by the resulting full reference. This
is an explicit exception to changing every low-level method to take a reference.

Progress identity uses full canonical JSON rather than a digest. It avoids both
the old lossy prefix and hash collisions; it does not claim constant-size keys.

Model-text metadata proves that a reviewed inventory points to an existing suite
with exact assertions. It cannot prove that a prose description corresponds to
every asserted byte. Exact rendering/golden tests run independently, and reviewers
must check the row-to-assertion relationship. The negative control detects removal
of the cited suite's assertions without relying on line-number drift.

Terminal model accounting retains its atomic interruption policy: reservation,
attempt registration and durable settlement cannot be split by cancellation.
Every terminal Exit completes the ACK, including defects; external ledger waits
must obey the port's bounded-operation contract. Making durable settlement broadly
interruptible would lose accounting facts and is intentionally avoided.

## Verification

| Check | Evidence |
| --- | --- |
| Frozen install | Pass, with the repository hook installed and no dependency changes. |
| Repository gates/typecheck | Pass, zero findings and an empty baseline, including the final file-race fixes. |
| Foundry self-profile/demo | Pass; the demo is accepted on attempt 3. |
| Default full suite | 4,911 pass, 4 conditional skips, 0 fail across 397 files. |
| Randomized full suite, seed 1109 | 4,913 pass, 4 conditional skips, 0 fail across 397 files, with PostgreSQL/pgvector configured. |
| Final file-store race/recovery checks | 102 pass, 1 optional shared-mount skip, 0 fail; includes payload-read and publication-link removal races added after the full runs. |
| Randomized focused regressions | 20/20 seeds (2001–2020), 335 tests per run, covering graph/lifecycle, memory stores, preparation, settings/auth, completion and loop/interceptor behavior. |
| Additional gate/guide regressions | 40 pass, 0 fail; final quality-bar string snapshots separately pass all 4 tests. |
| Public build/API/declarations | Pass: 32 API entries and 24 packages' declaration dependencies. |
| Bun 1.3.6 proxy matrix | 47 pass, 2 conditional skips, 0 fail. |
| Documentation generation | Pass and idempotent; current event/plugin/stored-format references and guide snippets are committed. |
| Website | 46 pages built, all internal links pass; browser layout measured at 375/800/1280 px. |
| Unused-diagnostic classification | Five deliberate declaration anchors remain; no ordinary unused imports/parameters remain in the scan. This optional stricter scan intentionally reports those five anchors. |

The PR records the final tarball consumer result against the committed build;
CI repeats the build and Node/Bun consumer matrix. The initial system-temporary
extraction failure was retried with disposable workspace scratch storage. Earlier
quota-affected runs are not counted as passes. The final file-store correction
has its own focused evidence rather than being attributed to the preceding full
runs.

No provider-backed evaluation, live exporter ingestion or shared NFS-mount
acceptance is inferred from these key-free checks. The three Bun-version skips
in the full runs are exercised on Bun 1.3.6; the shared-mount check remains
conditional on an explicitly configured mount. No user session data is removed.
