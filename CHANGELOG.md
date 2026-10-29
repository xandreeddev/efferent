# Changelog

Changes to the published `@xandreed/*` framework packages. All of them share
one version and are published together under npm's `latest` tag.

Every pull request adds its entry under **Unreleased**. A release turns that
section into the new version. Releases before 0.11.0 are not recorded here.

## Unreleased

### Migration

- `@xandreed/plugin-render`: a host `RenderStore` keeps records under thread,
  principal and surface, scopes `commit` idempotency the same way, accepts a
  `SurfaceFrozen` without a version (and refuses `plan` after it), and reruns
  `renderSurfaceConformance`. Code calling `decodeSse` reads its `Result`;
  code building `SurfaceFrozen` passes `versionId: Option.some(...)`.
- `@xandreed/evals`: rename ids containing "/" or "@" and re-run reports
  that hold them; give every gate a `minimum` or a `maximum`; `yield*` the
  result of `positiveInt`.
- Replaying a model request built from a summary recorded before this
  release fails with `request.diverged` (`context`), and a summarized
  session's cached prompt prefix changes once, because the summary handoff
  renders with new wording.
- `makeSession` (`@xandreed/core`) is deprecated and will be removed in a
  later release: use `Agent.define`/`Agent.turn` (`@xandreed/sdk`) over
  `Sessions` (`@xandreed/plugin-sessions`). Its ledger is in memory only,
  and its live `subscribe` tail drops the oldest events for a subscriber
  more than 512 events behind; it never delivered "exactly once".
- A custom `StepLoop` provides `request.cacheKey` as `CurrentPromptCacheKey`
  to its dispatch checks and model calls; `stepLoopConformance` checks it.
  On a loop that does not, a turn with a cache key fails the step with
  `request.diverged` (`cacheKey`).
- Install `effect` beside the packages: they declare it as a peer
  (`^4.0.7`) and depend on each other with caret ranges, so other patch
  versions install one copy of `effect` and of `@xandreed/core`.
- `yield*` the result of `defineGraderCalibration` and `endpointOwnKey`; pass
  the time (`Clock.currentTimeMillis`) to `classifyLlmError` and
  `openAiCodexUuidV7`.
- Add a `turnBeginCodes.SessionContended` entry to tables that cover every
  begin code, handle `SessionContended` where `Sessions` or `Tasks` errors
  are matched exhaustively, and raise a tagged error or a `HarnessError`
  where a stored code used to be read from an untagged error.
- Handle `SessionContended` (503, retry later) where you matched
  `SessionLogError` code `session.contended`, and treat `SessionLogError`
  as a store failure only.
- Read a failure's code with `harnessCodeOf(error)`, not `error.code` (the
  same code for a `HarnessError` and for the tag it stands for), and widen
  `HarnessError` annotations on a turn's `use`, or on code calling these
  ports, to `TurnError`; implementations returning `HarnessError` still
  satisfy the ports.
- Match a turn writer's failures by tag (`Effect.catchTag("TurnClosed" |
  "ReservedKind" | "SessionContended" | "SessionLogError", …)`) instead of
  `code === "turn.closed"`, and handle `TurnClosed.reason` `"ended"` where
  reasons are matched exhaustively. A custom `Sessions` writer raises these
  tags and reruns `sessionsConformance`; a `SessionLog` is unaffected.
- Match a begin refusal by tag (`Effect.catchTag("SessionBusy", …)`) and
  read what it names from its fields, not its message; read its code with
  `harnessCodeOf(error)` or `turnEndingOf(exit)`. Widen annotations on
  `Agent.turn`'s error to `TurnBeginError | TurnError`. A hand-composed
  `TurnRunner` lets the `Sessions.begin` refusal through and reruns
  `turnConformance`. The events guide's turn route answers a busy session
  with `{ code: "session.busy", turn }`.

### Breaking

- `@xandreed/plugin-render` operation ids name the surface and the
  generation: `<runId>:render:<surfaceId>:<generation>:<nodeId>`, and fills
  `...:<generation>:fill:<placeholder>` (a `:` or `%` inside a part is
  percent-encoded). `operationIdOf` and `fillOperationIdOf` take the surface
  id, and the fill takes the generation. Stored records still read: a
  version partly committed under the old ids commits only its missing nodes.
- `SurfaceFrozen.versionId` is an `Option` (`null` when encoded), so a
  freeze before the first publish holds. Stored freezes still decode.
- `decodeSse` returns a `Result`: a malformed record fails with
  `RenderError` code `invalid` instead of throwing.
- A damaged or unreadable `auth.json` or `config.json` fails with an
  `AuthError` of code `auth.corrupt` (or a `SettingsError` of code
  `settings.corrupt`) naming the file, instead of reading as empty and being
  overwritten on the next write. A corrupt `config.json` used to be ignored
  with a warning: fix or remove the file.
- Skill-selection decisions and seeded `load_skill` calls are numbered per
  run: `<runId>:skill-selection:<n>` and `<runId>:matcher:<n>`. Older
  journals still decode.
- `@xandreed/evals` ids (`EvalId`) can no longer contain "/" or "@":
  `EvalId.make` refuses them and saved reports holding them no longer
  decode. Trial, transcript-event and review trial ids are the new
  `EvalPath`. A run id that is not an `EvalId` fails the run with `invalid`.
- A `Gate` needs a `minimum` or a `maximum`; validation refuses one with
  neither (it used to pass any value).
- `GateFinding.mode` is `"blocking" | "diagnostic"`; a report with another
  mode (such as "Blocking", once read as diagnostic) no longer decodes.
- `positiveInt` returns an `Effect` failing with `invalid` instead of
  silently using the fallback. `EvaluationError` has a new code, `missing`.
- `@xandreed/plugin-models`: the routed models fail a credential they
  cannot get (none stored, a failed refresh, a proxy the runtime cannot
  tunnel) with an `AiError` whose reason is `AuthenticationError`, not a raw
  `AuthError`; it is still not retried and goes to no fallback.
- `makeOpenAiCodexWebSocketHttpClient(proxy, sessions?)` and
  `OpenAiCodexWebSocketHttpClient` share no process-wide session map: pass
  `makeOpenAiCodexSessions()` to keep a conversation's session id (without
  one, each request gets a fresh id). The routed models keep one cache per
  layer, up to 1024 conversations.
- `defineSkill` rejects `instructions` with `always: true` (an always-on
  skill's instructions never reached the model).
- `DigestTask` has `preserve`; `MemorySummaryConfig` has `summaryTimeoutMs`
  and `MemoryDigestConfig` has `digestTimeoutMs` (add them if you build
  these configs without the defaults).
- `draftOfTurnEvent` returns an `Effect` that fails with the `SchemaError`
  instead of throwing. A bus event that does not encode fails the turn with
  `events.encode`, not `turn.defect`.
- `toAgentFailure` classifies an `AiError` by its reason: the `code` is the
  reason's tag (for example `RateLimitError:429`) instead of `AiError`, and
  `retryable` is the reason's own (rate limits are retryable, exhausted
  quotas are not).
- `toFailure` names tagged values by their `_tag` and never produces
  `[object Object]`.
- A plugin's layer no longer sees services provided around `Agent.define`,
  `Agent.turn` or `activateGraph` that it does not declare in `requires` or
  `optional`. It keeps the fiber's settings: logging, tracing and the
  current span, clock and metrics.
- `Agent.define` fails with `config.graph`, naming the missing service, when
  the agent's turns would have no `ConversationMemory`, `ToolRegistry` or
  `StepLoop`; before, the first turn failed with `service.missing`.
- `resolveGraph` refuses `profile`/`profiles` (`config.profile`) instead of
  ignoring them.
- Agent fingerprints change once: they now hash canonical JSON.
- `Sessions.begin` refuses a run id that an earlier turn of the session, or
  of history a fork inherits, was begun with: `RunIdReused`, or
  `turn.run-reused` (409) from `Agent.turn`. Every turn and every retry
  needs a new run id.
- `Tasks.start` fails with `TaskConflict` for a known task id with other
  instructions or mode, and with `SessionExists` for an id naming a session
  that is not the parent's task child.
- A turn's writer refuses framework kinds from hosts and plugins
  (`events.reserved`); only drafts made with `frameworkDraft` are accepted.
- `endpointOwnKey` (`@xandreed/plugin-models`) returns an `Effect`;
  `apiKeyEnv` and `EFFERENT_TRACE_CONTENT` are read with `Config` from the
  current `ConfigProvider`. Under the default environment provider an empty
  `apiKeyEnv` variable is unset, so the stored key is used;
  `ConfigProvider.fromEnv({ preserveEmptyStrings: true })` keeps the old
  behaviour.
- `classifyLlmError(error, now)` and `openAiCodexUuidV7(now)` take the time
  explicitly.
- `defineGraderCalibration` (`@xandreed/evals`) returns an `Effect` that
  fails with `invalid` when a case's input does not encode.
- `foldStreamParts` (`@xandreed/core`) leaves `usage` off the result when no
  finish part carried one.
- `Sessions.begin` fails with `TurnBeginError`; `Sessions.transact`,
  `cancel`, `deliver`, `drain` and `Tasks.start`, `cancel`, `reconcile` may
  fail with `SessionContended`.
- A stored `turn.ended` takes its code from `harnessCodeOf`: begin
  refusals, `TurnClosed` and `ReservedKind` store their own codes instead
  of `turn.failed`, a `SessionLogError` stores `session.log`, and an
  untagged value with a `code` stores `turn.failed`.
- `@xandreed/plugin-sessions`: writes that keep conflicting fail with
  `SessionContended` instead of `SessionLogError` `session.contended`, and
  `Tasks` passes it on. A log answer its contract rules out
  (`session.expired`, `session.begin`, `session.create`), or a value of the
  plugin's own that does not encode (`session.encode`), is a defect.
- `@xandreed/plugin-tasks`: `tasks.encode`, `tasks.kind` and `tasks.lost`
  are defects, no longer `SessionLogError`s.
- The turn's writer and the ports on the turn's path fail with `TurnError`
  (`HarnessError | TurnClosed | ReservedKind | SessionContended |
  SessionLogError`) instead of `HarnessError`: `TurnWriter`, `RunContext`,
  `TurnEvents`/`TurnTasks` and subscription handlers, memory's log and
  session writes, `TurnMemory`, `TurnToolbox`, `TurnPrompt`, `StepRequest`
  and `StepLoop.run`, `RunTools` and `ToolRegistry.open`, `TaskExecutor`,
  `Turn`, `TurnRunner.turn` and `Agent.turn` (which fails with
  `TurnError | E`). Types only: what is raised and stored is unchanged.
- The turn writer, `Agent.turn` and task turns fail with `TurnClosed`
  (`cancelled`, `interrupted`, `removed`, `ended`), `ReservedKind`,
  `SessionContended` or the store's `SessionLogError` instead of
  `HarnessError` codes; stored codes are unchanged. Reading a removed
  session through the writer fails with `TurnClosed` (`removed`).
- `PLUGIN_API_VERSION` is 3 (API 1 and 2 plugins still load), and
  `sessionsConformance` asserts the tags.
- `harnessDefectsAsFailures` restores any `TurnError` carried as a defect
  (`E | TurnError`), and `runSteps` and the tool registry pass `TurnError`s
  through.
- `Agent.turn` and `TurnRunner.turn` fail a turn that cannot begin with the
  refusal itself (`TurnBeginError`: `SessionBusy`, `TurnDuplicate`,
  `KeyConflict`, `RunIdReused`, `NothingPending`, `NotResumable`,
  `TurnRefused`, `SessionMissing`, `SessionContended`, `SessionLogError`,
  `AttachmentRejected`) instead of a `HarnessError` with its code; their
  error type is `TurnBeginError | TurnError | E`. The refusal keeps its
  fields, and its code is unchanged. `turnConformance` checks that a turn
  begun while another is open fails with that `SessionBusy` and runs and
  stores nothing.

### Added

- `reasonOf(cause)` in `@xandreed/core`: a cause as one line of text that is
  safe for reports, stored records and model-facing failures (`code:
  message`, `interrupted`, or the defect's message; never a stack).
- `authStoreConformance(store, { refresh?, corrupt? })` and
  `settingsStoreConformance(store, { writable, corrupt? })` check
  single-flight refresh, a logout during a refresh, and damaged backing
  data (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`,
  `SettingsStoreConformanceOptions`). `AuthError` and `SettingsError` have
  an optional `code`.
- `TurnResult.pending`: the inbox items the end of a turn `Agent.turn`
  began left waiting (a background task's result delivered while it ran,
  for example). Drain them with `Sessions.drain`.
- `runCliMain` (with `CliProcess` and `nodeProcess`), `readJson` and
  `readText` in `@xandreed/evals-cli`; `EvalPath` in `@xandreed/evals`.
- The routed model's `generateObject`; `makeOpenAiCodexSessions`,
  `OpenAiCodexSessions`, `OPENAI_CODEX_SESSION_CAPACITY` and
  `OpenAiErrorBody` in `@xandreed/plugin-models`.
- `hostNote`, `framed`, `escapeFrame`, `clipTo` and `clippedMarker` in
  `@xandreed/core` for model-facing text; `recall_context` takes an
  `offset`; `summaryTimeoutMs` (60 s) and `digestTimeoutMs` (30 s).
- `isHarnessError(value)` in `@xandreed/core`: matches a `HarnessError` from
  any installed copy of core. The framework uses it, so a code from another
  copy no longer becomes `loop.failed`, `task.turn` or a defect.
- `mergeOptions` and `PartialOptions` in `@xandreed/core`.
- `frameworkDraft`, `isFrameworkDraft`, `unmarkedReservedDraft`,
  `RunIdReused`, `TaskConflict` and `turnBeginCodes.RunIdReused`.
- `retrievalItems`, `RetrievalItem`, `RetrievalJudge` and
  `semanticRetrievalGraders(judge, { rubric })` in `@xandreed/evals`, whose
  rubric fingerprint follows the prompt; `GrepResult.unreadable` and
  `GrepUnreadable` in `@xandreed/plugin-workspace`; the bash kit's
  `backpressure` check, with `BashSubject.holdsBack`.
- `isFrozenRefusal(error)` in `@xandreed/plugin-render`: whether a
  `RenderStore` refused a write because the surface is frozen.
- `assessmentOfAiError` in `@xandreed/evals` turns a failed model call into
  an `AssessmentError`: `unavailable` when the provider may answer on a
  retry, `provider` otherwise, with the reason first in the message
  (`RateLimitError: …`) and the `AiError` as the `cause`.
  `EvaluationError` and `AssessmentError` take an optional `cause`.
- `harnessCodeOf(error)` in `@xandreed/core`: a failure's framework code,
  whichever copy of core made it. `HARNESS_CODES`/`HarnessCode` publish
  every code the packages raise or store, and
  `harnessError(code, message, cause?)` builds a `HarnessError` of one.
- `HarnessError`, `SessionLogError` and `UtilityError` take an optional
  `cause` (encoded as name and message, never the stack). New:
  `SessionContended`, the `TurnBeginError` union, the `TurnError` type,
  `isStoreBusy` and `errorCodeOf`.
- `turnBeginCodes` comes from `@xandreed/core` (still exported by
  `@xandreed/sdk`) and gains `SessionContended: "session.contended"`.
- `reasonOf` is exported from `@xandreed/evals`: a failure's cause as
  report text (`code: message`), never a stack.
- `isTurnError` in `@xandreed/core`.

### Fixed

- Failure text no longer carries stack traces or the local paths in them. A
  failed trial, grade or assessment records `code: message`, `interrupted`,
  or the defect's message, so `report.json`, CLI output and the Langfuse and
  LangSmith exports change wording. A tool handler that dies returns
  `ToolDefect` with the first line of its message only; the full cause is
  logged at error level with `tool` and `invocationId`.
- A background event handler that dies with a defect now fails the turn with
  that defect (`turn.defect` in `turn.ended`) instead of `events.background`
  carrying the stack. `events.background` now means a background handler was
  interrupted.
- A render publish retried after a failed commit commits the nodes the
  failed attempt left out before it completes, also after reopening; before,
  it was marked complete with a node missing.
