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
