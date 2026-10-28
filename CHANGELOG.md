# Changelog

Changes to the published `@xandreed/*` framework packages. All of them share
one version and are published together under npm's `latest` tag.

Every pull request adds its entry under **Unreleased**. A release turns that
section into the new version. Releases before 0.11.0 are not recorded here.

## Unreleased

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