- Two surfaces of one message no longer collide, filling a placeholder again
  in a later version no longer fails with `conflict`, a second surface's
  freeze is no longer dropped, and a frozen republish of a completed version
  records no partial completion.
- `MemoryRenderStoreLive` no longer returns other threads' or principals'
  records or receipts.
- SSE and WebSocket feed failures are logged. `sseNodePeer` drops a client
  that has not taken a write within its new `timeout` parameter (2 seconds),
  and no longer leaks its close listener.
- The file credential store refreshes an expiring OAuth token once, however
  many calls need it at the same moment; a login or logout made during the
  refresh wins; writes no longer share one temp file. Entries the plugin
  cannot read are kept on write.
- A refresh whose response leaves out the refresh token keeps the stored one
  (it used to sign the user out silently). Malformed Anthropic and OpenAI
  Codex token responses fail with an `AuthError` that never quotes the
  response, and the token request and its commit cannot be interrupted
  apart.
- Skills loaded by `load_skill` calls running at once (`toolConcurrency`
  above 1) all keep their tools active. Before, one call could drop the
  other's tools after the model was told they were available.
- A store failure while activating skills is no longer reported as a
  refusal. From `load_skill` it fails the turn; from `apply` it fails the
  call and records no "rejected" decision. Only an unknown skill or a
  missing permission rejects an activation.
- `Sessions.drain` stops at the end of a turn that leaves nothing waiting,
  instead of trying one more begin.
- A turn's reply is recorded, and its journal flushed, even when the turn is
  interrupted after its body returned.
- A cancelled turn no longer waits for the background reactions to its
  failed reply, and a failed turn waits for them for 10 seconds at most.
- A background event handler that publishes events a background
  subscription takes (its own or another) no longer deadlocks on a full
  queue, and a publisher waiting for room can always be interrupted.
- A turn is judged by how it was taken, not by the reader's ownership
  setting: changing ownership no longer holds a turn forever or reaps a live
  one.
- A turn end or lease write the store refuses is logged, and the instance
  lets the turn go instead of answering `SessionBusy` until the process
  exits.
- Ctrl-C or SIGTERM during `efferent-eval` settles running trials as
  `cancelled`, closes their worlds and exits 130; a blocking gate still
  exits 2.
- A timed-out or cancelled trial keeps the outcome its environment showed.
- `compare` no longer reports a coverage difference (exit 2) when trials ran
  in another order. Fingerprints and system-prompt section ties use
  code-unit order on every machine; a fingerprint over keys that differ only
  in case or punctuation can change once.
- `efferent-eval` accepts `--flag=value`, names its default directory after
  the run id, refuses bad counts, reports a missing file as `missing`, and
  removes temp files after a failed write.
- The LangSmith export sends encoded values (`null`, not Option objects),
  and exporting again updates the runs and feedback the first export
  created.
- An exhausted balance or quota (a 402, `CreditsError`,
  `insufficient_quota`) is a `QuotaExhaustedError`: no retries, no fallback.
  A plain 429 whose message says "quota" is a retried `RateLimitError`.
- A provider body or stream chunk that is not JSON, is `null` or has the
  wrong shape is an `InvalidResponseError`; the agent loop no longer answers
  it with corrective turns.
- `openai-codex`: a normal socket close ends the stream instead of hanging
  the call, and an `error` event before any other is answered with its
  status (a server error is retried) instead of a decode failure.
- `openai` sends the configured reasoning effort and output cap to models
  that take an effort; OpenCode chat models get `xhigh`/`max` as `high` and
  `none` as `low`; utility calls use `fastReasoningEffort`.
- The model sees an earlier summary as a `[Host note: …]` with the summary
  inside `<conversation-summary>` tags, as a record, not instructions. The
  summarizer and the digester get their input tagged as data and capped,
  with counted clips, so text planted in a tool result no longer comes back
  as authority.
- The summary transcript cap always holds. A summarizer or digester that
  fails or times out is logged and the turn goes on without the new summary
  (before, a stalled utility model hung every turn).
- Digest replies keep keys that start with digits, and summarize digests
  list the ids they must keep.
- `recall_context` returns 8,000-character pages and a recalled page is
  never spilled again; the spill preview gives the offset to read on from.
- The `start_task` description says what a fork sees, task notices cannot
  be closed by a tag in any case, and task turns are admitted with the
  starter's `meta`.
- The dispatch check compares the cache key and call policy with what the
  model call reads, instead of comparing the turn's own inputs with
  themselves.
- Completion verdicts' `awaiting` tags are trimmed and empty ones dropped;
  an untrimmed tag no longer ends the turn as `turn.defect`.
- A plugin layer that dies with a `HarnessError` keeps its code, and
  `stackPlugins` shares one memo map across its levels without leaking it to
  the layers built over it.
- `makeSession`: a turn interrupted together with its sender records its
  interrupt once, and a later `interrupt` or `shutdown` adds no stale event.
- Nested plugin options keep their sibling defaults:
  `{ inbox: { maxPending: 50 } }` no longer fails with `config.options`. An
  object of another union variant still replaces its default.
- `makeLiveLayer`: uses keep running while a replacement builds, and a
  registry closed mid-replacement no longer leaks the staged generation.
- The agent fingerprint no longer depends on the key order of options or
  bindings.
- An end the store refused no longer lets writes in after a later end.
- A store write that dies with a defect fails later writes with
  `session.defect` and is logged, instead of leaving them waiting.
- `cancel` reaps a turn nobody holds, the same way a reap does, whichever
  comes first.
- A task's child session is created only after `task.started` is stored, a
  retried start finishes a half-done one, and task store failures are
  logged as warnings.
- `BashLive` no longer gathers a command's output without bound: on Node a
  slow reader holds the command back on a full pipe (Bun reads child pipes
  ahead regardless). An error reading stdout or stderr fails the stream with
  `SpawnFailed`.
- The SQLite session log no longer blocks the JavaScript thread waiting for
  another connection's lock: it retries for up to 5 s, then fails with
  `store.busy`. It runs WAL with `synchronous = NORMAL`, and a damaged row
  fails with `SessionLogError` code `store.decode` instead of a defect
  (`list` and `read` used to say `store.io`).
- `grep` names the files it could not read (permission denied) instead of
  counting them as binary or too large. `read`, `ls`, `find` and `grep` show
  their real `limit` maximum, and a larger value is refused rather than
  quietly lowered.
- Retrieval judges get the ids they must return.
- The session logs fail a commit holding data JSON cannot represent with
  `SessionLogError` `store.encode` instead of dying, and the in-memory log
  drops `undefined` fields, as SQLite does.
- Failures the framework drops on purpose are logged: lost writes and
  cleanups at Warn, expected misses at Debug.
- Evals keep provider reasons: a rate limit, network or server failure, or
  unparseable judge output is `unavailable` instead of `error`, and every
  provider failure names the provider's reason instead of a generic class.
- Evals errors that wrap a schema, transport or provider failure keep it as
  `cause` and say what failed (`Dataset case bad does not decode: …`).
  Reasons in reports still carry no stacks or causes.
- Foundry's errors keep the failure they wrap: `GateCrash`,
  `ImplementorError`, `WorkspaceError`, `ConfigError` and `ProjectLoadError`
  gain an optional `cause` (encoded as the error's name and message, never
  its stack), set by the config loader, the baseline writer, the run sink,
  the temporary workspace, the claude implementor and the registration and
  private-text gates. `foundry check`, `foundry demo` and a crashed gate's
  finding still show the wrapped error's message.
