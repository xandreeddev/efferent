---
title: CLI & modes
description: The efferent CLI — flags, the four run modes, and the in-TUI command vocabulary.
sidebar:
  label: CLI & modes
  order: 8
---

The efferent CLI ships as the **`efferent`** npm package (scoped alias **`@xandreed/cli`** — same
bundle, kept in sync; binaries `efferent` and `eff`), a Bun bundle. It runs agents: the default master
TUI, the bundled coding agent via `efferent code`, headless print/json/rpc, or a persistent daemon.
Install and run: see [Getting started](/docs/getting-started/).

## Subcommands

| Command | What it does |
| --- | --- |
| `efferent` | Default master TUI — attaches to (or spawns) the per-workspace [daemon](/docs/concepts/daemon/). |
| `efferent code` | The bundled coding agent — a focused single-fleet coder, in-process. |
| `efferent attach` | Explicitly attach the TUI to the daemon (auto-spawns it if absent). |
| `efferent daemon start` | Run the persistent daemon (alias `serve`; was `--mode daemon-serve`, still accepted). |
| `efferent daemon status` · `efferent daemon stop` | Daemon lifecycle. |
| `efferent verify` | Run the graded acceptance battery against a target (this tree, a commit, or a published release). See [verifying a build](/docs/guides/verify/). |
| `efferent eval` | Run the eval suites (forwarded to the evals runner; from a source checkout). |

`EFFERENT_LOCAL=1` forces the in-process path (the legacy daemonless driver); `EFFERENT_REMOTE` is the
remote alias. A bare prompt or `--mode <x>` (below) is the headless surface.

## Modes

Mode resolves automatically: an argv prompt or piped stdin → `print`; a TTY → `tui`; else `print`.
`--mode <x>` overrides.

| Mode | Invocation | Behaviour |
| --- | --- | --- |
| `tui` | `efferent` | Interactive borderless terminal UI (default in a TTY). |
| `print` | `efferent "<prompt>"` · `-p` · stdin `-` | One-shot: final text on stdout, tool log on stderr. |
| `json` | `efferent --mode json "<prompt>"` | Same loop; every agent event as JSONL on stdout. |
| `rpc` | `efferent --mode rpc` | Bidirectional JSON-RPC over stdio (`agent.send`). |
| `daemon` | `efferent --mode daemon` | Headless cron scheduler — fires this workspace's due jobs forever, no UI. |
| `daemon-serve` | `efferent daemon start` (alias `serve`; legacy `efferent --mode daemon-serve`) | The persistent per-workspace Workspace daemon (HTTP/SSE) that TUI/web clients attach to. Normally spawned automatically — `--mode daemon-serve` stays accepted as that auto-spawn target. See [the daemon](/docs/concepts/daemon/). |

## Flags

| Flag | Effect |
| --- | --- |
| `--mode <tui\|print\|json\|rpc\|daemon\|daemon-serve>` | Force a mode. |
| `-p`, `--print` | Print mode. |
| `--resume <conversationId>` | Resume an existing session. |
| `--allow-bash` | Allow bash in non-interactive modes (the TUI always allows it, behind approval). |
| `--cwd <path>` | Override the workspace (defaults to the process cwd). |
| `--fleet <rootSessionId>` | Attach the TUI to a specific fleet's coordinator (as `efferent attach` does); with several fleets and no `--fleet`, the daemon's active one is used. |
| `--help`, `--version` | Provided by `@effect/cli`. |

## In-TUI commands

Type `:` for the command menu. Common ones:

- **Session / context** — `:browse`, `:resume <#\|id>`, `:handoff`, `:context`, `:tree`, `:sessions`, `:build`.
- **Config** — `:login`, `:logout [provider]`, `:model` (and `:model fast`), `:effort`, `:search`, `:theme`,
  `:set <key> <value>`, `:settings`, `:db`.
- **Observability** — `:traces`, `:dashboard`.
- **Help** — `?` (or `:shortcuts` / `:keys`) for the shortcuts overlay.

Credentials and model selection are managed *in-session* — there is no `init` command and no env-var key
reading on the local path (see [providers](/docs/concepts/providers/)).
