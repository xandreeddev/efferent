---
title: Getting started
description: Install efferent, log in a provider, and run your first prompt — then clone the repo to build your own agent on the SDK.
---

efferent is two things in one repo: an **agent runtime** you can install and use today, and the
**SDK** it's built on. The runtime is one CLI that runs agents — an interactive TUI, headless
print/json/rpc, or a persistent per-workspace daemon — and it ships with a batteries-included coding
agent (`efferent code`). This page gets you running with both.

:::note
Bun is the runtime. Install it first if you haven't: see [bun.sh](https://bun.sh) (Bun ≥ 1.2).
efferent runs TypeScript directly — there is no build step for development.
:::

## Track 1 — Use the CLI

The CLI ships on npm as **`efferent`** (with a scoped alias **`@xandreed/cli`** — same bundle, kept in
sync); it's a Bun bundle that installs the binaries `efferent` and `eff`.

```sh
npm i -g efferent
efferent
```

That boots straight into the terminal UI. There's **no wizard, no `init`, and no env vars** —
you add a provider in-session:

1. Type `:login`.
2. Pick **Use a subscription** (OAuth — e.g. Claude Pro/Max, ChatGPT) or **Use an API key**.
3. Pick a provider (Anthropic / Google / OpenAI / OpenCode / Ollama).
4. Paste a masked key, or complete the browser OAuth flow.

The credential is written to `~/.efferent/auth.json` (atomic, `0600`) and is usable that turn —
no restart. The router resolves your key per request, so `:login` and `/model` switches apply
on the next message.

:::tip
`:logout <provider>` removes a credential. Credentials are read **only** from `~/.efferent/auth.json`
on the local path — efferent never reads provider keys from environment variables (that path exists
only for CI/evals; see [Providers](/docs/concepts/providers/)).
:::

### Subcommands

`efferent` runs agents through a small subcommand surface:

| Command | What it does |
| --- | --- |
| `efferent` | Default master TUI — attaches to (or spawns) the per-workspace daemon. |
| `efferent code` | The bundled coding agent — a focused single-fleet coder, in-process. |
| `efferent attach` | Explicitly attach the TUI to the daemon (auto-spawns it if absent). |
| `efferent daemon start` | Run the persistent daemon (alias `serve`). |
| `efferent daemon status` / `stop` | Daemon lifecycle. |

`EFFERENT_LOCAL=1` forces the in-process path; `EFFERENT_REMOTE` is the remote alias. See the
[CLI reference](/docs/reference/cli/) for the full surface.

### The four run modes

| Mode | How | What it does |
| --- | --- | --- |
| **tui** | `efferent` (in a TTY) | Interactive borderless terminal UI (the default). |
| **print** | `efferent "<prompt>"` or `-p` | One-shot: final text on stdout, tool log on stderr. |
| **json** | `efferent --mode json "<prompt>"` | Same loop, but every agent event as JSONL on stdout. |
| **rpc** | `efferent --mode rpc` | Bidirectional JSON-RPC over stdin/stdout. |

Non-interactive modes can't run `:login`, so they need a credential already in `auth.json`, and
bash is gated behind `--allow-bash`.

## Track 2 — Build on the SDK

The SDK (`@xandreed/sdk-core` + `@xandreed/sdk-adapters`) lives in the efferent monorepo and is
consumed as a workspace dependency — building your agent *inside the codebase* is the point, not an
accident. Clone the repo and install once:

```sh
git clone https://github.com/xandreeddev/efferent
cd efferent
bun install
```

Then run the bundled minimal example — a real agent with one tool:

```sh
bun examples/diceAgent.ts        # needs a credential in ~/.efferent/auth.json (Track 1, :login)
```

The [`examples/`](https://github.com/xandreeddev/efferent/tree/main/examples) folder is the fastest
way in — each file is a single, runnable agent that backs a page on this site:

```sh
cd examples
bun install
bunx tsc -p tsconfig.json        # typecheck every example (no credential needed)
bun calcAgent.ts                 # a multi-tool toolkit
bun fileAgent.ts                 # a tool that uses the FileSystem port
bun hooksAgent.ts                # observe and steer the loop with hooks
bun compressionAgent.ts          # customize context compression
```

### Run the eval suites

Once you have a provider key, run the built-in evals to see how the bundled coding agent scores on a labeled golden set:

```sh
bun run eval quality          # quality scorecard (5 golden scenarios)
bun run eval --max-cost 2.00  # all suites, with a cost budget
```

Evals skip cleanly if no key is present. See [Evaluating your agent](/docs/guides/evals-guide/) for how to read the scorecard, compare baselines, and write custom suites.

:::note
The SDK packages are workspace-internal today (not published standalone on npm). Build against a
clone of the repo; standalone packages may follow. The `efferent` CLI is the published artifact.
:::

## Next

- **[Your first agent](/docs/your-first-agent/)** — build the dice agent line by line.
- **[Evaluating your agent](/docs/guides/evals-guide/)** — run the eval suites, compare baselines, and write your own.
- **[Concepts](/docs/concepts/architecture/)** — what the SDK leverages and why.
- **[Examples](/docs/examples/)** — the runnable files, rendered from source.