- The evals CLI and the Langfuse and LangSmith exporters keep the failure
  they wrap as the error's `cause` and say what failed (`Cannot read
  <path>: …`, `Run <id> does not encode: …`, `LangSmith export: …`). Error
  codes are unchanged, and export receipts still hold the message only.
- `definePlugin` keeps what failed: `plugin.activation`, `plugin.defect` and
  `config.options` errors carry the original failure as `cause`, and a
  `HarnessError` a plugin's layer fails or dies with keeps its own `cause`
  when the plugin is named. Messages name the plugin and the failure's text
  (`<id> failed to activate: <reason>`), never a stack; `config.options`
  messages are the schema's message without the `SchemaError(...)` wrapper.
- `SpecDocParseError` keeps the schema's failure as `cause`; its message is
  the schema's message.
- A provider failure that ends a run (`loop.failed`), a model that cannot
  be resolved (`request.model`) and a failed utility call (`UtilityError`)
  keep the provider's `AiError` as their `cause`, and their message is its
  text (`AiError: <module>.<method>: …`).
- Plugin options that do not decode in the plugin graph (`config.options`)
  keep the schema error as their `cause`, and the message is the schema
  error's own text.
- `@xandreed/plugin-models` describes a request or response stream that
  fails with a value that is not an `Error` by its code and message instead
  of `[object Object]`, with proxy credentials redacted.
- A begin through `Agent.turn` that loses to other writers fails with
  `session.contended`, not `session.log`, and a turn that fails on it
  stores `session.contended`.
- SQLite store errors keep SQLite's error as `cause`, and `isStoreBusy`
  recognises `store.busy`.
- A task whose turn fails with `SessionContended`, `ReservedKind` or
  `SessionLogError` stores that tag's code instead of `task.turn`.

### Repository

- The contributor guidance (`AGENTS.md` and the `commit-style` skill) states
  its commit and publishing rules directly, and the duplicate copy of the
  skill under `.efferent/skills` is removed. The ChatGPT subscription
  adapter keeps its OAuth originator in one constant,
  `OPENAI_CODEX_ORIGINATOR`.
- `toolRegistryConformance` adds a `concurrent-load` check, and its writer
  yields before each write, as storage does.
- The turn kit adds `pending`, `stuck-reaction` and `self-publication`
  checks, and the sessions kit adds `tenure` (it needs `processOwned`).
- `stepLoopConformance` adds a `cache-key` check.
- The sessions kit adds `run-id` and `cancel-unheld` and extends its
  `transact` checks; the tasks kit adds `task-id` and extends `start-once`.
- `bun run typecheck` fails when a package under `packages/` is missing
  from a list the gates or the build read: `CHECKED`, a boundaries layer,
  the build's `names`, the base tsconfig's `paths`, or, for a plugin, the
  plugin reference's `firstParty`. The message names the package and the
  list, and CONTRIBUTING.md lists the steps for adding a package.
- The foundry baseline must stay empty: `bun run typecheck` fails while
  `.foundry/baseline.json` holds a fingerprint, and the baseline no longer
  excuses any finding. `foundry check --update-baseline --allow-grow` warns
  that CI will refuse the grown file. A foundry config can declare
  `registration` (the lists every package must appear in) and
  `baseline: "empty"`.
- Package builds leave out test code. `verify:packages` refuses a build of
  another commit, a build from a tree with changes (`--allow-dirty` checks a
  local build) and built packages holding test code.
- The root `AGENTS.md` is rules only: a task map to the skills, a table of
  every gate rule with what it bans and how to fix it, which gates see each
  file role, how ports, adapters and plugins compose, naming rules for new
  code (`Effect.fn("area.op")` at service boundaries,
  `@xandreed/<package>/<Name>` service keys, `<thing>Plugin` exports) and a
  definition of done identical to CI. A test keeps the rule table and the CI
  commands in step with `foundry.config.ts` and `ci.yml`.
- `CONTRIBUTING.md` covers process only: Node 24.5 and the pre-commit hook,
  changelog headings, re-recording the sdk golden, when to run
  `docs:generate`, and tags resuming at `v0.14.0`. The foundry and core
  notes are brought up to date.
- The `commit-style` skill covers squash-merged PR titles and bodies as well
  as commits, with current examples and no title prefix.
- New contributor skills in `.agents/skills`: `add-plugin`, `add-port`,
  `write-model-text`, `effect-idioms`, `domain-entity`, `change-event`,
  `journey-test` and `release`. They cover registering a package or plugin,
  ports with their conformance kits, text the model reads, Effect 4 idioms
  (including `Effect.fn` spans at service boundaries), domain schemas,
  events and stored payloads, key-free journey tests, and the release order.
- Every published package has an `AGENTS.md` (with a `CLAUDE.md` link):
  what it provides and its layer, its rules, its public surface and
  plugins, the text it sends to a model with the test or golden that pins
  each (or "unpinned"), its type-erasure files, its layout and how to run
  its tests. The plugin-workspace notes take the same shape.
- Eleven new gate rules (`no-json-parse`, `no-sync-codec`,
  `no-cause-pretty-data`, `no-effect-promise`, `no-promise-all`,
  `callback-buffer-size`, `no-process-env`, `no-ambient-time-random`,
  `no-locale-compare`, `require-sort-comparator`,
  `no-instanceof-tagged-error`) and the `quality/no-private-text` gate (home
  paths, plus an optional gitignored local denylist,
  `.foundry/private-terms.txt`); `effect/no-as-never` rejects `as never as
  T` everywhere. Every violation is fixed and the baseline stays empty.
- New gate rules: `no-silent-ignore`, `no-option-unwrap`,
  `no-stringified-cause`, `no-error-code-compare`, `prefer-effect-fn`,
  `require-concurrency-option` and `architecture/role-suffix-required`;
  `match-over-tag-switch` also refuses ternary chains and
  `type`/`role`/`mode` discriminants. Rules with findings enter one package
  at a time through `include` lists, and a rule's `allow` list can only
  shrink.
- `effect/match-over-tag-switch` refuses ternary chains and
  `type`/`role`/`mode` branching in every package, and
  `effect/require-concurrency-option` runs in every package: every
  `Effect.forEach` and `Effect.all` states its concurrency (sequential where
  order, a shared resource or the first failure matters).
- `foundry check` reads the source files behind findings and the run
  history eight at a time instead of one by one.
- The render surface recognises a frozen refusal through that guard instead
  of comparing the error code, and `plugin-render` passes
  `effect/no-error-code-compare`.
- `@xandreed/evals` passes `effect/no-stringified-cause` and
  `effect/no-error-code-compare`.
- `effect/no-stringified-cause` runs over `packages/foundry`.
- `@xandreed/evals-cli`, `@xandreed/evals-langfuse` and
  `@xandreed/evals-langsmith` pass `effect/no-stringified-cause`.
- `effect/no-stringified-cause` runs over `packages/core`, and
  `effect/no-instanceof-tagged-error` runs over test code too.
- The event reference's "Error codes" section (formerly "Common turn error
  codes", now at `#error-codes`) lists every code in `HARNESS_CODES` with
  where it comes from and what it means, the store, storage, auth,
  settings, skills, capability, memory and module codes included.
  `bun run docs:generate` fails when a package raises a code that is not
  published (in any namespace but the kits' `conformance.*`), or when a
  published code has no entry.
- `runtime`, `plugin-agent-loop` and `plugin-models` pass
  `effect/no-stringified-cause`, and `plugin-models` and `plugin-workspace`
  read a foreign error's code with core's `errorCodeOf`.
- `plugin-session-sqlite` passes `effect/no-stringified-cause` and
  `effect/no-error-code-compare`.
- `effect/no-stringified-cause` and `effect/no-error-code-compare` run in
  every package. The agent guidance (`AGENTS.md`, the `effect-idioms` skill)
  covers the error model: tagged errors keep a `cause`, first-party codes
  come from `HARNESS_CODES` through `harnessError`, `Agent.turn` fails with
  `TurnBeginError` or `TurnError`, codes are read with `harnessCodeOf`
  (`errorCodeOf` for a Node or SQLite code), and errors are recognised by
  tag and fields rather than `Schema.is` of a class, which fails for an
  error from another copy of core.

## 0.14.0 — 2026-10-29

Agents that work on files and commands, images to and from the model, token
usage with cache writes and reasoning, telemetry outside evals, an HTTP
proxy, credential and settings stores that never touch disk, and a turn
lifecycle a service can run on: host metadata, real failure codes, resume,
a busy signal and lease keep-alive. 19 packages: `@xandreed/plugin-workspace`
is new, and `@xandreed/plugin-telemetry` is a new plugin under an old name.

### Migration

- Run `@xandreed/plugin-models` on Node 24.5 or newer (or Bun 1.3.0 or
  newer). It now depends on `undici`, and honours `HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY` on Node too.
- `Agent.turn` returns a `TurnResult`: the outcome plus the turn's `usage`.
  Code that reads the outcome keeps working; code that builds one (a
  host-composed runner, a fake) adds `usage`.
- Build `TokenUsage` with `tokenUsage(...)` or spread `zeroUsage`: it has
  `cacheWriteTokens` and `reasoningTokens`. A custom `StepLoop` returns the
  run's `usage`, provides `captureTraceContent` and honours
  `onMediaRejected`; run `stepLoopConformance` against it.
- `Shell` is now `Bash`: `bash.exec(command, { cwd, timeoutMs, env, stdin })`,
  with `exitCode` an `Option` and `termination` saying how it ended. A
  `FileSystem` implementation adds the new methods (`walkGlob` gives it
  `glob`) and runs `fileSystemConformance`. `FileSystemLive` and `BashLive`
  for the local machine are in `@xandreed/plugin-workspace`, with the
  workspace tools (`workspaceToolsPlugin`).
- Hand-written `AdmittedTurn`, `TurnToAdmit`, `RunContext` and `Turn` values
  add `meta` (and `usage`). Exhaustive matches on `TurnEvent` handle
  `tool.progress`, `tool.refused` and `stream.fallback`; matches on
  `Sessions.begin`'s errors handle `AttachmentRejected` and `NotResumable`
  (`turnBeginCodes` maps both). A host event may not use any bus event's
  name.
- `UserMessageFromString` is removed: build `new UserMessage({ text })`.
  The memory plugins now send earlier turns' images too (`media: "inline"`);
  set `media: "none"` for label lines instead, or `maxMediaChars: 0` for
  text only. A tool view declares `media` (`defineTool` fills it).
- `modelsPlugin` is runtime-scoped: built once per `Agent.define`, and a
  per-turn `LanguageModel` now wins over it. `storage: "memory"` keeps
  credentials and settings off disk; `ModelEndpoint.apiKey` may be
  `Redacted`.
- Lease ownership renews every 20 seconds by default; set
  `renew: "on-commit"` for the old behaviour. A keep-alive must renew at
  least twice per lease (`everyMs * 2 <= ttlMs`).
- A plugin that fails to build with a `HarnessError` fails with that error's
  own code (`skills.duplicate`, `config.options`), not `plugin.activation`.
- The old `@xandreed/plugin-telemetry` options (`enabled`, `serviceName`)
  are refused: configure `telemetryPlugin` and export with an
  `OtlpTelemetry*` layer.

### Breaking

- **`@xandreed/plugin-session-sqlite`: a commit that waited past its lease is
  refused.** The SQLite log read the clock before taking its write lock, so a
  commit that waited for another connection's lock beyond its `notAfter` was
  still accepted, stamped with the time it started waiting. The clock (the
  caller's Effect `Clock`) is now read inside the IMMEDIATE transaction, in
  `commit` and in `create`: such a commit fails with `LeaseExpired`, and
  events and `updatedAt` carry the time they were written.
- **`@xandreed/plugin-session-sqlite`: lock contention fails with
  `store.busy`.** A write lock held by another connection past the 5 s busy
  timeout fails with `SessionLogError` code `store.busy`; it was `store.io`.
  A host that matched `store.io` to retry on lock contention matches
  `store.busy` now; `store.io` is left for other storage failures.
- **`@xandreed/core`: `TokenUsage` has two more `Type` fields**,
  `cacheWriteTokens` and `reasoningTokens`. Stored data still decodes:
  records without them read 0. Object literals (a `UtilityCompletion`'s
  usage, a `UtilityLlm` fake) must add them; build them with
  `tokenUsage({ inputTokens, outputTokens, ... })` or spread `zeroUsage`.
- **`@xandreed/core`: `RunResult.usage`, `AgentResult.usage`,
  `RunContext.usage` and `Turn.usage` are required.** A custom `StepLoop`
  returns the sum of the usage its `assistant.message` events carried;
  hand-written `RunContext` or `Turn` fakes add `usage`.
- **`@xandreed/core`, `@xandreed/sdk`: `Agent.turn`, `TurnRunner.turn` and
  `guardTurn` return `TurnResult`.** A host-composed runner built on
  `guardTurn` gets it as is; one that is not adds `usage`, for example from
  `RunContext.usage`. `use` still returns a `TurnOutcome`.
- **`@xandreed/core`: `TurnEndedEvent` requires `usage`.** Code constructing
  the bus event adds it; the stored `turn.ended` record is unchanged.
- **`@xandreed/core`: `step.usage` records and the usage stamp on stored
  assistant messages gain the two keys.** A reader that compares stored
  usage byte for byte (a golden) sees them. The memory context's token
  estimate and fingerprint include the stamp, so for new turns they change
  (the estimate grows by a few tokens per assistant message); requests sent
  to the model do not change.
- **`@xandreed/core`: `extractUsage` and `assistantUsage` hold the usage
  invariants.** `extractUsage` raises an input reported below its cache
  reads plus writes to them, and an output reported below its reasoning to
  it. Its last fallback, Gemini's raw usage metadata (used only when neither
  the response nor its finish part carries effect/ai usage, which no
  provider shipped here does), reads `thoughtsTokenCount` as reasoning
  inside the output: output = candidates + thoughts, total = input + output
  (it read `totalTokenCount`, and left thoughts out of the output).
  `assistantUsage` decodes the stamp: a malformed stamp reads `None` (it was
  `Some` of the stamp as found), and the usage it returns no longer carries
  the stamp's `model` key (`assistantModel` reads it).
- **`@xandreed/plugin-models`**: the finish part of `fromChatCompletion`
  and of the streaming client reports `cacheWrite`, `text` and `reasoning`
  beside the old counts; `fromChatCompletion` takes an optional
  `UsageReading` (`{ reasoning }`). The router reads each call's usage
  through `extractUsage`, so its `llm.usage.input_tokens` counter and span
  attribute are raised to the cache reads plus writes when the provider
  reports less, and `llm.usage.output_tokens` to the reasoning.
- **`@xandreed/core`: `Shell` is replaced by `Bash`.** `Shell`, `ShellError`
  and `ShellResult` are removed. `Bash.exec(command, { cwd, timeoutMs })`
  returns a `BashResult` whose `exitCode` and `signal` are Options and whose
  `termination` (`exit`, `signal`, `timeout`, `interrupted`) says how it
  ended: a timeout is `termination: "timeout"`, not a note on stderr. `cwd` is
  required. Live output comes from `Bash.stream` (chunks, then one
  `BashExit`) instead of the `onChunk` callback. A command no longer inherits
  the whole parent environment: only `BASH_ENV_ALLOWLIST` passes unless
  `inheritEnv` says otherwise. Migration: `shell.exec(cmd, { cwd, timeoutMs })`
  becomes `bash.exec(cmd, { cwd, timeoutMs })`, `result.exitCode` becomes
  `Option.getOrElse(result.exitCode, () => -1)` where a number is needed, and
  an implementation of the port adds `stream` and builds `exec` with
  `collectBashResult`.
- **`@xandreed/core`: `FsError.reason` is required.** `FsError` is now
  `{ path, reason, message }` with `reason` one of `NotFound`, `Exists`,
  `IsDirectory`, `NotDirectory`, `NotEmpty`, `Permission`, `Invalid`, `Io`,
  and is exported from the domain module (still from `@xandreed/core`).
  Migration: construct it with the reason that fits, `Io` when unsure.
- **`@xandreed/core`: `FileSystem.list` returns `DirEntry`s.** It was the
  names; it is now `{ name, kind }` sorted by name, links not followed.
  Migration: `list(dir).pipe(Effect.map((entries) => entries.map((entry) => entry.name)))`.
- **`@xandreed/core`: `FileSystem` implementations must add the new
  methods.** The port gains `readBytes`, `append`, `rename`, `stat` and
  `glob`; `write` takes `string | Uint8Array` and `{ createParents }`,
  `mkdir` takes `{ recursive }` (without it, an existing path fails with
  `Exists` and a missing parent with `NotFound`; pass `recursive: true` for
  the old create-if-missing behaviour), and `remove` takes `{ recursive }`
  and removes empty directories. `remove` follows links in the parent but
  never the last name (`link/` removes the link) and refuses the root and a
  path whose last segment is `.` or `..` with `Invalid`; a `rename` failure
  names the side that caused it (`to` for a missing parent there or what is
  in the way). Migration: implement `glob` as
  `walkGlob(list, pattern, options)` and run `fileSystemConformance`.
- **`@xandreed/core`: `TurnEvent` gains `tool.progress`.** Code matching the
  union exhaustively (`Match.exhaustive`, a `switch` with a `never` default)
  must handle it. It is transient (in `TransientTurnEvents`) and never
  journaled, so stored sessions are unchanged.
- **`@xandreed/plugin-tool-discovery`: a handler that dies with a
  `HarnessError` fails the turn.** That defect comes from a subscriber that
  failed on an event the handler published (`tool.progress`, or
  `skills.activated` from `load_skill`). It reached the model as a
  `ToolDefect` result and the turn went on; now the registry publishes
  `tool.completed` and then fails the turn with that error, as a subscriber
  failure on `tool.started` always did. A handler that wants the model to
  see a failure returns it on its failure channel.
- **`@xandreed/core`: `AdmittedTurn`, `TurnToAdmit`, `RunContext` and `Turn`
  have new required fields** for the host's turn metadata:
  `AdmittedTurn.meta` and `TurnToAdmit.meta` (`{}` when the turn was begun
  without any), and `RunContext.admitted` and `Turn.admitted` (the admitted
  turn). Hand-built values (a fake `TurnWriter`'s `admitted`, a `RunContext`
  or `Turn` stub) add them: `meta: {}`, and `admitted` as the writer's.
- **`@xandreed/core`: the bus `turn.started` event requires `meta`, and
  `context.built` requires `budgetTokens`.** Code constructing these events
  adds them. The stored `context.built` record gains `budgetTokens` (its
  journal schema keeps it optional, so records written before still decode);
  the stored `turn.started` gains `meta` only when the turn was given one,
  so turns without it are stored as before.
- **`@xandreed/sdk`, `@xandreed/plugin-sessions`: stored `turn.ended`
  records carry the real failure code.** A turn `Agent.turn` began and that
  fails is ended with `turnEndingOf` its exit: the error's own code and
  message (`host.failed`, `reaction.failed`, a `SessionLogError`'s code, a
  `HarnessError` carried as a defect), `turn.failed` for an error without a
  code, `turn.defect` for a defect; it was always `turn.unended`. A
  writer's scope, or a begin, interrupted before the turn ended stores
  `turn.interrupted`; `turn.unended` is left for a scope that closed
  without an interruption before anyone tried to end the turn. A turn
  whose `use` interrupted itself (an `Effect.interrupt` inside it) still
  ends `interrupted`; only its code changes, from `turn.unended` to
  `turn.interrupted`. An end the store refuses is tried again by the
  writer's scope with that same ending, where it used to store
  `turn.unended`. `Sessions.drain` ends a failed inbox turn with its
  error's code the same way (a `HarnessError` carried as a defect keeps
  its code): `inbox.turn` is no longer written. A drain `run` that
  interrupted itself ends `interrupted` with `turn.interrupted`, where it
  ended `failed`; it still counts an attempt for the items it took, even
  when it wrote nothing, so such an item is still dropped after
  `inbox.attempts`. Migration: a host that matched `turn.unended` or
  `inbox.turn` in stored `turn.ended` records matches the failing error's
  code, `turn.failed`, `turn.defect` or `turn.interrupted` instead (the
  event reference lists them), and a host that read a drain turn's
  `reason: "failed"` as any non-success reads `interrupted` as well.
- **`@xandreed/sdk`, `@xandreed/core`: token budgets are checked.**
  `Agent.define` fails with `config.budget` when `budgetTokens` is not an
  integer of at least 1, and a run fails with `turn.budget` when its
  policy's (or `TurnRunOptions`') is not; both were used as given. A step whose system prompt and tool schemas take the whole
  budget fails with `context.budget`: memory used to get a 1-token budget
  for the messages, so the window strategy failed with `context.budget`
  later and the summary strategy summarized at every step. Migration: pass
  a positive integer, at least the system prompt and tool schemas plus room
  for the messages (`context.built` records the run's `budgetTokens` beside
  `reservedTokens`).
