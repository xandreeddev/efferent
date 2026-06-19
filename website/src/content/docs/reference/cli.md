---
title: CLI & modes
description: The efferent CLI — flags, the four run modes, and the in-TUI command vocabulary.
sidebar:
  label: CLI & modes
  order: 8
---

The bundled coding agent ships as the `@xandreed/code` npm package (binaries `efferent`, `eff`, `e`), a Bun bundle.
Install and run: see [Getting started](/docs/getting-started/).

## Modes

Mode resolves automatically: an argv prompt or piped stdin → `print`; a TTY → `tui`; else `print`.
`--mode <x>` overrides.

| Mode | Invocation | Behaviour |
| --- | --- | --- |
| `tui` | `efferent` | Interactive multi-pane terminal UI (default in a TTY). |
| `print` | `efferent "<prompt>"` · `-p` · stdin `-` | One-shot: final text on stdout, tool log on stderr. |
| `json` | `efferent --mode json "<prompt>"` | Same loop; every agent event as JSONL on stdout. |
| `rpc` | `efferent --mode rpc` | Bidirectional JSON-RPC over stdio (`agent.send`). |

## Flags

| Flag | Effect |
| --- | --- |
| `--mode <tui\|print\|json\|rpc>` | Force a mode. |
| `-p`, `--print` | Print mode. |
| `--resume <conversationId>` | Resume an existing session. |
| `--allow-bash` | Allow bash in non-interactive modes (the TUI always allows it, behind approval). |
| `--cwd <path>` | Override the workspace (defaults to the process cwd). |
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
