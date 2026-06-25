---
title: The runtime
description: What actually happens when efferent runs — one Bun process, how it launches, how it connects to providers and stores, the four modes, and the exact data on the wire for events, JSON-RPC, and the sub-agent fleet.
sidebar:
  label: The runtime
  order: 2
---

[Architecture](/docs/concepts/architecture/) describes the *static* shape — ports, adapters, the
inward dependency rule. This page is the *dynamic* side: what happens when you actually run efferent.
One process boots, composes its Layers, connects to a provider and a store, drives the
[agent loop](/docs/concepts/agent-loop/), and emits a stream of events. Below: the process model,
the launch sequence, how it connects, the four modes, and — concretely — the bytes on the wire.

## One process, no build step

efferent is **one Bun process**. There is no compile step: Bun runs the TypeScript directly
(`tsc --noEmit` is only a typecheck gate). The agent loop, every sub-agent, and the comms bus are
**Effect fibers** in that one process's runtime — not OS subprocesses, no IPC. Parallelism is
bounded `Effect.forEach`; cancellation is structured (`Esc` interrupts a whole subtree, no orphans).

In the TUI, three runtimes cooperate in that process:

- the **Effect** runtime owns the agent loop, the ports, and all IO;
- **SolidJS** signals hold the view state and react to it;
- **OpenTUI** renders the SolidJS tree to the terminal (its Zig renderer is `dlopen`'d over FFI).

An event pump bridges them: the loop's hooks push `AgentEvent`s onto a `Queue`, and a consumer
fiber drains the queue into Solid signals the views read. The non-TUI modes skip Solid/OpenTUI
entirely and render the same queue as text or JSON.

## Launch

`packages/code/src/main.ts` is the composition root. Booting is a fixed sequence:

1. **Parse argv** with `@effect/cli` (`--mode`, `--resume`, `--cwd`, `--allow-bash`, the prompt).
2. **Compose the Layer stack** — one `AppLive` that merges every adapter the agent needs:

   ```ts
   const AppLive = Layer.mergeAll(
     SwitchableStoresLive,   // ConversationStore + ContextTreeStore (SQLite or Postgres)
     ModelLive,              // the router LanguageModel + ModelRegistry + LlmInfo
     LocalFileSystemLive, LocalShellLive, HttpLive,
     WebSearchLive, UtilityLlmLive, AuthFlowLive,
   ).pipe(Layer.provideMerge(CredentialsLive)) // AuthStore + SettingsStore
   ```

   Telemetry is layered at the very edge: a `Layer.unwrapEffect` reads `Settings.telemetry` and
   returns the OTLP exporter or `Layer.empty` — nothing exports unless you turn it on.
3. **Load the workspace** — `loadSkills`, `loadAgents`, `loadTools` walk `cwd → parents → ~/.efferent`,
   and `discoverScopeTree` reads any `SCOPE.md` files. These produce the data the system prompt and
   the toolkit are built from.
4. **Dispatch to a mode** (tui / print / json / rpc / daemon) and hand off to `BunRuntime.runMain`,
   which provides `AppLive`, runs the mode's Effect, and restores the terminal on exit — success,
   failure, or interrupt.

No credentials are read from the environment and there is no `init` command: the process always
boots, and you add a provider in-session with `:login` (written to `~/.efferent/auth.json`).

## Connect

efferent connects to two things at runtime — a model provider and a store — and both are resolved
**late**, so a `:login` or a `/model` switch takes effect on the very next turn with no rebuild.

- **Providers.** The agent loop talks to one provider-agnostic `LanguageModel`. The
  [router](/docs/concepts/providers/) reads the current selection from `SettingsStore`, resolves a
  key from `AuthStore` (refreshing a near-expiry OAuth token first), and builds the chosen provider's
  `@effect/ai` client **per request** over a shared `FetchHttpClient`. Keys are never captured at
  layer-build time.
- **Auth.** Credentials live only in `~/.efferent/auth.json` — per provider, `api_key` or `oauth`,
  written atomically `0600`. Anthropic/OpenAI subscriptions use PKCE OAuth; a loopback callback
  server in the driver completes the flow.
- **Stores.** Conversation history + the context tree persist to **SQLite by default**
  (`~/.efferent/efferent.db`, zero config). Set `EFFERENT_DB_URL` to a `postgres://…` URL for
  Postgres, or any other value for SQLite at that path. The store is chosen at layer-build, so it
  binds at boot.

## The four modes

The loop is identical across modes; only *how the event queue is rendered* differs.

| Mode | Invocation | Renders the queue as |
| --- | --- | --- |
| `tui` | `efferent` (a TTY) | a live, borderless terminal UI |
| `print` | `efferent "<prompt>"` · `-p` · stdin `-` | final text on stdout, a tool log on stderr |
| `json` | `efferent --mode json "<prompt>"` | every event as one JSON line on stdout |
| `rpc` | `efferent --mode rpc` | bidirectional JSON-RPC over stdio |
| `daemon` | `efferent --mode daemon` | no output — runs the cron scheduler headless |

`json` and `rpc` are the integration surfaces; their wire format is below.

## On the wire — the event stream

Every mode is driven by one **`AgentEvent`** union (`code/src/events.ts`). In `json` mode each event
is serialized as a single line of JSON on stdout (JSONL). A turn that reads a file looks like this:

```jsonl
{"type":"turn_start","turnIndex":0}
{"type":"tool_call_start","turnIndex":0,"id":"call_8f2","toolName":"read_file","args":{"path":"src/math.ts"}}
{"type":"tool_call_end","turnIndex":0,"id":"call_8f2","toolName":"read_file","ok":true,"result":{"content":"export const add = …","totalLines":42}}
{"type":"assistant_message","turnIndex":0,"text":"`add` is defined at src/math.ts:1.","usage":{"inputTokens":5120,"outputTokens":48,"totalTokens":5168,"cacheReadTokens":4096}}
{"type":"agent_end","finalText":"`add` is defined at src/math.ts:1.","messages":[…]}
```

The full vocabulary: `turn_start`, `assistant_message` (carries `usage` and, for sub-agent narration,
a `nodeId`), `tool_call_start` / `tool_call_end` (paired by provider `id`), `subagent_start` /
`subagent_end`, `skill_load`, `helper_usage` (a fast-tier helper ran — e.g. a compaction digest or a
title), `agent_end`, and `error`. Tool-call start/end pair on `id` so two same-named calls in one
turn never cross. Sub-agent inner events carry the `nodeId` of their context-tree node, which is how
a UI attributes parallel fan-out correctly.

## On the wire — JSON-RPC

`rpc` mode is a newline-delimited JSON-RPC 2.0 server on stdin/stdout (one object per line, no LSP
framing). One method: **`agent.send`**.

A client sends a request:

```json
{"jsonrpc":"2.0","id":1,"method":"agent.send","params":{"prompt":"add a test for add()","conversationId":"…optional…","cwd":"…optional…","allowBash":false}}
```

As the loop runs, the server streams each `AgentEvent` as an **`agent.event`** notification (no `id`),
tagged with the conversation it belongs to:

```json
{"jsonrpc":"2.0","method":"agent.event","params":{"conversationId":"c3a…","event":{"type":"tool_call_start","turnIndex":0,"id":"call_1","toolName":"edit_file","args":{"path":"src/math.test.ts","edits":[…]}}}}
```

When the turn finishes, every notification has already been written; then the response resolves:

```json
{"jsonrpc":"2.0","id":1,"result":{"conversationId":"c3a…","finalText":"Added a test; bun test passes."}}
```

Errors use standard codes: `-32700` parse error, `-32600` invalid request, `-32601` unknown method,
`-32602` bad params (missing `prompt`, invalid `conversationId`), `-32000` the run failed. Omit
`conversationId` and the server mints a fresh one and returns it — the client threads it back to
continue the same conversation.

## On the wire — the sharded sub-agent fleet

A coding task fans out into a [tree of sub-agents](/docs/concepts/sub-agents/). The model spawns one
with the `run_agent` tool; the call and its return are ordinary tool data:

```jsonc
// the tool call (folder-scoped; optional role + seed)
run_agent({ "name": "test math", "folder": "packages/core", "task": "add a test for add()", "agent": "implementer" })
// what it returns to the parent
{ "summary": "Added add() test; bun test green.", "filesChanged": ["packages/core/math.test.ts"], "nodeId": "n_7f3" }
```

Each spawned fiber carries an ambient **`RunContext`** (a `FiberRef`) — the identity and bounds that
thread down the tree:

```jsonc
{ "rootConversationId": "c3a…", "parentNodeId": "n_7f3", "depth": 1,
  "tokenPool": "<shared Ref<number>>", "modelOverride": "anthropic:claude-opus-4-8" }
```

`depth` is checked against `maxDepth` (default 2) before each spawn; `tokenPool` is one shared
`Ref<number>` every sub-agent in the turn's subtree draws from; `modelOverride` is set when a role
pins a model.

Siblings coordinate over the in-memory **bus** — two `Ref`-backed channels. A direct message and a
blackboard note are small records:

```jsonc
// send_message({ to: "n_7f3", content: "the schema moved — re-read before editing" })
{ "from": "n_2a1", "content": "the schema moved — re-read before editing", "at": 1750000000000 }
// blackboard_post({ note: "I own the SQLite adapter; leave migrations to me" })
{ "from": "n_2a1", "note": "I own the SQLite adapter; leave migrations to me", "at": 1750000000000 }
```

A mailbox exists only while its agent is running; the recipient drains it at its next turn boundary,
folding messages in as attributed `[inbox …]` user turns. None of this is serialized — it's all
`Ref`s in one process.

Every spawn also **persists** a node so the tree survives the process. A row in the context tree is:

```jsonc
{ "parentId": "n_7f3", "rootConversationId": "c3a…", "edgeKind": "spawned",
  "folder": "packages/core", "seed": { "kind": "task" }, "status": "ok",
  "returnSummary": "Added add() test; bun test green.",
  "filesChanged": ["packages/core/math.test.ts"],
  "usage": { "inputTokens": 18200, "outputTokens": 640, "cacheReadTokens": 16000 } }
```

The node's full message history lives in a companion table; `:tree` reads these rows to render the
fleet, and `seedFromNode` + `seedMode` (`resume` / `branch` / `handoff`) re-seed a new run from one.

## The seams

| Concern | Where |
| --- | --- |
| Composition root, mode dispatch | `code/src/main.ts` |
| The event vocabulary + hook→queue pump | `code/src/events.ts` |
| JSON-RPC server | `code/src/modes/rpc.ts` |
| Headless scheduler daemon | `code/src/modes/daemon.ts` |
| The per-request provider router | `adapters/src/llm/router.ts` |
| Store selection (SQLite / Postgres) | `adapters/src/database/migrator.ts` |
| Sub-agent spawn + bus + RunContext | `sdk-core/usecases/buildScopeRuntime.ts`, `sdk-core/usecases/agentBus.ts`, `sdk-core/usecases/runContext.ts` |