- **`@xandreed/plugin-models`: `modelsPlugin` is runtime-scoped.** It is
  built once per `Agent.define`, no longer on every turn, so credentials,
  refreshed tokens and settings edits held in memory last across turns. Two
  consequences:
  - A turn's own services now win over the plugin: a `LanguageModel` (or
    `UtilityLlm`, `AuthStore`, `SettingsStore`, `ModelCatalog`) in a turn's
    `services` replaces the plugin's for that turn; before, the plugin's
    replaced the turn's. Migration: a host that passed a per-turn model only
    as a fallback drops it, or drops the plugin. A per-turn `AuthStore` or
    `SettingsStore` reaches the turn's own code only: the plugin's
    `LanguageModel`, `UtilityLlm` and `ModelCatalog` keep the plugin's stores.
  - Its `SessionEnvironment` and `HostCredentials` must come from
    `Agent.define({ workspace, services })`; an agent with a session-scoped
    plugin providing either is refused (`config.graph`: "runtime plugins
    cannot depend on session service"). A per-turn `SessionEnvironment` no
    longer reaches it. Migration: move the provider into `Agent.define`.
- **`@xandreed/plugin-models`: the local `SettingsStore` re-reads its files
  on every `load`.** With `storage: "local"` and `inheritPrevious`, the
  plugin's settings are `~/.efferent/config.json` and
  `<workspace>/.efferent/config.json` read on each `load` (the options laid
  over them), not a snapshot taken when a turn began. An edit to those files
  applies from the next model call.
- **`@xandreed/plugin-models`: `ModelEndpoint.apiKey` is `string | Redacted<string>`.**
  Code reading `endpoint.apiKey` (or `CurrentModelEndpoints`) as a `string`
  narrows it with `Redacted.isRedacted`.
- **`@xandreed/plugin-models`: `LocalSettingsStoreLive`'s `setRole` checks
  its selection.** A value that is not `"<provider>:<modelId>"` fails with a
  `SettingsError` and is not written; it was written and then ignored by the
  router.
- **`@xandreed/plugin-models`: error texts.** A missing credential says how to
  give one with either storage (it named `~/.efferent/auth.json`; logins go
  to `~/.efferent/runtime/auth.json`); "no model configured" no longer
  mentions a terminal or `efferent.config.json`; an OAuth subscription token
  without an account id, or an expired token of a provider with no refresh
  flow, no longer mention the removed CLI or "the new line". An unknown
  option of the plugin, or of one of its `endpoints`, reads "not an option of
  the models plugin" (or "of a model endpoint") with its path, without its
  value. Code matching on the old texts matches the new ones.
- **The plugin reference** (`docs/plugin-reference.json`) gains `optional`
  (the services a plugin uses when present) and `contributes` (the
  multi-provider keys it adds to, such as `Capabilities`) for every plugin,
  and the models plugin's entry its new scope and options; its graph
  fingerprint changes.
- **`@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`:
  `Sessions.begin` can fail with `NotResumable`.** Its error union gains it,
  for a user's turn whose `resumes` names a turn that cannot be resumed.
  Code handling the union exhaustively (`Effect.catchTags` over every
  member, `Match.exhaustive`) adds a case; for a begin that never sets
  `resumes` it is never raised (`Sessions.drain` and plugin-tasks map it to
  "nothing begun"). `@xandreed/sdk`'s `turnBeginCodes` gains `NotResumable:
  "turn.not-resumable"`, so a host mapping its codes exhaustively
  (`Record<keyof typeof turnBeginCodes, …>`) adds one. A host's own
  implementation of the `Sessions` port honours the new optional
  `BeginTurn.User.resumes`: it refuses what `resumeRefusal` refuses (a
  `resumes` that is not a whole number of at least 1 as `missing`), stores
  `resumes` in `turn.started`, shows it on `admitted` and `TurnToAdmit`, and
  compares it in the key's fingerprint. The new `resumes` fields are
  optional keys, present only on a turn that resumes one, so turns, stored
  records and events without it are unchanged.
- **`@xandreed/core`: `UserMessage` may carry images, and its rule
  changed.** It is `{ text, attachments? }`: `text` is a plain string (it was
  `NonEmptyString`) and a message needs text or at least one attachment
  (`text.length > 0 || attachments`), at most `MEDIA_LIMITS.attachments`.
  Whitespace-only text is still a message, so every log written before
  decodes. Code that read `userMessage.text` as the whole message reads
  `userMessageText(userMessage)` (its text and a label line per image) where
  images matter.
- **`@xandreed/core`: `UserMessageFromString` is removed.** It was the
  memory log's text-only `TurnStarted` codec; the log's `TurnStarted` now
  stores `prompt` and, only when there are images, `attachments`, so a
  text-only entry is stored exactly as before. No replacement.
- **`@xandreed/core`: `UserRoleMessage.content` is
  `string | ReadonlyArray<TextPart | Media>`** (`UserContentPart`). A
  message with images renders as parts. Code that reads it as a string
  narrows first (`typeof content === "string"`).
- **`@xandreed/core`, `@xandreed/plugin-sessions`: `Sessions.begin` can
  fail with `AttachmentRejected`.** The error union gains it; a begin
  normalises the user's message first (`normalizeUserMessage`) and stores
  that value. A `catchTags` over every begin error adds it; `Agent.turn`
  fails with `turn.attachment-rejected` (`turnBeginCodes.AttachmentRejected`),
  its reason in the message only (a host that branches on it runs
  `normalizeUserMessage` itself first). A `Sessions` implementation of the
  host's adds it to `begin`, and should store and compare the normalised
  message as plugin-sessions does.
- **`@xandreed/core`: `RenderOptions.media` and `MemoryRenderRecipe.media`
  require `maxChars`**, the base64 characters of the images a request sends.
  A custom `MemoryPolicy.render` adds it (`MEDIA_LIMITS.requestChars`); a
  stored `request.prepared` header written before reads that value, and new
  headers store it (a golden of stored headers sees the new key). `maxImages`
  now also caps the images sent (never more than `MEDIA_LIMITS.requestImages`
  whatever it says), besides the artifact reference lines.
- **`@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `MemoryWindowConfig` and `MemorySummaryConfig` require `maxMediaChars`.**
  JSON and plugin configuration are unaffected (the graph merges the
  defaults); code that calls `windowPolicy` or `summaryPolicy` with a whole
  config literal spreads `memoryWindowDefaults` / `memorySummaryDefaults`
  or adds the field.
- **`@xandreed/core`: `sessionLogConformance` has a new check**: an event
  of `MEDIA_LIMITS.requestChars` base64 characters comes back whole. A host's
  store with a smaller row or document limit fails it; such a store cannot
  hold a message's images at their limit.
- **`@xandreed/core`: `memoryConformance` and `turnConformance` have new
  `attachments` checks**, which a host's memory strategy or turn
  composition that passed before can fail. `memoryConformance`: a message's
  images survive a reopen, the current turn's are built as image parts with
  their data, an earlier turn's as image parts or label lines, and no empty
  text part is built. `turnConformance`: the user's attachments are stored
  in `turn.started` and reach the first request as `file` parts. A strategy
  that renders `TurnStarted` from `userMessage.text` alone, or one set to
  send no images (`maxImages: 0`, `maxMediaChars: 0`), fails them; run the
  kits with a budget that admits one small image.
- **`@xandreed/core`: readers of 0.13 cannot read every newer log.** A
  0.13 reader drops a message's images and fails on a message without text;
  a replay of a request with images diverges there (`request.diverged`).
  Logs written before 0.14.0 decode unchanged in 0.14.0.
- **`@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `media` defaults to `"inline"`** (it was `"none"`). Earlier turns' images,
  a user's and those tools return, are now sent while they fit `maxImages`
  and `maxMediaChars`, newest turn first; the current turn's are sent in both
  modes, as before. Stored `request.prepared` headers record
  `"mode":"inline"` (a golden of them sees it). Migration: set
  `media: "none"` to show earlier turns' images as label lines, or
  `maxMediaChars: 0` for models that read text only.
- **`@xandreed/core`: `ToolViewDefinition.media` is required**, an
  `Option` of the selector of the images the model is sent with a result.
  Views built with `defineTool` get it (`None`: every image the result
  holds). Migration: a `ToolViewDefinition` written by hand adds
  `media: Option.none()`.
- **`@xandreed/core`: `StepRequest.onMediaRejected` is required**:
  `(reason) => Effect<boolean, HarnessError>`, called by the step loop when
  a provider refuses a request over an image. `stepRequestOf` provides it.
  Migration: a `StepRequest` built by hand (a fake in a test, a host's own
  turn) adds `onMediaRejected: () => Effect.succeed(false)`; a custom
  `StepLoop` calls it on an `InvalidRequestError` that names an image and,
  when it answers true, plans the step again and sends it once more.
  `stepLoopConformance` has two new checks for it, so a `StepLoop` that
  ignores the hook fails the kit. The next `plan` of that step, that one
  only, keeps the refused request's model choice, system prompt and
  directive; any other `plan` of a step asks the policy again.
- **`@xandreed/core`: `CompactionAction` gains `OmitMedia`.** Code that
  matches every action exhaustively adds the case. A step that is sent again
  after an image refusal publishes `context.built` and stores
  `request.prepared` a second time for that step; the dispatch check reads
  the latest header, as `replayModelRequest` does. A 0.13 reader fails on a
  log holding an `OmitMedia` compaction, and drops a tool result's `media`
  slots.
- **`@xandreed/plugin-agent-loop`: a streamed step refused over an image no
  longer falls back** to a settled call (`stream.fallback`): an
  `InvalidRequestError` that names an image, before the first part, goes to
  `onMediaRejected` (the step is sent again without the images, or fails).
  A refusal after the first part fails the step, as any failure there did.
- **`@xandreed/core`: `memoryConformance` has a new `tool-media` check**: a
  tool result's images (`ToolView.media` slots) are stored once, survive a
  reopen, and the current turn's are built as the result's images. A host's
  strategy that renders tool results from their view text alone, or one set
  to send no images, fails it.
- **`@xandreed/plugin-tool-discovery`: the raw view of a result holding
  images elides their data.** A tool without a view whose result holds
  `Media` values shows each with its `data` replaced by its fingerprint in
  the result's text, and sends the images as images; the text no longer
  carries the base64.
- **`@xandreed/core`: `skillsFromFiles` reads a whole tree, and names
  references by path.** It is now `readSkillFiles` made strict (below):
  - A reference's id is its path below the skill's directory
    (`references/formats.md`; it was `formats`), and every other text file
    of the directory is a reference (it was `references/**/*.md` only).
  - A `SKILL.md` at any depth is a skill (it was `<skill>/SKILL.md` only),
    and the files under a nested skill are its own, not its parent's. A
    `SKILL.md` at the root of the tree needs an `id` or a `name` (or
    `options.rootName`).
  - A skill's default `version` is a fingerprint of the skill as read (it
    was `"1"`), so a change to its `SKILL.md` or to a reference it serves
    changes it, and with it tool discovery's skill-selection `candidateHash`
    in decision records.
  - The Agent Skills fields are read: `name` as `id` and `description` as
    `summary` (`id` and `summary` win); the summary is made one line.
    Frontmatter is read as the YAML subset skill files use (`>` and `|`
    blocks, lists, quotes, comments, a byte-order mark, CRLF); keys indented
    under another (`metadata:`) are no longer read as top-level ones.
  - `tools` and `permissions` given as text are split on whitespace as well
    as commas (`permissions: fs write` was one permission, `fs write`; it is
    now two), and `always` is read in any case (`TRUE` is true; it was
    `true` only).
  - It fails with `skills.files` naming every issue at once
    (`<path>: <reason>; ...`), warnings included (an `always` that is not
    `true` or `false`, a frontmatter line that is not `key: value`, a
    reference over `maxReferenceBytes`, a reference whose path is not a
    valid id); it failed on the first bad skill.
  - `SkillFile` is a schema now (a value and a type), from
    `harness/skill-files.entity.ts`; the `harness/skill-files.ts` module is
    gone. Imports from `@xandreed/core` are unchanged.

  Migration: read a reference by its path
  (`read_skill_reference({ skill, reference: "references/formats.md" })`);
  a skill whose recorded decisions should keep the old version sets
  `version: 1` in its frontmatter; a file under a skill's directory that
  should not be a reference moves out of it; a `tools` or `permissions` item
  with a space in it is written as a list (`[fs write]`, or `- fs write`
  lines), since text is split on spaces.
- **`@xandreed/core`: a plugin layer that fails with a `HarnessError` fails
  with that error's code.** `definePlugin`'s `build` (what the plugin graph
  and `Agent.define` activate) turned every layer failure into
  `plugin.activation`, with the error as text in the message. A
  `HarnessError` now keeps its code and message, as it already did through
  the typed `live` layer, and `build` names the plugin when the error names
  none: `Agent.define` fails with `skills.duplicate`, `tools.duplicate` or
  `skills.tools` from tool discovery, for example. The error is told by its
  tag and fields, so one from a second copy of `@xandreed/core` keeps its
  code too. Other failures are still `plugin.activation`. Migration: a
  host that matched `plugin.activation` for these matches their own codes.

- **`@xandreed/core`: `TurnEvent` gains `tool.refused` and `stream.fallback`,
  and `LoopEvent` gains `stream_fallback`.** A call the tool registry
  refuses before its handler runs (an inactive tool, a missing permission,
  an `ActionPolicy` denial, the turn's or the tool's call limit) publishes
  `tool.refused`; it published nothing. A step loop whose streamed call
  fails before its first part publishes `stream.fallback` once per run.
  Both are journaled (`tool.refused` without its input). Migration: an
  exhaustive `Match` over `TurnEvent` or `LoopEvent` handles the new
  members; a reader of a session's journal meets the two new kinds.
- **`@xandreed/core`: every bus event's name is reserved.**
  `RESERVED_KINDS` gains the new journal kinds `tool.refused` and
  `stream.fallback`, and every `TurnEvent` name the journal does not store
  as itself (`assistant.message`, `assistant.delta`, `tool.progress`,
  `skills.activated`, `host`; `TURN_EVENT_NAMES` lists them all): a host
  event under one of them fails with `events.reserved`, a
  `Sessions.transact` draft with `ReservedKind`. The kinds reserved before
  are reserved as they were. `journalSchemaOf` has a schema for every kind
  the framework writes (`JOURNAL_KINDS`), not for every reserved name.
  Migration: rename a host event that used one of these names; code that
  looked up a schema for each of `RESERVED_KINDS` iterates `JOURNAL_KINDS`.
- **`@xandreed/plugin-tool-discovery`: a refused call has an invocation id.**
  The id (`<runId>:call:<n>`) is minted before the refusal checks, so a
  refused call takes the next number and the calls after it count on from
  there: their `invocationId`s differ from before when a turn had refusals.
- **`@xandreed/core`: `StepRequest.captureTraceContent` is required.** A
  hand-built `StepRequest` (a test, a host's own turn) adds it; `stepRequestOf`
  fills it from the policy, the agent and `CurrentTraceContent`. A custom
  `StepLoop` must provide it to its model calls as `CurrentTraceContent`,
  whatever the caller's: `stepLoopConformance` checks it. Migration: wrap
  the loop's model calls in
  `Effect.provideService(CurrentTraceContent, request.captureTraceContent)`.
- **The trace tree changes shape.** `Agent.turn` runs each admitted turn
  under an `agent.turn` span, so `engine.run` is no longer a root (nor a
  child of the caller's span). Contexts the framework captures and replays
  no longer carry the span current at capture: a `tool.<name>` span is a
  child of the model call that made the call (it was a child of the span
  where the turn's tools were opened), a handler's spans are children of
  its `tool.<name>` span, `engine.run` is a child of the span where
  `turn.run` is called, the loop's callbacks and a policy's run under
  `engine.turn` (some ran under `engine.run`), and the models plugin's
  `providers.generate` is a child of the calling span, not of the span its
  layer was built under. An inline bus subscriber's spans are children of
  the publisher's span (they were children of the span where it
  subscribed), and a session chassis turn's of the span where `send` is
  called. Span annotations and links set where a context was captured
  (`Effect.annotateSpans` around a layer's build or the turn's services) no
  longer reach the replayed work's spans, where they replaced the turn's
  ids. A parent span in `TurnInput.services` or `AgentConfig.services` is
  ignored (wrap the `Agent.turn` call in `Effect.withParentSpan` instead),
  and so is a `CurrentTraceContent` in `AgentConfig.services` (set
  `AgentConfig.captureTraceContent`); one in `TurnInput.services` still
  counts as where the turn's runs start. Migration: dashboards or queries
  keyed on root spans or parent names follow the new tree
  (`docs/framework.md`, "Traces and metrics").
- **`@xandreed/plugin-models`: Node now honours `HTTPS_PROXY` and
  `HTTP_PROXY` for model calls.** Node's fetch ignored them (unless
  `NODE_USE_ENV_PROXY` was set), so on Node every model and OAuth call went
  direct; now they go through the proxy those variables (or the new `proxy`
  option) name, except the `noProxy` / `NO_PROXY` hosts and loopback. (On
  Bun, whose fetch applied them already, only `NO_PROXY` exempts a host from
  a proxy in the environment, as before.) With a proxy set, Node calls go
  through undici's own agents rather than the global dispatcher, so a
  dispatcher a host installed with `setGlobalDispatcher` no longer applies
  to them, and on both runtimes a `FetchHttpClient.Fetch` a host provides
  around a turn no longer reaches the provider SDK calls (without a proxy
  nothing changes: the plugin then adds no transport). A proxy variable that
  is not an `http://` or `https://` URL (`socks5://...`) now fails
  `Agent.define`. Migration: to keep calls direct, set the plugin's
  `noProxy: "*"` on Node, which holds under `NODE_USE_ENV_PROXY` too and
  leaves a SOCKS proxy in the environment unread (on Bun, set `NO_PROXY=*`,
  since Bun applies the environment's proxy to fetch itself); to keep a
  custom HTTP stack or fetch, provide it as a `ModelsTransport` through
  `Agent.define({ services })`.
- **`@xandreed/plugin-models`: a proxied OpenAI subscription call fails on
  Bun before 1.3.6.** Bun 1.3.0 to 1.3.5 cannot send a WebSocket through a
  proxy, and the `openai-codex` WebSocket used to connect directly whatever
  the proxy setting; when a proxy applies to `chatgpt.com` it now fails with
  an `AuthError` (not retried, no fallback). Migration: run on Node or Bun
  1.3.6 or newer, or exempt `chatgpt.com` with `NO_PROXY`.
- **`@xandreed/plugin-models` requires Node 24.5 or newer** (`engines.node`
  `>=24.5`, was `>=24`): Node honours the `proxyEnv` option of `https.Agent`,
  which the subscription's WebSocket tunnels through, from 24.5. On older Node
  a proxied WebSocket fails with an `AuthError` rather than connecting
  directly.
- **`@xandreed/plugin-models` depends on `undici`** (`^7.30.1`), imported
  only on Node when a proxy applies; Bun never loads it.
- **`@xandreed/plugin-models`: the plugin has two more options and one more
  optional service.** `proxy` and `noProxy` join its options (the plugin
  reference and graph fingerprints change), and `ModelsTransport` its
  `optional` services: a host that provides one through
  `Agent.define({ services })` and also sets `proxy` or `noProxy` is
  refused. `LocalAuthStoreLive` is built with `Layer.effect` (it reads the
  optional `ModelsTransport` once), and the `fetch` of
  `TokenRequestOptions` and `MemoryAuthOptions` and the compat client's
  `fetchImpl` take a `ModelsFetch` (any `fetch` is one).

- **`@xandreed/plugin-sessions`: the default lease renews itself.**
  `sessionsDefaults.ownership` is `{ mode: "lease", ttlMs: 60_000, renew:
  { everyMs: 20_000 } }` (it renewed `"on-commit"`): while a turn's writer
  is open, a state-only commit extends its lease every 20 s, the first one
  20 s after the begin. A silent step longer than the lease (a slow model
  call, a long tool) no longer loses its turn; a renewal is queued in order
  with the turn's writes, so it waits for a `write` or `transact` still
  running, and those must stay shorter than the lease. Each renewal is a commit: it
  bumps the head's `updatedAt` (and so a session's place in `list`), costs
  a write on SQLite, and keeps a hung turn held while its process runs
  (`Sessions.cancel` still closes it). Tests that advance a `TestClock`
  past a lease with a writer left open, or that assert exact commit
  sequences or `updatedAt` over minutes, see the renewals. To keep the old
  behaviour, pass `ownership: { mode: "lease", ttlMs: 60_000, renew:
  "on-commit" }`.
- **`@xandreed/plugin-sessions`: the keep-alive's first renewal comes one
  interval after the begin.** With `renew: { everyMs }`, a renewal commit
  followed the begin at once; now the first one comes `everyMs` later (the
  begin's own commit set the lease), so a turn shorter than `everyMs`
  costs no extra commit. A host that already configured `{ everyMs }` sees
  one commit fewer per turn; a test that counted commits or revisions right
  after a begin, or waited for that first renewal, advances its clock by
  `everyMs` first.
- **`@xandreed/plugin-sessions`: a keep-alive slower than half the lease is
  refused.** `renew: { everyMs }` with `everyMs * 2 > ttlMs` fails the
  plugin's options with `config.options`, and so does `SessionsLive(config)`
  when its layer is built (it decodes `config.ownership`): such a renewal
  could land after the lease ran out. Lower `everyMs` or raise `ttlMs`.
- **`@xandreed/plugin-sessions`, `@xandreed/plugin-tasks`: wider layers.**
  `SessionsLive` and `SessionsPluginLive` provide `Sessions | TurnActivity`
  and fail with `HarnessError` (`SessionsLive` was `Layer<Sessions, never,
  …>`); `sessionsPlugin.provides` is `[Sessions, TurnActivity]`, so a graph
  with another plugin providing `TurnActivity` needs a binding.
  `InProcessTaskRunnerLive` provides `TaskRunner | TaskActivity`. Code that
  annotates these layers' types widens the annotation; built contexts carry
  one more service each.
- **`@xandreed/sdk`: `Agent` has an `activity` member.** A hand-written
  `Agent` value (a test fake) adds it, for example `activity:
  processActivity`.

- **`@xandreed/plugin-telemetry` is a new plugin under the old id.** The
  package and its plugin id, `@xandreed/plugin-telemetry`, belonged to a
  plugin shipped before 0.11.0 (`{ enabled, serviceName }`, exporting
  through the OpenTelemetry Node SDK). The new `telemetryPlugin` takes
  `{ prices, metricAttributes, spanEvents }` and refuses the old options
  with `config.options`. The earlier package's other exports are removed
  too: `TracingLive`, `FileLoggerLive`, `FileLoggerAddLive`, the default
  export, and the `TurnHooks` its plugin provided. Migration: drop the
  plugin's options and import it by name (`telemetryPlugin`);
  `TracingLive(serviceName)` becomes `OtlpTelemetryLive({ baseUrl,
  serviceName })` around the program, or `OtlpTelemetryFromEnv({
  serviceName })` for the `OTEL_EXPORTER_OTLP_*` endpoint it read (with
  `baseUrl: "http://localhost:4318"` in the defaults for its fallback); a
  file log is Effect's own `Logger.toFile`. npm's `@xandreed/plugin-telemetry`
  0.3.0 and 0.4.0 are that earlier plugin.

### Added

- `@xandreed/core`: every `TurnEvent` member carries a `description`
  annotation saying who publishes it, when, what its payload means and
  whether it is transient or stored.
- `@xandreed/core`: schemas for the journal kinds that had none —
  `InboxQueuedData`, `InboxDroppedData`, `StepUsageData` and
  `StoredMemoryData(body)` (the `{ entry, runId, step, at, body }` envelope of
  `memory.*` and `turn.reply`). `journalSchemaOf(kind)` gives the schema of
  any reserved kind's `data`, and none for a host's or plugin's own kinds.
  `RECORDED_ELSEWHERE` exports the bus events that memory or the session
  stores instead of the bus (`turn.started`, `turn.ended`,
  `skills.activated`). `@xandreed/plugin-sessions` writes `inbox.queued` and
  `inbox.dropped` through the schemas; what is stored is unchanged.
- `@xandreed/sdk`: `turnBeginCodes`, the `HarnessError` code `Agent.turn`
  fails with for each reason `Sessions.begin` refuses a turn.
- The event reference: `docs/event-reference.md`, its website page and
  `docs/event-reference.json` list every bus event (description, payload,
  how it is stored), every journal kind (writer, sensitive content, fields),
  the exact reserved kinds, the begin codes with suggested HTTP statuses,
  common turn error codes (every one raised under `turn.`, `events.`,
  `request.`, `loop.` and `tools.`), the `@xandreed/plugin-render` feed and
  socket frames, and the task records with their failure codes.
  `bun run docs:generate` writes it and fails when its hand-kept parts no
  longer match the code.
- `@xandreed/plugin-session-sqlite` exports `makeSessionLogSqlite(path)`, the
  scoped log `SessionLogSqliteLive` builds.
- `@xandreed/core`: `sessionLogRecoveryConformance(subject)` and
  `SessionLogSubject` (`open`, a new handle on the same data each time, and
  `callerClock`), a conformance kit for what a `SessionLog` must keep across
  handles, reopening and interruption: reopening, reopening twice, two open
  handles, racing compare-and-swap through two handles, interrupted commits,
  a handle whose scope never closed, and, with `callerClock`, the exact
  `notAfter` boundary. It runs over the memory log (Bun and Node) and the
  SQLite log, and the SQLite package adds subprocess tests: processes opening
  one new file at once, a commit waiting behind another process's lock,
  SIGKILL in the middle of commits, two processes making 200 compare-and-swap
  increments each, and turns reaped after their holder is killed under
  process and lease ownership. A new docs page, "Conformance kits", lists
  core's kits and `@xandreed/plugin-render`'s, and how to run them against
  your own adapter.
- `@xandreed/core`: conformance kits for the ports that had none with an
  adapter in the repository, each with self-tests that careless backends
  fail. `sessionsConformance(subject)` (`SessionsSubject`: `leased` and,
  optionally, `processOwned` instances over one store, and `advance` to move
  its clock; `SessionsInstance`, whose `activity` is optional, and
  `SessionsProcess`) checks a `Sessions` backend: create, get, list and
  fork; one open turn per session on every instance and one winner of a
  race; key retries and `KeyConflict` (`meta` not in the fingerprint);
  `meta` stored and admitted; every `NotResumable` reason;
  `AttachmentRejected` and `NothingPending` opening nothing; the writer's
  order and endings; `transact`; cancel and removal; the inbox (an item
  given back when its turn is interrupted, done when it is cancelled); a
  write renewing a lease; a turn whose lease ran out (left alone by a drain
  with nothing to take) and one whose process stopped reaped by the next
  begin; and, for an instance with one, `TurnActivity` counting each begin
  from the moment it is asked for and each turn per session and turn until
  its scope closes. `taskRunnerConformance(make, { interruptsOnClose? })`
  (`TaskRunnerFixture`) checks the hand-over, work outliving its caller, the
  deadline, work running without the caller's services, `TaskActivity` from
  the hand-over and the scope's close. `tasksConformance(make)`
  (`TasksDependencies`, `TasksFixture`) checks a task as one child turn
  delivered to the parent's inbox once, starting once, the result after the
  parent's turn, a fork's history, failure, cancel, depth, and `reconcile`
  starting a task that never ran and delivering a result the parent's full
  inbox refused, over the kit's own runner and executor.
  `toolRegistryConformance(make)` (`ToolRegistryLimits`) checks the catalog,
  activation, invocation ids minted before the checks,
  `CurrentToolInvocation` and the opener's services in handlers, events
  published on the run's bus only (never written to the journal by the
  registry), `PermissionGrants`, and a `tool.refused` for each reason. They
  run over `SessionsLive` (in-memory log and SQLite, under a `TestClock`),
  `InProcessTaskRunnerLive` (with and without `maxMs`), `TasksLive` and the
  tool discovery plugin's registry. The `TaskRunner` port's description
  says what the kit checks (no change to its type). The conformance page
  describes the four kits.
- `@xandreed/core`: the `FileSystem` port's new calls (`readBytes` ranges,
  `append`, `rename`, `stat` with `FileInfo` and `followSymlinks`, `glob`
  with `cwd`, `exclude`, `dot`, `onlyFiles` and `limit`), `walkGlob` (the
  sorted, link-safe walk over `list` every backend uses for `glob`, as
  `fs.glob` differs between Bun and Node), `compileGlob` and `globMatcher`
  (`*`, `**`, `?`, `[...]`, `{a,b}`; each returns a `Result` and refuses a
  pattern whose braces stand for more than 1024 patterns, which `glob`
  reports as `Invalid`), `GlobOptions`, `FileSystemMemoryLive` and
  `makeMemoryFileSystem(seed)` (an in-memory tree with symbolic links), and
  `fileSystemConformance(subject)`, run over the memory backend on Bun and
  Node. The disk-backed `FileSystemLive` is in `@xandreed/plugin-workspace`
  (below).
