# Framework reset implementation

September 2026 implementation status. Efferent now has an Effect-native,
Bun/Linux agent SDK, a validated plugin graph, and a new terminal client.

## Delivered

- [x] Shared plugin/config/session contracts and service ports in `core`
- [x] Dependency resolution, explicit service bindings, scopes and failed-activation cleanup
- [x] Durable SDK sessions, queued input, cancellation, replay, settled-boundary forks
- [x] Replaceable model, loop, tools, policy, context, memory, session, MCP and telemetry plugins
- [x] JSON/TypeScript config loading, profiles, JSON overrides, diagnostics and plugin management
- [x] Direct-coding Smith preset and reusable conversation-focused TUI
- [x] Configurable spec/lock/forge workflow with replaceable worker and Foundry gates
- [x] API-key and subscription authorization in the new terminal
- [x] Reusable eval runner, scoped fixtures, custom checks/judges/reporters and campaigns
- [x] Canvas, Math and Social entry points run SDK presets; domain state follows forks
- [x] Built prerelease packages and an external consumer fixture
- [x] New documentation landing page, framework guide and generated plugin reference
- [x] CI coverage for package builds, external installs, PTY behavior and generated docs

## Verification

- Final full suite: **819 passed, 0 failed**, 2,842 assertions across 139 files.
- Root architecture/typecheck gate: zero grandfathered findings, zero new findings.
- Unit and integration coverage includes plugin activation, session queues and
  cancellation, active-turn reconfiguration, workspace isolation, reference-app
  snapshots, Foundry workflow repair, and OAuth callback cancellation.
- A stalled title-generation regression verifies that the historical terminal
  cannot strand a follow-up prompt after a completed turn.
- Foundry's own architecture profile and end-to-end demo: passed.
- Seven scripted scenario packs: passed their committed baselines.
- Documentation: 16 pages built; all internal links resolve.
- TUI: narrow/standard/wide frames, multiline paste, focus isolation, masked
  credentials, 10,000-event transcript and p95 input-to-frame below 50 ms passed.
- Real PTY: paste, submit, resize, command palette and clean shutdown passed.
- External distribution: installs 17 local tarballs through a temporary npm
  registry with an isolated cache; typechecks an external plugin; executes SDK
  sessions, persistence, fork, custom eval, CLI help, and the packed TUI in a PTY.
- Website inspected at desktop and mobile widths, with no horizontal overflow.

## Sessions: one log per session (2026-09-29, 0.8.0-next.0)

Composable agents now keep each conversation as one append-only session log.
Nothing is published; the packages build and verify as 0.8.0-next.0.

- [x] `SessionLog`, the storage a host provides: heads and events written by
  compare-and-swap with a storage-clock `notAfter`; `sessionLogConformance`;
  an in-memory log (core) and a SQLite log (`plugin-session-sqlite`)
- [x] `@xandreed/plugin-sessions`: one open turn per session, idempotency keys
  found in the log, ownership by lease (fixed, renewed on commit, or kept
  alive) or by process, reaping only on writing paths, cancel of exactly one
  turn, check-then-append inside and outside turns, the inbox and drain,
  forks cut at the parent's last closed turn
- [x] `TurnAdmission` around every turn's opening commit (`TurnAdmissionOpen`)
- [x] `Agent.turn` over a host-begun `TurnWriter` or a `NewTurn`; the turn
  journal, `JournalIO`, `MemoryLog` and `plugin-memory-log` are removed
- [x] `@xandreed/plugin-tasks`: background tasks as child-session turns,
  delivered to the parent's inbox once and answered after the turn in flight;
  `reconcile`, cancel, deadlines, admission refusals; `start_task` and
  `task_status` behind `tools`
- [x] plugin-render's feed over a session (`SessionsJournalTailLive`)

Verification:

- The model half of the SDK golden (the serialized requests, in order) is
  unchanged, and equal over the in-memory, SQLite and key-reordering stores.
- Full suite: 1,102 passed, 0 failed. Every commit passed typecheck, tests,
  the Foundry demo, the scenario packs, the package build and the packed
  consumer, which now also runs Sessions over SQLite with a background task.
- The canvas scenario "follow-up replaces an in-flight enrichment" waits a
  fixed 75 ms for the follow-up run; under load it failed in one gate run of
  the tasks commit and passed in the six runs and the gate that followed. The
  wait predates this work; it is a timing flake, not a measured regression.
- Not yet done: the Harness, CLI, TUI and reference applications still use
  `SessionStore`; moving them onto `Sessions` (process ownership) and
  deleting `SessionStore` and `ConversationStore` is a follow-up.

## Command, streaming, and setup follow-up

A later user report exposed gaps the previous acceptance test did not cover:
`/` required Enter, streaming remounted native markdown nodes, onboarding had no
screen, and the plugin editor offered options without a replacement action.

- `/` now shows inline, filtered commands while the composer keeps focus; arrows,
  Tab, Enter, and Escape have regression coverage, including command arguments.
- Transcript rows use durable IDs and preserve native markdown renderers across
  deltas and settlement. Configuration fingerprints no longer enter the chat.
- `/setup` opens automatically when no model is configured and remains available
  to existing users. Provider connection can continue to model selection.
- `/plugins` offers **Replace plugin…**, compatible loaded implementations, and
  an installed-package/local-path entry. Loading, graph validation, activation,
  and persistence run before success is shown. Session replacements handle the
  next query; runtime replacements explicitly request a restart.
- The actual CLI tmux check samples every 15 ms during a 50-word incremental
  stream, verifies visible words never disappear, and preserves an editable
  draft. It also exercises onboarding/login navigation, immediate slash
  filtering/completion, invalid replacement preservation, a live replacement
  query, and closing menus without cancelling a run.
- Local evidence: `.artifacts/tmux/onboarding.txt`, `slash-commands.txt`,
  `streaming-frames.json`, `incremental-markdown.txt`, and `plugin-replacement.txt`.
  These deterministic checks do not perform a fresh external OAuth exchange.

## Interactive follow-up

The earlier PTY check used a standalone UI fixture. It did not validate the
actual CLI setup flow or live provider transport. Interactive tmux testing
subsequently reproduced and fixed:

- `/model` opening the generic plugin menu instead of a model picker.
- Existing model settings and logins being ignored after the reset.
- Subscription transport timing frames crashing the response decoder.
- Effect logs overwriting the composer, duplicate errors, and raw decoder dumps.
- Model-menu rows overflowing their dialog and hiding selection in small panes.
- Task-list inspection reading a tool completion instead of its arguments.
- Startup prompts needing to wait until the UI and approval listener are ready.

`python scripts/verify-tmux.py` now launches the actual CLI with a deterministic
model plugin. It covers setup, preserved multiline input, a 60×20 pane, plugin
editing, streamed responses, read-tool execution, keyboard tool expansion,
cancellation, startup prompts, and shutdown. This is separate from the live
provider checks. CI runs this test, and local frames are saved in `.artifacts/tmux`.

## Validation limits

Provider-backed quality campaigns and interactive OAuth login have not been
rerun. A live configured-provider conversation, coding task, sandboxed `bun test`,
and tool cancellation have been exercised through tmux. Scripted regressions validate behavior; they do not establish live model
quality. The historical Smith workflow entry remains available for old specs,
and domain session adapters remain available for existing low-level fixtures.

## Data and release

New SDK data uses `.efferent/runtime`. No old databases, specs, credentials or
memory files were deleted or migrated. The untracked user handoff note is untouched.

Local `0.2.0-next.0` artifacts are under `.artifacts/packages` and
`.artifacts/tarballs`. No packages or website changes have been published.
