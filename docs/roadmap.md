# Framework roadmap

The 33-step framework plan is complete in this source checkout. The work below
provides the storage, execution and host bindings for agents that accept input
while running and recover after a process restart. Hosts choose their model,
tools, policy and application interface.

These are source capabilities for the next release. Workspace manifests still
share version `0.14.0`; the [Unreleased changelog](../CHANGELOG.md#unreleased)
records the changes. This page does not announce a package release.

## Completed milestones

### M0 — Compatibility and thinking

| Item | Completed work | Contract |
| --- | --- | --- |
| 1 | Stored-format versioning, compatibility checks and retained journal fixtures | [Sessions](framework.md#sessions-one-log-per-session) |
| 2 | Thinking-prefix binding, configurable mismatch behavior and reported drops | [Model settings](framework.md#runtime-model) |

### M1 — Durable sessions and lifecycle

| Item | Completed work | Contract |
| --- | --- | --- |
| 3 | Node 24/Bun directory session store with revision CAS and bounded I/O | [Session stores](framework.md#sessions-one-log-per-session) |
| 4 | Crash, torn-tail and multiprocess storage recovery coverage | [Recovery suite](../packages/plugin-session-files/src/session-recovery.test.ts) |
| 5 | Explicit known-dead takeover and resumable interrupted turns | [Resume and takeover](framework.md#resuming-a-turn) |
| 6 | Graceful shutdown, turn refusal and durable interruption within a deadline | [Shutdown](framework.md#busy-signal-and-graceful-shutdown) |
| 7 | Separate active-work and backlog signals, plus per-turn time limits | [Activity](framework.md#busy-signal-and-graceful-shutdown) |

### M2 — Honest steps

| Item | Completed work | Contract |
| --- | --- | --- |
| 8 | Whole, cut and malformed response handling before tool execution | [Step outcomes](framework.md#host-planned-initial-tool-batch) |
| 9 | Provider tool-call identity alongside framework invocation identity | [Events](events.md) |
| 10 | Durable tool admission/results and exact interrupted-call recovery state | [Resuming a turn](framework.md#resuming-a-turn) |

### M3 — Durable input

| Item | Completed work | Contract |
| --- | --- | --- |
| 11 | Immutable queued user input and idempotent enqueue | [Sessions and inboxes](framework.md#sessions-one-log-per-session) |
| 12 | Durable steering between settled steps, with late input retained | [Durable agents](framework.md#durable-and-steerable-agents) |
| 13 | Owner-scoped inbox drainer, startup recovery and bounded retry/backoff | [Sessions and inboxes](framework.md#sessions-one-log-per-session) |

### M4 — Model calls

| Item | Completed work | Contract |
| --- | --- | --- |
| 14 | Messages endpoints and per-model thinking, effort and output settings | [Model settings](framework.md#runtime-model) |
| 15 | Cache breakpoint limits, TTL ordering and stable-prefix planning | [Prompt caching](framework.md#runtime-model) |
| 16 | Typed provider failures and context-overflow classification | [Model failures](framework.md#runtime-model) |
| 17 | One bounded request retry policy with Retry-After handling | [Request policy](framework.md#runtime-model) |
| 18 | Terminal usage facts for physical model attempts, including helper calls | [Token usage](framework.md#token-usage) |
| 19 | Memory maintenance after the final reply | [Memory lifecycle](framework.md#composable-agents-the-host-composes-the-turn) |
| 20 | Bounded context-overflow recovery under a tighter budget | [Memory lifecycle](framework.md#composable-agents-the-host-composes-the-turn) |

### M5 — Replay and media

| Item | Completed work | Contract |
| --- | --- | --- |
| 21 | Content-addressed request parts with the existing replay API | [Durable requests](framework.md#composable-agents-the-host-composes-the-turn) |
| 22 | Optional immutable media storage and logical-log hydration | [Media storage](framework.md#images-and-multi-part-messages) |
| 23 | Opt-in render snapshots with fork-aware publication pointers | [Render snapshots](framework.md#composable-agents-the-host-composes-the-turn) |

### M6 — Host policy and workspace tools

| Item | Completed work | Contract |
| --- | --- | --- |
| 24 | Host-controlled command environment and workspace root access | [Workspace tools](framework.md#workspace-tools) |
| 25 | Per-tool call limits, concurrency, breakers and loop limits | [Tool policy](framework.md#composable-agents-the-host-composes-the-turn) |
| 26 | Optional ripgrep execution with a timeout and explicit ignore-file policy | [Workspace tools](framework.md#workspace-tools) |
| 27 | ImageResizer port and external-CLI adapter for image reads | [Image resizing](framework.md#workspace-tools) |

### M7 — Hooks, helpers and traces

| Item | Completed work | Contract |
| --- | --- | --- |
| 28 | Per-call model request hook with durable dispatch evidence | [Host composition](framework.md#composable-agents-the-host-composes-the-turn) |
| 29 | Validated tool interception before and after handler execution | [Host composition](framework.md#composable-agents-the-host-composes-the-turn) |
| 30 | Multi-turn helpers, waiting questions, durable answers and reconciliation | [Durable agents](framework.md#durable-and-steerable-agents) |
| 31 | Neutral GenAI trace attributes, LangSmith OTLP binding and durable task ancestry | [Traces](framework.md#traces-and-metrics) |

### M8 — Process host and guide

| Item | Completed work | Contract |
| --- | --- | --- |
| 32 | Versioned bounded stdio peer, command dispatch, signals and restart journeys | [Process protocol](process-protocol.md) |
| 33 | This roadmap and a connected durable-agent composition guide | [Durable and steerable agents](framework.md#durable-and-steerable-agents) |

## Verification and limits

The default checks are key-free. Scripted journeys exercise source and packed
Node/Bun packages, durable acknowledgments, process death and restart. Local
OTLP collectors check emitted attributes and task ancestry. These checks do not
establish live provider acceptance, an exact provider bill, live LangSmith
ingestion or behavior on every network filesystem. Provider-backed evidence
needs the actual endpoint/model and versioned request configuration.

The directory store requires the documented filesystem operations, including
exclusive hard links. Workspace root rules do not confine Bash commands, and
the builtin JavaScript grep engine remains without a matching time limit; the
ripgrep path supplies its own timeout. See the linked contracts for these
limits and the optional external image tools.

## Deferred follow-ups

The original plan leaves these outside the completed sequence:

- A session-store mode without hard links, for filesystems such as SMB.
- Optimization of begin's sequence-zero history scans.
- Append-only rendering.
- Live Models API limits.
- sharp and WASM image-resizer adapters.
