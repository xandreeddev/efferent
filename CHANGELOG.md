# Changelog

Changes to the published `@xandreed/*` framework packages. All of them share
one version and are published together under npm's `latest` tag.

Every pull request adds its entry under **Unreleased**. A release turns that
section into the new version. Releases before 0.11.0 are not recorded here.

## Unreleased

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
  (the services a plugin uses when present) for every plugin, and the models
  plugin's entry its new scope and options; its graph fingerprint changes.
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
