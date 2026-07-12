---
title: Getting started
description: Clone the repo, log in a provider, and run the agents — smith, math, canvas, social — from source.
---

efferent is **a family of purpose-built agents on a shared kernel**, built in
public on Effect.ts + Bun. There is no npm install for the current line — the
agents are source-run from the repo, and that is deliberate: the repo *is* the
product, gates and evals included.

> The previously published npm package (`efferent`, the old CLI) remains on the
> registry but no longer receives updates. Everything current lives here.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — the only runtime.
- A model provider: an [opencode zen](https://opencode.ai) key, an Anthropic
  subscription or API key, a Google or OpenAI key.

```bash
git clone https://github.com/xandreeddev/efferent
cd efferent
bun install
bun run typecheck   # tsc + the repo's own gate suite — should end 0 findings
bun test
```

## Credentials and model selection

Credentials live in `~/.efferent/auth.json` (per-provider `api_key` / `oauth`
entries). The easiest way to write them is smith's own `:login` flow — boot the
TUI and follow the picker. Model selection comes from `.efferent/config.json`:

```json
{
  "model": "opencode:kimi-k2.6",
  "codeModel": "opencode:kimi-k2.7-code",
  "fastModel": "opencode:deepseek-v4-flash"
}
```

Local config merges over global (`~/.efferent/config.json`), and the three
roles are live: **general** drives conversation, **code** drives the forge
implementor, **fast** drives one-shot helpers like session titling.
`EFFERENT_MODEL` is deliberately ignored — a launch directory's `.env` must
never silently pick your model.

## Run the agents

```bash
bun run smith --cwd <dir>          # the coder: dashboard → refine → :lock → :forge
bun run math --grade 4 --open      # the tutor: server-graded practice in the browser
bun run canvas --open              # governed UI agent: natural language → typed, streamed pages
bun run social test|review         # the drafter: scan (supervised) · human review queue
bun run scenarios                  # the regression batteries
bun run foundry check              # the gate suite, standalone
```

Each agent persists its conversations to its own SQLite database under the
workspace's `.efferent/` — an auditable trail the scenario packs read back as
evidence.

## Where to go next

- [Architecture](/docs/concepts/architecture) — the package graph and the one
  dependency rule.
- [The harness doctrine](/docs/concepts/harness) — why gates declare victory.
- [smith](/docs/agents/smith) — the agent you'll probably run first.