- `@xandreed/core`: the `Bash` port (`stream`, `exec`) with `BashOptions`
  (`cwd`, `env`, `inheritEnv`, `stdin` as text or bytes, `timeoutMs`), `BashChunk`,
  `BashExit`, `BashResult`, `BashError`, `collectBashResult`,
  `resolveBashEnv` and `BASH_ENV_ALLOWLIST`, and `bashConformance(subject)`:
  exit codes as results, separate streams, output before exit, stdin, the
  environment allowlist, timeouts and interrupts that kill the process
  group, `cwd`, signals and UTF-8. Core has no `Bash` adapter (its tests
  run the kit against fakes that run nothing, which fail every check);
  `BashLive` is in `@xandreed/plugin-workspace` (below). `exec` keeps the
  whole output; there is no output cap yet.
- `@xandreed/core`: `tool.progress` (`ToolProgressEvent`: `step`,
  `invocationId`, `tool`, `channel` and `text`), published from a handler
  with `publishToolProgress(channel, text)`: `stdout` or `stderr` for a
  command's output as it arrives, `status` for anything else a tool
  reports. Also
  `CurrentToolInvocation`, which `@xandreed/plugin-tool-discovery` now sets
  around every handler call (innermost, so a nested agent's tools see their
  own call).
- `@xandreed/plugin-workspace`, a new package for Node 24 and Bun on POSIX
  systems (Linux and macOS; not Windows): the local machine as the
  `FileSystem` and `Bash` ports. `FileSystemLive` (`localFileSystem`) is the
  disk through `node:fs/promises`: absolute paths only, error codes mapped
  to `FsReason`s by `fsReasonOf`, `glob` as `walkGlob` over its `list`,
  ranges read through a file handle until they are full (so a `/proc` entry
  that reports a size of 0 reads too), a `rename` that names the side a
  failure came from, and a `remove` that resolves the parent first and acts
  on the last name only, so it never follows that name, never removes the
  root and refuses a path ending in `.` or `..`. `BashLive(options)`
  (`makeBash`, options `BashLiveOptions`) runs `<shell> -c <command>`
  through `node:child_process`, detached into its own process group:
  `shell` (default `bash`, with no fallback; set `sh` where bash is
  missing) is resolved once from the parent `PATH` (`ShellMissing`
  otherwise), `cwd` is checked first (`CwdMissing`), stdin is written and
  closed (a command that never reads it is fine), output is decoded per
  stream, and a timeout, an interrupted stream and, with `killBackground`
  (default `true`), the command's return kill the whole group; `exitGraceMs`
  (default 500) bounds the wait for output a background process holds open,
  after which the output pipes close (so a background process kept with
  `killBackground: false` needs its own output, `cmd > log 2>&1 &`), and
  `parentEnv` (default `process.env`) is what commands inherit from.
  `localSystemPlugin` (`@xandreed/plugin-workspace/local`, runtime-scoped)
  provides both, configured with `shell`, `killBackground` and
  `exitGraceMs` (`LocalSystemConfig`, `localSystemDefaults`), and
  `LocalSystemPluginLive` is its typed layer. Both adapters pass
  `fileSystemConformance` and `bashConformance` on Bun and, in the
  packed-package check, on Node. The `FileSystem` kit gains a
  `remove-paths` check (a trailing slash on a link, a linked parent, a last
  `.` or `..`) and checks which path a `rename` failure names;
  `FileSystemMemoryLive` refuses a `remove` ending in `.` or `..` too.
