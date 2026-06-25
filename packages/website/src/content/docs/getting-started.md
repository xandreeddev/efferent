---
title: Getting started
description: Install the efferent coding agent, log in a provider, and run your first prompt — then clone the repo to build your own agent on the SDK.
---

efferent is two things in one repo: a **coding agent** you can install and use today, and the
**SDK** that agent is built on. This page gets you running with both.

:::note
Bun is the runtime. Install it first if you haven't: see [bun.sh](https://bun.sh) (Bun ≥ 1.2).
efferent runs TypeScript directly — there is no build step for development.
:::

## Track 1 — Use the coding agent

The agent ships on npm as **`@xandreed/code`** (a Bun bundle; the binaries it installs are `efferent`, `eff`, and `e`).

```sh
npm i -g @xandreed/code
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

:::note
The SDK packages are workspace-internal today (not published standalone on npm). Build against a
clone of the repo; standalone packages may follow. The `efferent` CLI is the published artifact.
:::

## Next

- **[Your first agent](/docs/your-first-agent/)** — build the dice agent line by line.
- **[Concepts](/docs/concepts/architecture/)** — what the SDK leverages and why.
- **[Examples](/docs/examples/)** — the runnable files, rendered from source.