- `@xandreed/plugin-workspace`: the workspace tools. `workspaceToolsPlugin`
  (`@xandreed/plugin-workspace/tools`, runtime-scoped; `workspaceTools(config)`
  builds the same capability, `WorkspaceToolsPluginLive` is its typed layer)
  gives the model `read`, `ls`, `find` and `grep` (skill `workspace.read`,
  always on), `write` and `edit` (`workspace.edit`, needing the grant
  `fs.write`) and `bash` (`workspace.shell`, needing `shell.exec`;
  `WORKSPACE_PERMISSIONS`) over the `FileSystem`, `Bash` and
  `SessionEnvironment` of each call, plus a `workspace.environment` prompt
  section. Without the grants, `load_skill` refuses the skills with
  `capability.forbidden` and the tools stay inactive; without a `Bash`
  service there is no `bash` tool. Failures are `Failure` data. `read` shows
  windows of at most 2000 lines or 50 KB with the offset to continue from,
  and reports binary files (a NUL byte in the first 8 KB) with the media type
  their name suggests (images aside: see `readImages` below), and a file
  that is not valid UTF-8 with U+FFFD and a notice (`lossy`); `ls`, `find`
  (globs through `walkGlob`) and `grep`
  (regular expressions or literal text, case, context, lines cut to 500
  characters before matching, a quarter of the limit per file; a pattern
  that repeats a repeating group, such as `(a+)+`, is refused as
  exponential) are capped; `edit` applies several exact, unique,
  non-overlapping replacements matched against the original, with a
  normalised fallback (`fuzzyEdit`), keeps a BOM and CRLF endings, refuses
  a file that is not valid UTF-8 (`NotUtf8`) and returns a unified diff
  (effect's `TextDiff`); `write` refuses to empty a file; both write through
  a temporary file and a rename (in place for a file whose mode the rename
  would change: execute or special bits, or a mode the temporary file did
  not get under the umask) under a per-file lock shared by every session of
  the agent; `read`, `write`, `edit` and `grep` refuse pipes, sockets and
  devices (`NotAFile`). `bash` runs in the
  workspace root with a timeout the model may raise up to
  `bashMaxTimeoutMs`, stdin, the host's `bashEnv` over an allowlist of its
  variables (`bashEnvAllow`; `bashInheritEnv` passes everything;
  `bashSessionEnv` adds the session's ids), publishes output live as
  `tool.progress` (one event per run of output from one stream every
  `progressMs`), keeps its tail and saves a long output under
  `.efferent/runtime/tool-output`, up to `maxFileBytes` (`fullOutputCut`
  past that; the newest `spillKeep` files are kept).
  Paths are confined to the workspace through the real path of the nearest
  existing ancestor, `protect` globs (`.git/**`, `.efferent/**`) refuse
  writes, and `find` and `grep` never enter links or `exclude` names (an
  entry with a `/` is a path from the root): a guardrail, not a sandbox.
  The configuration (`WorkspaceToolsConfig`, `workspaceToolsDefaults`) is
  flat; its `protect` and `exclude` globs are checked when the options are
  decoded. Also exported: the tools' parameter and
  result schemas (`workspaceToolSchemas` for `onTool`), `applyTextEdits`
  and `normalizeLine`. A new docs page, "Workspace tools", and a
  packed-package journey on Bun and Node.

- `@xandreed/core`: token usage counts cache writes and reasoning.
  `TokenUsage` gains `cacheWriteTokens` and `reasoningTokens` (both inside
  the input and output totals). New `tokenUsage(counts)` (a usage with the
  invariants held), `uncachedInputTokens`, `usageBreakdown` (the five billed
  kinds, which sum to `totalTokens`), `sumUsage`, `ModelPrice` and
  `costOf(usage, price)`. `extractUsage` reads `cacheWrite` and `reasoning`
  from effect/ai's usage.
- `@xandreed/core`, `@xandreed/sdk`: turn and run totals.
  `RunResult.usage` (one run of the step loop), `RunContext.usage` and
  `Turn.usage` (the turn's running total), `TurnResult` (`TurnOutcome` plus
  `usage`, returned by `Agent.turn` and `guardTurn`), `usage` on the bus
  `turn.ended` event, and `turnUsageOf(events, turn)`, which sums a turn's
  stored `step.usage` records to the same total. `stepLoopConformance` and
  `turnConformance` check both totals.
- `@xandreed/plugin-models`: the chat-completions client reads
  `prompt_tokens_details.cache_write_tokens` and
  `completion_tokens_details.reasoning_tokens`. The built-in `google`
  provider reads no reasoning (0), since Gemini's `completion_tokens` may
  leave its thoughts out; configured endpoints and `local` credentials read
  it. The router adds the counters `llm.usage.cache_read_tokens`,
  `llm.usage.cache_write_tokens` and `llm.usage.reasoning_tokens`, and the
  same span attributes on `providers.generate`.
- `@xandreed/plugin-agent-loop`: each step's `engine.turn` span carries the
  OpenTelemetry GenAI usage attributes `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
  `gen_ai.usage.cache_creation.input_tokens` and
  `gen_ai.usage.reasoning.output_tokens`. The `engine.run` span carries the
  run's sums as `engine.usage.input_tokens`, `engine.usage.output_tokens`,
  `engine.usage.cache_read_tokens`, `engine.usage.cache_write_tokens` and
  `engine.usage.reasoning_tokens`, beside `engine.usage.total_tokens`, so a
  backend summing `gen_ai.usage.*` does not count a step twice.
- Docs: `docs/framework.md` "Token usage" (the invariants, where totals
  appear, what they leave out, the span attributes, what each provider
  reports) and the same table on the website's providers page; the
  conformance page lists the usage checks.
- `@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`: the
  host's metadata on each turn. `meta` (a JSON object: a request id, a
  client, a tenant) on `BeginTurn.User`, `BeginTurn.Inbox` and `NewTurn`
  (`Agent.turn`'s `turn` input), and `Sessions.drain(address, run, {
  maxTurns, meta })` for inbox turns. It is stored in `turn.started` when
  given (`TurnStartedData.meta`), given to `TurnAdmission` (`TurnToAdmit.meta`),
  and shown on `AdmittedTurn.meta`, `RunContext.admitted`, `Turn.admitted`
  and the bus `turn.started` event. It is never shown to the model, and is
  not part of the idempotency key's fingerprint: a retry with other
  metadata is still `TurnDuplicate`.
- `@xandreed/core`: `turnEndingOf(exit)`, the `TurnEnding` a turn's exit
  stores: its outcome on success; failed with the error's own `code` and
  message (cut to 500 characters), `turn.failed` or `turn.defect`; or
  interrupted with `turn.interrupted`. An error wins over an interruption.
  `Agent.turn` and `Sessions.drain` end their turns with it; a host-composed
  runner ends its writer with `writer.end(turnEndingOf(exit))`. On success a
  failed end still fails the turn.
- `@xandreed/core`: `BudgetTokens` (an integer of at least 1) and
  `isBudgetTokens`; `context.built` records the run's `budgetTokens`. The
  doc comments of `TurnPolicy.budgetTokens`, `TurnRunOptions.budgetTokens`,
  `AgentConfig.budgetTokens` and `MaintainSignal.budgetTokens` say what the
  budget is (the target memory compaction keeps each request under, not a
  provider limit) and what each memory strategy does with it.
- `@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`: resuming
  a cancelled or interrupted turn. A user's turn begun with `resumes: n`
  (`BeginTurn.User.resumes`, `NewTurn.resumes` for `Agent.turn`) continues
  turn `n`, which must be the session's last turn begun by a user (only
  inbox turns, and resumes of it that failed, were cancelled or were
  interrupted, may follow it) and must have ended cancelled or interrupted,
  a reaped turn included; otherwise the begin fails with `NotResumable`
  (`session`, `turn`, `reason`: `missing`, `inbox`, `superseded`,
  `finished`) and `Agent.turn` with `turn.not-resumable` (409 in the event
  reference). The check runs in the opening commit, after the key's and
  after `SessionBusy`; a `resumes` that is not a whole number of at least 1
  is `missing` before anything else, the host's admission included. Memory
  is unchanged: the model sees turn `n`'s message and whole steps, then the
  new turn's message, exactly what a plain new turn would see. `resumes` is stored
  in `turn.started` (`TurnStartedData.resumes`, only when given) and shown
  on `AdmittedTurn.resumes` (`RunContext.admitted`, `Turn.admitted`),
  `TurnToAdmit.resumes` and the bus `turn.started`, and is part of the key's
  fingerprint. `Agent.turn` keys a resume `resume:<n>` unless given a key,
  so a retried resume is `turn.duplicate`; a resume that failed is tried
  again with a new key, and a host passing its own keys needs a new one for
  each attempt. `resumeRefusal(n, turns)` and `ResumableTurn` are the rule
  as a function.
- Docs: `docs/framework.md` "Resuming a turn" (the rule, the keys, and what
  is durable after a cancel or an interrupt: the turn's start, its whole
  steps, of the step in flight only what was already stored (its tool
  events included, never its assistant message or tool results), its end;
  no reply after a cancel, and possibly a failed reply with no text after an
  interrupt) and the website's SDK and sessions page; the event reference
  lists `turn.started.resumes` and the `NotResumable` begin code, and its
  `TurnDuplicate` and `KeyConflict` meanings name `resumes` as part of the
  key's fingerprint.
- Docs: `docs/framework.md` (the host's metadata, how a turn ends and its
  stored codes, the token budget) and the website's SDK and sessions page;
  the event reference lists `turn.started.meta`, `context.built.budgetTokens`
  and the stored codes `turn.failed`, `turn.defect`, `turn.interrupted`,
  `turn.budget`, `config.budget` and `context.budget`.
- `@xandreed/plugin-models`: disk-free stores. `modelsPlugin` takes
  `storage: "local" | "memory"` (default `"local"`, today's files). With
  `"memory"` it reads and writes no file and never looks up the home
  directory: credentials come from the host's `HostCredentials`, then the API
  keys of the environment variables `credentialEnv` names, then
  `credentials` (secrets as `Redacted` values; a plain string, or a field a
  credential does not have, is refused and never repeated in the error;
  `Redacted` values print as `<redacted>` in errors and fingerprints);
  settings start at the options and `setRole` and `set` change them in
  memory; `inheritPrevious` is ignored. Memory state belongs to the agent and
  is shared by all its sessions. `credentials`
  and `credentialEnv` need `storage: "memory"`, as does a host's
  `HostCredentials`.
- `@xandreed/plugin-models`: `HostCredentials` (`load`, read when the agent
  is defined; `save`, called after every login, logout and in-memory
  refresh, with `Redacted` secrets), `MemoryAuthStoreLive(seed?, { fetch? })`
  (one refresh per provider at a time; a login or logout during a refresh's
  token request wins, so a logout is never undone by a refresh and the host
  never receives that token; one during the refreshed token's commit and
  host save waits for it), `MemorySettingsStoreLive(initial)`, `CredentialInput`,
  `CredentialInputs`, `toCredential`, `toCredentialInput`, `credentialsOf`.
- `@xandreed/plugin-models`: the shared store vocabulary, extracted from the
  file stores: `applySetting`, `applyRole`, `coerceSettingValue`,
  `roleSelection`, `settingsFromRecord`, `ROLE_FIELDS`
  (`settings/settings-value.entity.functions.ts`) and `REFRESH_SKEW_MS`,
  `isUsableAt`, `refreshCredential` (`auth/credential-refresh.entity.functions.ts`).
  `refreshAnthropicToken`, `exchangeAnthropicCode`, `refreshOpenAiCodexToken`
  and `exchangeOpenAiCodexCode` take optional `{ fetch, now }`; the expiry of
  a new token is counted from the Effect `Clock` unless `now` is given.
- `@xandreed/plugin-models`: an endpoint with its own key (`apiKey`, or a set
  `apiKeyEnv`) never reads the `AuthStore`; an empty one sends no key, as
  before. `apiKey` may be `Redacted`. `endpointOwnKey` is exported.
- `@xandreed/core`: `authStoreConformance(store)`,
  `settingsStoreConformance(store, { writable })` and
  `modelCatalogConformance(catalog, { includes? })`, each with self-tests
  that careless stores fail. The SettingsStore kit puts back every key it
  touches, and fails a check before writing when a key holds a value the
  store must refuse, so it could not be put back. They run against `MemoryAuthStoreLive`,
  `LocalAuthStoreLive`, `MemorySettingsStoreLive`, `LocalSettingsStoreLive`,
  the plugin's read-only local settings and `ConfiguredModelCatalogLive`, on
  Bun and on Node.
- Docs: the website's providers page, "Credentials and storage" (both
  storages, `Redacted` secrets, `credentialEnv`, a `HostCredentials`
  example, refresh, lifetime and precedence); the conformance page lists the
  three kits; the plugin reference shows each plugin's optional services.

- `@xandreed/core`: images. `Media` (an image inline: base64, media type,
  size, fingerprint, optional name and alt), `MediaSlot`, `ImageMediaType`,
  `MediaFingerprint`, `AttachmentRejected`, `AttachmentRejectedReason` and
  `MEDIA_LIMITS`, and the types `ImageSize` and `MediaDescription`;
  `mediaFromBytes` and `mediaFromBase64` (a `data:` prefix and line breaks
  removed; the type sniffed from the bytes; PNG, JPEG, GIF and WebP headers
  read for a size of at most 8000 pixels a side), `normalizeMedia`,
  `sniffImageType`, `imageSizeOf`, `mediaFingerprintOf`, `mediaLabel`,
  `isMediaValue`, `mediaSlotsOf`, `mediaAt`, `elideMediaData`,
  `base64Length` and `IMAGE_TOKEN_ESTIMATE`.
- `@xandreed/core`: `UserMessage.attachments`, with `attachmentsOf`,
  `normalizeUserMessage`, `sameUserMessage` and `userMessageText`. A user's
  images are stored inline in `turn.started` (the event reference lists
  `turn.started.userMessage.attachments`) and sent to the model as effect/ai
  `file` parts (an empty text part is left out): image blocks on Anthropic,
  `input_image` on the Responses routes, `image_url` parts on a
  chat-completions route that reads images (below); a route that does not
  sends the text and a label line per image, so a message of images alone is
  never empty. The
  current turn's images are sent first, within `maxImages` and the new
  `maxChars` (with the defaults a message's own images always fit;
  `maxMediaChars: 0` sends none, for models that read text only); memory's
  `media: "inline"` sends earlier turns' too, newest turn first and a whole
  turn at a time (the default, below), and `none` shows them as label lines.
  A request sends at most `MEDIA_LIMITS.requestImages` images. Token
  estimates count an image as 1 600 tokens; context fingerprints,
  `queryLog`, transcripts, digests, ledgers and the loop's captured trace
  content never carry an image's base64.
- `@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `maxMediaChars` (default and largest `MEDIA_LIMITS.requestChars`), the
  base64 characters of the images one request sends; `maxImages` defaults
  to `MEDIA_LIMITS.requestImages`.
- `@xandreed/sdk`: `Agent.turn` checks a new turn's attachments before it
  begins, whatever `Sessions` the turn's services hold, and fails with
  `turn.attachment-rejected`; the event reference suggests 400 for it (a
  host that wants 413 for an oversized image runs `normalizeUserMessage`
  first and reads `AttachmentRejected.reason`).
- Docs: `docs/framework.md` "Images and multi-part messages", the website's
  SDK and sessions page, a provider table of the routes that take images,
  and the new kit checks on the conformance page.
- `@xandreed/core`: images in tool results. A tool returns `Media` values
  in its success value; its view's new `media` selector
  (`ToolViewInput.media`, filled by `defineTool`) picks the ones the model is
  sent with the result, every one by default (`Tool.toModelOutput` is not
  used). `ToolView.media` carries them as `MediaSlot`s into the encoded
  result, and the memory log's `ToolResult` stores them as `media`, only
  when there are some, so each image is stored once, in the result.
  `toolResultMedia` (with `ToolResultMedia`) checks them when the result is
  written: an image whose data is not what it states is an `[image
  unavailable: …]` line in the stored view, one past
  `MEDIA_LIMITS.toolResultImages` (4) or `requestChars` its label line (both
  kept as the result's `mediaNotes` too), and a failed call sends none.
  `renderLog` sends the current turn's tool images after its attachments,
  newest result first and a whole result at a time, and earlier turns' (in
  `inline` mode) with their turn's attachments; a result shown through a
  compaction, a digest or a spill's preview shows its `mediaNotes`, then its
  images as label lines.
  `ToolResultPart.media` holds a rendered result's images, and
  `toPromptMessages` turns them into the result's effect/ai `modelOutput`
  (its text, left out when empty, then a `file` part per image): an image
  block inside Anthropic's `tool_result`, `input_image` inside the Responses
  routes' `function_call_output`.
- `@xandreed/core`, `@xandreed/plugin-agent-loop`: recovery from a refused
  image. `CompactionAction.OmitMedia { entries, reason }` shows the named
  entries' images as label lines, whatever strategy renders the log;
  `entriesSendingMedia(entries, options)` names the entries whose images a
  render sends. When a request fails with an `InvalidRequestError` that
  names an image, the loop calls `StepRequest.onMediaRejected(reason)`
  (`RunLoopOptions.onMediaRejected` for `runLoop`): `stepRequestOf` records
  an `OmitMedia` of the images that request sent, and the step is planned
  again (that plan keeps its model choice, system prompt and directive) and
  sent once more. A streamed step does not fall back to a settled call over
  such a refusal, and one that arrives after the first part is not sent
  again. The loop counts the retry as
  `engine.corrections{engine.kind="media-rejected"}`.
- `@xandreed/plugin-models`: images per route. `ModelEndpoint.images`
  (default false) says a configured endpoint's models read images;
  `imageInputFor(selection)` says it for the built-in routes (Anthropic, the
  Responses routes but `openai-codex:gpt-5.3-codex-spark`, Gemini; not
  OpenCode's chat models); `ModelCatalogEntry.input` (`@xandreed/core`)
  states it per catalog model, for the route the model is sent through
  (`configuredModelCatalog(credentials, endpoints)`: a configured endpoint of
  a built-in provider's name by its `images`, a `local` credential's URL as
  text only). On `openai-codex`, an `error` event that refuses the request
  before any other event fails it with a 400 and the OpenAI error body
  (`openAiCodexRefusal`), as the HTTP endpoint does, so a refused image is an
  `InvalidRequestError` there and not a malformed response. On a route that
  reads none, `buildProvider` sends every image as its label line
  (`promptWithImageLabels`, exported from `@xandreed/plugin-models/compat`;
  `BuiltProvider.images` says which).
  The chat-completions client (`CompatConfig.images`,
  `toChatMessages(prompt, { images })`, `ChatMessageOptions`) sends a user's
  images as `image_url` parts with `data:` URLs, and a tool result's in one
  user message after the batch's tool messages, each result's captioned
  `Images returned by <tool> (call <id>):`, merged with a user message that
  follows (captioned `The user's message:` when it has images of its own);
  without `images`, a tool result's images are label lines in its text.
- Docs: `docs/framework.md` "Images and multi-part messages" covers tool
  results, the per-route table for both kinds of image, the refused-image
  recovery and the limits; the website's providers page ("Images", with an
  endpoint's `images`), SDK page and conformance page; the roadmap (MCP
  images, resizing, PDFs, a `MediaStore`). `verify:packages` sends a tool's
  image through `toChatMessages` and `promptWithImageLabels` on Node.
- `@xandreed/plugin-workspace`: `read` returns images. With the new
  `readImages` option (`WorkspaceToolsConfig`, default `true`), a binary
  file whose bytes are a PNG, JPEG, GIF or WebP image (sniffed by core's
  `sniffImageType`, whatever its name, and built with `mediaFromBytes`) is
  `ReadResult`'s new `Image { path, image: Media }`, the image named by its
  path; the tool's view selects it, so the model is sent it as an image of
  the result (`[Image chart.png (image/png, 70 B).]` as its text) and the
  session stores it once, through its slot. An image over
  `MEDIA_LIMITS.imageBytes` or `maxPixels` a side, or one whose header gives
  no size, is the new `ImageRejected { path, mediaType, bytes, reason,
  message }` instead: a note with why (and, for a size, to read a smaller
  copy), never its bytes. A file over `maxFileBytes` is still refused
  unread (`FileTooLarge`); when its name is one of those images, the
  refusal says to read a smaller copy instead of using `grep`. Other binary
  files stay `Binary`, and so do images with `readImages: false`, which a
  host whose models read text only sets. With `readImages`, the `read`
  description tells the model it can look at images, up to the smaller of
  `MEDIA_LIMITS.imageBytes` and `maxFileBytes`. Unit tests (PNG, JPEG, GIF,
  WebP, a type from the bytes and not the name, oversized bytes and pixels,
  a corrupt header, `readImages: false`, the description's limit), the tool
  through the registry's views (a GIF and a WebP on disk among them, and an
  image over `maxFileBytes`), and a key-free journey in which a scripted
  model reads an image and the next request carries it, the log holding its
  base64 once; the packed journey in `verify:packages` reads an image on Bun
  and Node and checks that the next request sends it as a `file` part of
  the tool result's `modelOutput`. Docs: `docs/framework.md` "Workspace
  tools" and "Images and multi-part messages", the website's workspace page,
  the README. Not a break: `ReadResult` gains two members, but
  `@xandreed/plugin-workspace` has not been published yet.
- `@xandreed/core`: skills from a tree of files.
  `readSkillFiles(files, { tools, maxReferenceBytes, rootName })` returns a
  `SkillTree`: every skill that loaded, with the directory of its
  `SKILL.md`, and the issues met (`SkillFileIssue`: an `error` leaves a
  skill out, a `warning` part of one). It never fails. The id rule:
  frontmatter `id`, else `name`, else the directory's path below the root
  (`release/checklist`), else, for a `SKILL.md` at the root, `rootName`.
  `tools: "ignore"` drops the tools a `SKILL.md` declares. A reference
  whose path is not a valid id is left out with a warning, not the skill.
  `collectSkillFiles(root, { maxFiles, maxBytes, maxFileBytes })` reads the
  text files under a directory through the `FileSystem` port's `glob`
  (links not entered; dot entries, `node_modules` and binary files left
  out), failing with `skills.limit` past `maxFiles` or `maxBytes`; a file
  other than a `SKILL.md` over `maxFileBytes` is not read, and is collected
  with its `size` (`SkillFile.size`) for `readSkillFiles` to warn about.
  Binary files and unread ones do not count toward `maxBytes`. Also
  exported: the schemas `SkillFile`, `SkillFileIssue`, `SkillTree`, `SkillTreeEntry`,
  `SkillFilesOptions`, `CollectSkillFilesOptions`, and `skillIssuesText`.
- `@xandreed/plugin-workspace`: `skillsDirectoryPlugin` (plugin id
  `@xandreed/plugin-workspace/skills`, runtime-scoped, requires
  `FileSystem`, contributes `Capabilities`) loads directories of `SKILL.md`
  files, `.agents/skills` in the agent's workspace by default, once per
  `Agent.define`. Tool discovery lists them in its catalogue, `load_skill`
  returns a skill's instructions and `read_skill_reference` the other files
  of its directory; the instructions of skills marked `always` are rendered
  in a static section (`alwaysSection`, `sectionOrder`). Flat options:
  `roots` (absolute, or relative to the workspace), `required`, `strict`,
  `tools` (`"ignore"` by default: file skills activate no tools),
  `idPrefix`, `maxReferenceBytes`, `maxSkills`, `maxFiles`, `maxBytes`. The
  first root wins an id two roots define; one instance with several `roots`
  is how to read several directories (the capability and section ids are
  fixed). A file over `maxReferenceBytes` is not read and does not count
  toward `maxBytes`. A skill id the host or another plugin also defines
  fails `Agent.define` with `skills.duplicate` (set
  `idPrefix`); a missing `required` root fails with `skills.root`, a limit
  with `skills.limit`, any issue under `strict` with `skills.files` (without
  `strict`, issues are logged and what they name is left out). Also
  `SkillsDirectoryPluginLive`, `SkillsDirectoryConfig`,
  `skillsDirectoryDefaults`, and, for a host that composes capabilities
  itself, `loadSkillsDirectory(config, workspace)` (the skills) and
  `skillsCapability(skills, config)` (them as one capability, with the
  always-on section), whose ids are `SKILLS_CAPABILITY_ID` and
  `ALWAYS_SECTION_ID`.
- Docs: skills from a directory in `docs/framework.md`, the website's SDK
  and sessions page and the README; the event reference lists the
  `skills.*` codes.

- `@xandreed/core`: `traceTurn(writer, { spanMeta })`, the `agent.turn`
  span as a lifecycle step for host-composed turns: `efferent.session.id`,
  `efferent.run.id` and `efferent.turn` on it and on every span under it,
  `gen_ai.conversation.id`, `efferent.origin`, `efferent.resumes` on a
  resume, and the allowed `efferent.meta.<key>`s, and at its end `efferent.outcome`,
  `efferent.failure.code` and the turn's usage
  (`efferent.usage.*_tokens`; for a turn that failed, what `guardTurn`
  records on its span: the usage its provider calls spent).
  `Agent.turn` uses it.
- `@xandreed/sdk`: `AgentConfig.spanMeta`, the keys of a turn's metadata its
  span carries (none by default); the metrics `efferent.turns` and
  `efferent.turn.duration` (milliseconds), by `efferent.outcome`, for every
  turn `Agent.turn` runs once it is admitted.
- `@xandreed/core`, `@xandreed/sdk`: `captureTraceContent` on `AgentConfig`,
  `TurnPolicy`, `TurnRunOptions` and `StepRequest`, and the
  `CurrentTraceContent` reference: a run's spans carry its prompts and
  responses (`engine.step.input`, `engine.step.output`, the models plugin's
  `llm.reasoning`) when its policy says so, else the agent, else the
  reference where the run starts; off by default. `Agent.turn` never set
  the loop's option before, so content capture only worked when calling
  `runLoop` directly.
- `@xandreed/core`: `replayableContext(context)`, a captured context without
  the trace state of where it was captured (the parent span, the span
  annotations and links, the trace-content switch), for code that provides a
  context again later; the registry, the step loop, `turnOf`,
  `stepRequestOf`, `Agent.turn`, the bus's subscribers, the session chassis,
  `makeLiveLayer` and the models plugin's layers use it.
- `@xandreed/core`: `stepLoopConformance` checks that a loop provides the
  request's `captureTraceContent` to its model calls as
  `CurrentTraceContent`, over a caller's on or off.
- `@xandreed/core`: `ToolRefusedEvent`, `ToolRefusalReason`,
  `StreamFallbackEvent`, `TURN_EVENT_NAMES` and `JOURNAL_KINDS`.
- `@xandreed/plugin-agent-loop`: a pre-first-part stream failure emits
  `stream_fallback` (the stream's error as text, an object as JSON, cut to
  300 characters), which
  `runSteps` publishes as `stream.fallback`, and counts
  `engine.corrections{engine.kind: "stream-fallback"}`. `runLoop` provides
  its `captureTraceContent` (`CurrentTraceContent` when unset) to the run as
  `CurrentTraceContent`.
- `@xandreed/plugin-models`: `llm.reasoning` carries the model's reasoning
  when the call's `CurrentTraceContent` is on, as well as with
  `EFFERENT_TRACE_CONTENT=1`, read per call.
- Docs: `docs/framework.md` "Traces and metrics" (the span tree, the turn's
  span, where spans nest, the metrics, trace content), the event list and
  the journal vocabulary; the website's SDK and providers pages; the event
  reference lists `tool.refused`, `stream.fallback` and the reserved names.
- `@xandreed/plugin-models`: proxy support for every call the plugin makes
  (the provider SDKs, the OpenAI-compatible client, OAuth token refreshes,
  the OpenAI subscription's WebSocket), on Node and on Bun. The `proxy`
  option (a URL, `Redacted` when it carries credentials) else
  `https_proxy` / `HTTPS_PROXY` and `http_proxy` / `HTTP_PROXY` (lower case
  first, as undici and curl read them); `noProxy` added to `no_proxy` /
  `NO_PROXY` (host names with their subdomains, ports, IP addresses, CIDR
  ranges, `[::1]`, `*`); loopback always direct; a value without a scheme
  reads as `http://`. Proxy credentials are redacted from error messages; a
  failed proxied call names the proxy and the target, a proxy's 407 on Bun
  included.
- `@xandreed/plugin-models`: the `ModelsTransport` port (a `fetch`, and
  `webSocketAgent` for the subscription's WebSocket) and
  `ModelsTransportLive(options)`, a scoped layer that fails with
  `ProxyInvalid`, `ProxyUnsupported` or a `ConfigError`: on Node undici's
  `fetch` with a `ProxyAgent` and a direct `Agent`, and plain agents for
  direct WebSockets (independent of `NODE_USE_ENV_PROXY` and the global
  dispatcher and agents; a proxy that closes the connection while the tunnel
  opens fails the call at once instead of undici reopening it in a loop), on
  Bun fetch's `proxy` option and, from Bun 1.3.6, the native `WebSocket`'s.
  With `noProxy: "*"` on Node it is undici's direct agent. Hosts give the
  OAuth login helpers its `fetch`. The plugin builds a transport only when a
  proxy applies (or for `noProxy: "*"` on Node); the routed model and the
  utility model then provide its fetch as `FetchHttpClient.Fetch`
  innermost, so an ambient one cannot route a call past it. The
  subscription's WebSocket client refuses a route the runtime cannot use
  (`Agent` is for Node, `Proxy` for Bun). Also exported: `transportFetch`,
  `HttpProxyOptions`, `ProxyUrlOption`, `ProxyConfig`, `ProxyEnvironment`,
  `NoProxyRule`, `ProxyInvalid`, `ProxyUnsupported`, `resolveProxy`,
  `proxyFor`, `parseNoProxy`, `bypassesProxy`, `isLoopback`,
  `redactCredentials`, `PROXY_VARIABLES`, `BUN_WEBSOCKET_PROXY_VERSION`,
  `NODE_WEBSOCKET_PROXY_VERSION`, and `makeOpenAiCodexWebSocketHttpClient`
  (`makeOpenAiCodexLanguageModel` takes an optional `webSocketProxy`).
- Docs: the website's providers page "Proxy" (options, NO_PROXY syntax, Node
  and Bun behaviour, the subscription's WebSocket, a host's own transport,
  OAuth logins behind a proxy); `docs/framework.md` and the README mention it.

- `@xandreed/core`: the busy signal. `TurnActivity` (the turns this
  process has in flight, read at one moment as `TurnsInFlight`: the turns
  held open, each `{ session, turn, since }`, and the begins still in
  progress) and `TaskActivity` (the background work it runs) are optional
  ports; `processActivity` reads them into a `ProcessActivity` (`{
  openTurns, beginningTurns, runningTasks, busy }`, a missing port counting
  nothing), and `awaitIdle({ timeout })` waits until nothing is open,
  beginning or running at once, returning what is still in flight when the
  timeout comes first. `SessionsLive` provides `TurnActivity`: a begin
  counts from before the host's admission until its writer is handed over,
  then the turn until its writer's scope closes, per session and turn.
  `InProcessTaskRunnerLive` provides `TaskActivity` (a piece of work is
  forked and counted in one step, so an interrupted caller leaves none
  uncounted), and `@xandreed/sdk`'s `agent.activity` reads them from the
  agent's runtime services. The framework guide and the website show a
  `/ping` and a SIGTERM drain (stop admitting, wait until idle, stop the
  requests, close the services, with the task runner built on top of the
  sessions so its tasks end before the log closes), which an sdk test runs,
  including a drain that times out. The framework guide explains the lease
  keep-alive and the `everyMs <= ttlMs / 2` rule, which the plugin
  reference now shows as the lease's description. The event reference
  suggests 503 for `TurnRefused` while draining.

- **`@xandreed/plugin-telemetry`** (new; Node 24 and Bun, no `node:`
  imports): usage, cost and tool telemetry per turn, and OTLP/HTTP export.
  - `telemetryPlugin` / `TurnTelemetryLive` (session-scoped; requires
    `RunContext` and `TurnEvents`): records `efferent.llm.tokens` by
    `efferent.model` and `efferent.token.kind` (`input`, `cache_read`,
    `cache_write`, `reasoning`, `output`, from `usageBreakdown`, summing to
    each response's total), `efferent.llm.cost` (`costOf` at the host's
    `prices`, keyed by the models plugin's selection), `efferent.steps` (by
    `efferent.step.status`), `efferent.tool.calls` and
    `efferent.tool.duration` (by `efferent.tool` and `efferent.ok`),
    `efferent.tool.refused` (by `efferent.tool` and
    `efferent.refusal.reason`) and `efferent.stream.fallbacks`, each with
    the host's `metricAttributes` and never a session, run or turn id
    (`TelemetryMetrics`). The cost names carry no currency (the prices'
    currency is the host's). With `spanEvents` (the default) it sets the
    turn's ids on the span current where it is built (`agent.turn` under
    `Agent.turn`) and adds `efferent.step.usage`, `efferent.tool.refused`
    and `efferent.stream.fallback` events (each with the zero-based
    `efferent.step`) and the running `efferent.cost` attribute.
  - `OtlpTelemetryLive(options)` (global `fetch`) and
    `OtlpTelemetryHttpLive(options)` (the host's `HttpClient`): Effect's
    `OtlpTracer` and `OtlpMetrics` (`effect/observability`) with one
    `Flusher`; `serviceName` (else `resourceAttributes["service.name"]`,
    else `"efferent"`; it wins over `OTEL_SERVICE_NAME`), `baseUrl` or
    per-signal `tracesUrl`/`metricsUrl`, `headers` and per-signal
    `tracesHeaders`/`metricsHeaders`, `protocol` (`http/protobuf` by
    default, or `http/json`), `compression`, `exportInterval`,
    `shutdownTimeout`, `metricsTemporality`.
  - `OtlpTelemetryFromEnv(defaults?)` (global `fetch`) and
    `OtlpTelemetryHttpFromEnv(defaults?)` (the host's `HttpClient`): the
    standard environment (`OTEL_EXPORTER_OTLP_ENDPOINT`, the per-signal
    endpoints, headers, compression and protocol, `OTEL_SERVICE_NAME`,
    `OTEL_SERVICE_VERSION`, `OTEL_RESOURCE_ATTRIBUTES`,
    `OTEL_{TRACES,METRICS}_EXPORTER`, `OTEL_SDK_DISABLED`, the export
    intervals and temporality; not `OTEL_EXPORTER_OTLP_TIMEOUT`). Disabled
    or with no endpoint it exports nothing and reads nothing further; a
    signal's own endpoint, compression and protocol are read first, so an
    invalid shared one does not fail a signal that sets its own; a variable
    it reads that holds an invalid value fails with its `ConfigError`.
  - `flushTelemetry`, for a serverless host before it responds.
- Docs: the website's `concepts/observability.md` (export, the environment
  variables, the span tree, the metrics, cost, serverless flushing), a
  pointer from `docs/framework.md` "Traces and metrics" and the SDK page,
  and the package in the README, the getting-started table and the plugin
  reference.

- Docs: the events guide, `docs/events.md` and its website page
  (`/docs/guides/events/`, in a new Guides group; the plugin and event
  references move to a Reference group). It answers how to use the events:
  the live bus against the durable journal; streaming a turn to a client
  through one background subscription; which subscription sees
  `turn.started` and `turn.ended` (the host's per-turn layer, a scope that
  outlives the turn) and what settles when; handlers that must neither fail
  nor block (a push bounded with `Effect.timeoutOption` and a gone latch);
  `onTool`, `tool.refused` and `step.ended.results`; host events and the
  reserved names; reading the journal across processes (a shared
  `SessionLog`, polling, write-behind and reaped turns); stored failure
  codes; resume, the lease keep-alive and the busy signal; and a Fetch API
  HTTP recipe for Next.js and other servers: one host per instance, session
  creation, a turn streamed over SSE with begin codes mapped to statuses and
  `Idempotency-Key` retries (and a keyless resume's) answered from the
  journal, the journal over SSE through plugin-render's feed with a client
  projection and a write bound that drops a client that stopped reading,
  and `/ping`. Every snippet but the Next.js glue is a region of
  `packages/sdk/src/events-guide.test.ts`, which runs key-free with scripted
  models (streamed deltas reaching a client through `Agent.turn` among
  them). The README, `docs/framework.md` (events, background subscriptions,
  following a session), the website's SDK page and the event reference link
  to it.

### Fixed

- `@xandreed/plugin-session-sqlite`: processes opening one new database file
  at the same moment could fail at once with "database is locked", because
  the file was switched to WAL before the busy timeout was set. The busy
  timeout is now set first, so they wait for each other.

### Repository

- A 0.13.0 session journal, recorded deterministically by
  `scripts/record-journal-fixture.ts` (`packages/sdk/fixtures/journal-0.13.0.json`):
  every reserved kind (the fixture lists them), the task records, the inbox
  and a host event. The sdk test `journal-compat.test.ts` reads every
  fixture in that folder, decodes every event with `journalSchemaOf`,
  rebuilds the memory log and replays every stored model request from it.
- `bun run verify:packages` compiles every `@xandreed/*` import in the
  README, `docs/framework.md`, `docs/composable-evaluations.md` and the
  website docs against the packed packages, and checks that each plugin's
  version equals its package's.
- The plugin reference lists `uiOutputPlugin`; its generator imports every
  workspace package and fails when one exports a plugin it does not list.
- The docs site deploys when a `v*` tag is pushed, or by hand, no longer on
  every push to main, so it describes what npm has; the `github-pages`
  environment needs a `v*` tag rule once (CONTRIBUTING). CI still builds and
  link-checks it on every push, and fails when a generated reference under
  `docs/` or the website is not committed as generated.
- `docs/composable-evaluations.md` showed calibration APIs that were removed
  and an import path the package does not export; it now uses
  `defineGraderCalibration` and `calibrateGrader`, and imports
  `SemanticJevLive` from `@xandreed/evals`, and describes gates as the
  suite's `Gate`s and the run's `GateFinding`s. Snippets named
  `LanguageModel.Service`, which Effect 4 calls `LanguageModel.LanguageModel`.
  `docs/framework.md` and `docs/service-generations.md` no longer describe
  the removed journey driver.
- `bun run verify:packages` runs `stepLoopConformance` over the packed step
  loop (`runSteps`) and `turnConformance` over a packed `Agent` on Node.
- A key-free `bun:test` journey with scripted models (`packages/sdk/src/resume.journey.test.ts`):
  a turn cancelled while a tool call runs is resumed with its message, the
  resume retried, and a finished turn refused; and a resume whose provider
  was down is tried again with a new key, after which the turn is answered. `bun run verify:packages`
  resumes a cancelled turn through the packed packages.
- The sdk golden journal and model files are regenerated: `context.built`
  records carry `budgetTokens`, and the failed turn's `turn.ended` carries
  its error's code (`host.failed`).
- `bun run verify:packages` runs the AuthStore, SettingsStore and
  ModelCatalog kits over the packed `@xandreed/plugin-models` stores on Node,
  and runs `scripts/models-consumer.fixture.mjs` on Node in a process of its
  own whose HOME and working directory are fresh empty directories: with
  `storage: "memory"`, two turns, a login, a role edit, a logout, the catalog
  and a utility call leave both empty. `@xandreed/sdk` tests the plugin at
  the agent level (a dev dependency).
- `bun run verify:packages` runs the Sessions kit over the packed
  `SessionsLive` and in-memory log, each check under a `TestClock`, and the
  TaskRunner, Tasks and ToolRegistry kits over `InProcessTaskRunnerLive`,
  `TasksLive` and the tool discovery plugin's registry, on Node.
- `bun run verify:packages` loads a `SKILL.md` tree with the packed
  `SkillsDirectoryPluginLive` over `FileSystemLive`, on Bun and on Node. The
  plugin reference page says what each plugin contributes and reads when
  present (`Contributes`, `Optional`), and "none" for a plugin that provides
  nothing.

- `scripts/record-journal-fixture.ts` records a refused call and a stream
  fallback, so the next release's fixture holds `tool.refused` and
  `stream.fallback`; the 0.13.0 fixture is unchanged and still decodes.
  `journal-compat.test.ts` expects a fixture to hold every journal kind its
  version reserved (a reserved bus name never stored as itself excepted).
  The event-reference generator lists the journal from `JOURNAL_KINDS` and
  fails on a reserved name that is neither a journal kind nor a bus event's.
- The `@xandreed/plugin-workspace` tests run a key-free workspace-tools
  journey through `Agent.define` with the step loop, memory window, tool
  discovery and sessions plugins and `fast-check` (`foundry.config.ts`), as
  the skills directory tests do; `verify:packages` runs a packed version of
  that journey on Bun and Node.

- `@xandreed/plugin-telemetry` joins the build, the foundry gates (with a
  `plugin-telemetry-tests` layer that may import the sdk and the plugins a
  scripted turn needs), `tsconfig.base.json` and the plugin reference. Its
  tests run a key-free scripted turn (usage kinds, cost, tools, refusals,
  span events, a stream fallback) and export to a `Bun.serve` collector.
  `bun run verify:packages` runs `scripts/telemetry-consumer.fixture.mjs`
  on Node and on Bun: a turn with the packed plugin under
  `OtlpTelemetryLive` posts nothing before `flushTelemetry` and, by the time
  it returns (the export layer still open), its `agent.turn` span (with its
  ids and `engine.run` under it) and its token and cost metrics have reached
  a `node:http` collector. The plugin reference prints `Provides: none` for a
  plugin that provides nothing.
- `bun run verify:packages` runs `scripts/proxy-consumer.fixture.mjs` on Node
  24.5 or newer against the packed packages, with `NODE_USE_ENV_PROXY=1` and
  environment proxies pointing at a dead port: model and utility calls
  through a recording proxy (CONNECT), loopback and `noProxy` hosts direct
  (direct WebSocket agents included), `HTTP_PROXY` with credentials, a dead
  proxy named without its credentials, a resetting proxy failing at once,
  the subscription WebSocket's CONNECT sent through the proxy, and every
  call direct with `noProxy: "*"`. On Bun, the packed consumer sends a model
  call through the `proxy` option to a recording proxy (absolute form). The
  plugin-models tests run a recording proxy that handles CONNECT and
  absolute-form requests and resolves `*.invalid` hosts locally, so nothing
  reaches the network; the tests of direct requests skip when the machine
  has a proxy in its environment (CONTRIBUTING.md). CI runs the proxy tests
  again on Bun 1.3.6, where the subscription's WebSocket tunnels, so both
  sides of that version gate are tested. A new foundry layer
  `plugin-models-tests` lets them use `fast-check`.
  `undici-fetch.adapter.ts` joins the declared type-erasure boundary. The
  packed READMEs name the Node version a package's `engines` declares
  (`plugin-models`: Node 24.5).

- `scripts/sync-guides.ts`, chained into `bun run docs:generate`: it copies
  each `<!-- snippet: <file>#<region> -->` region of a test into the guide,
  with the import lines its code uses (from the test's own imports,
  `scripts/guide-snippets.ts`), and mirrors the guide to the website,
  rewriting each link to a repository file to its website page or to
  GitHub. It fails on a snippet that imports from a relative path, the test
  runner (`bun:`) or test scaffolding (a `testing` module), a region no
  guide quotes, a snippet marker not followed by a `ts` fence, a TypeScript
  or JavaScript fence that is neither a snippet nor marked
  `<!-- unchecked: why -->`, and a link to a missing file or heading. CI's
  generated-docs check covers the guide and its page.
- `bun run verify:packages` compiles the events guide's HTTP recipe (its
  regions of `events-guide.test.ts`, composed with their imports) against
  the packed packages, and runs `scripts/events-consumer.fixture.mjs` over it
  on Node (stripping the recipe's types) and on Bun: a session created, a
  turn streamed from `started` through its deltas to `done` while the
  journal route follows the session over SSE, its retry answered from the
  journal, and `/ping` idle.
- The `sdk-tests` foundry layer may import `@xandreed/sdk` by name and
  `@xandreed/plugin-render` (an sdk dev dependency), so the guide's snippets
  import only what a consumer can.

## 0.13.0

The composable agent (`Agent.define` and `Agent.turn` over the step loop) is
now the only way to run an agent. 17 packages: `@xandreed/plugin-memory` is no
longer published.

### Breaking

- **Effect 4.0.7.** Every package moves from `effect` 4.0.0-rc.118 to 4.0.7
  and pins that exact version. `@xandreed/plugin-models` also pins
  `@effect/ai-openai` and `@effect/ai-anthropic` at 4.0.7. Use `effect` 4.0.7
  in the host so the host and the packages share one Effect. Tool parameter
  schemas built from `Schema.Int` now state the safe-integer range (`minimum`,
  `maximum`) in their JSON Schema, which is an Effect 4 change. (#279)
- **Supported runtimes are declared.** Each manifest has `engines`: Node ≥ 24
  and Bun ≥ 1.3.0 for core, runtime, sdk and the plugins; Node ≥ 24 for
  `evals`, `evals-cli`, `evals-langfuse` and `evals-langsmith`; Bun ≥ 1.3.0
  for `plugin-session-sqlite`, which uses `bun:sqlite`. (#279)
- **The Harness API is removed.** (#280)
  - `@xandreed/sdk`: `Harness` (`Harness.make`), `domainLoop`,
    `domainSession` and `approvalPlugin`.
  - `@xandreed/core`: `AgentLoop`, `LoopInput`, `DelegateLoop`, `AgentTools`,
    `Approval`, `ContextManager`, the `Memory` port, `TurnHooks`,
    `SessionHandle`, the `SessionStore` and `ConversationStore` ports
    (with `ConversationSummary`, `RunOutcomeRecord`, `StoredMessage` and
    `StoreError`), and the harness session entities `SessionRecord`,
    `EventBody`, `SessionEvent` and `MemoryEntry`. `SessionEnvironment` no
    longer has a `session` field.
  - `@xandreed/plugin-agent-loop`: `agentLoopPlugin` and `runAgent`. The
    package's default export is now `stepLoopPlugin`; `runLoop` stays as the
    step loop's engine.
  - `@xandreed/runtime`: the `efferent.config.json` loader and plugin
    installer (`loadConfig`, `decodeConfig`, `mergeConfig`, `writeConfig`,
    `redact`, `ConfigSource`, `loadPlugins`, `pluginSchema`).
  - `@xandreed/plugin-memory`, which only implemented the removed `Memory`
    port.
- **`@xandreed/plugin-session-sqlite`.** (#280)
  - `sessionSqlitePlugin` now provides `SessionLog` and the open admission
    policy (`TurnAdmission`). It requires nothing and takes only `path`;
    compose `sessionsPlugin` explicitly in the host graph.
  - Removed: the `SessionStore` and `ConversationStore` projections
    (`SessionStoreLive`, `SessionStoreProjectionLive`,
    `ConversationStoreProjectionLive`, `SqliteConversationStoreLive`), the
    `legacyPaths` option, and the importer for older SQLite journals.
    `SessionLogSqliteLive(path)` takes no options.
- `@xandreed/sdk` no longer depends on `@xandreed/plugin-memory` or
  `@xandreed/plugin-session-sqlite`. Install the plugins you compose. (#280)

### Migration

- Install `effect@4.0.7`, and run on Node 24 or newer, or Bun 1.3.0 or newer.
  `@xandreed/plugin-session-sqlite` needs Bun.
- Define the agent once with `Agent.define({ plugins, turnServices, system })`.
  Run each turn with `agent.turn({ turn, services }, use)` over a `Sessions`
  service, where `use` runs the step loop (`turn.run`) and returns the turn's
  outcome and reply. The README's "Compose" section has the full example.
- Replace `agentLoopPlugin` with `stepLoopPlugin`, which is also the
  package's default export now.
- Replace `@xandreed/plugin-memory` with a memory strategy:
  `@xandreed/plugin-memory-window`, `-summary` or `-digest`.
- Store sessions through the `SessionLog` port: `SessionLogMemoryLive` from
  `@xandreed/core` (in memory, Node or Bun) or `SessionLogSqliteLive(path)`
  from `@xandreed/plugin-session-sqlite` (a SQLite file, Bun). Provide it with
  `TurnAdmissionOpen` to `SessionsPluginLive` from `@xandreed/plugin-sessions`.
  Older SQLite journals (the `legacyPaths` option) are no longer imported.
- Move configuration from `efferent.config.json` into the `Agent.define`
  plugin entries: `{ plugin, id?, options }`.

### Fixed

- `@xandreed/evals-cli`: the `efferent-eval` bin keeps its `#!/usr/bin/env node`
  line, so it runs as a command. The build used to drop that line, so in
  0.12.0 and earlier the bin fails when run directly; with those, run
  `node node_modules/@xandreed/evals-cli/dist/main.js` instead.

### Repository

- `bun run publish:packages` publishes the built packages; 0.13.0 is its
  first release. It is a dry run unless `--publish` is passed. It
  refuses when the packages do not share one version, when a built version
  differs from its source manifest, when the build is not from the current
  `HEAD` or was made from a tree with changes, when the working tree has
  changes, when the `@xandreed/*` dependencies form a cycle, when `npm whoami`
  fails or names an account other than the project's, or when the registry
  cannot say whether a version is already published. It publishes
  dependencies first, skips versions already on npm, and uses
  registry.npmjs.org for every step. Its checks and order are tested
  (`scripts/publish-plan.test.ts`). See
  [CONTRIBUTING.md](CONTRIBUTING.md#publishing).
- `bun run build:packages` writes `.artifacts/packages/build.json` with the
  commit, whether the tree had changes (gitignored files in a package's
  published folders included), the shared version and the packages.
- `bun run typecheck` also type-checks `scripts/` (`scripts/tsconfig.json`).

## 0.12.0 — 2026-10-28

### Added

- `@xandreed/plugin-models`: named OpenAI-compatible endpoints under the
  `endpoints` option (`ModelEndpoint`, `ModelEndpoints`,
  `CurrentModelEndpoints`). A model selected as `<name>:<model id>` is sent to
  `<url>/chat/completions`. The key is optional: the endpoint's `apiKey`,
  then the environment variable `apiKeyEnv` names, then a key stored for
  that name; with none, no `Authorization` header is sent. `standardOnly`
  defaults to true, and an endpoint named like a built-in provider replaces
  it. (#278)
- A stored `local` credential with a `baseUrl` now routes the same way
  instead of failing as an unwired provider. (#278)

Hosts that build `LanguageModelLive` themselves are unaffected: the endpoints
reach the router as a context reference with an empty default.

## 0.11.0 — 2026-10-28

- The repository holds the composable agent framework only: core, runtime,
  sdk, the plugins hosts compose (agent loop, models, the memory strategies,
  tool discovery, sessions, the SQLite session store, tasks, render) and the
  evals packages. The coding CLI, the reference applications and the plugins
  only they used (context, mcp, policy-workspace, telemetry, tools-local) were
  removed from this repository. (#277)
- Every package except `@xandreed/plugin-session-sqlite` runs on Node 24 as
  well as Bun. (#277)
- All packages share one version, published under `latest` instead of
  `next`. (#277) The `next` dist-tag is no longer updated and still points at
  an older prerelease; install from `latest`.
