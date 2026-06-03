# efferent

> A coding agent that lives in your terminal. **Effect.ts + Bun**, modal vim TUI, zero-config local history, multi-provider (Claude / Gemini / OpenAI), colocated evals. No Electron, no React, no Ink — just keystrokes, ANSI, and an Effect runtime.

```bash
npm i -g efferent          # requires Bun (https://bun.sh)
efferent                   # opens the TUI in the current project
                           # → press `:` then `login` to add a provider
```

That's it. No `init`, no wizard, no env-var dance. **`:login`** picks an OAuth subscription (Claude Pro/Max) or pastes an API key, persists to `~/.efferent/auth.json`, and the next message goes out — same turn, no restart.

```
  ┌─ conversation ─────────────────────────┐ ┌─ activity ─────┐
  │ ❯ fix the failing test in src/foo.ts    │ context  18k/1M │
  │                                         │ tok out    1.2k │
  │ ● I'll read the test first.             │ turns         3 │
  │   ● read_file src/foo.test.ts L1-80     │ ──── files ──── │
  │     ⎿  80 lines                         │ src/foo.ts +6/-2│
  │   ● edit_file src/foo.ts                │ ──── skills ─── │
  │     ⎿  +6/-2                            │ ▸ commit-style  │
  │   ● Bash `bun test src/foo.test.ts`     │ ─ instructions ─│
  │     ⎿  exit 0 · 1.2s                    │ ▸ AGENT.md (3)  │
  │ ● Fixed — the regex was anchored too…   │                 │
  └─────────────────────────────────────────┘ └────────────────┘
  ┌─ nav ─ Ctrl-hjkl panes · : cmd · / find · z zoom ─────────┐
  │ conv ─ j/k scroll · gg/G ends · {/} turns · v/y yank ─────│
  └───────────────────────────────────────────────────────────┘
  ┌─ input ─ INSERT ─────────────────────────────── conversation · NORMAL ─┐
  │ run the tests                                                          │
  └────────────────────────────────────────────────────────────────────────┘
   gemini-3.5-flash · 18k (12k cached) / 1M · sqlite · ~/proj
   logs: ~/.efferent/efferent.log · Esc NORMAL · i INSERT
```

## Why efferent

- **Effect substrate, all the way down.** Ports and adapters are Layers, tools are an `@effect/ai` `Toolkit`, conversations live in `ConversationStore`. Every error is tagged. Every IO goes through a port. Swap a provider by swapping a Layer.
- **Modal vim TUI, hand-rolled.** Three panes (conversation / activity / input), per-pane accent colours, real block cursor, charwise + linewise VISUAL with OSC 52 yank, foldable turns, foldable tool groups, expandable tool output (`Ctrl-R`). No mouse-mode hijacking — your terminal's native click-drag selection still works.
- **Multi-provider router.** One `LanguageModel` port; the active provider/model is resolved **per request** from `~/.efferent/auth.json` + your `:model` choice. Anthropic OAuth (Claude Pro/Max subscription) is wire-complete (live round-trip still being verified). Gemini's `thought_signature` round-trips correctly across turns.
- **Zero-config storage.** SQLite at `~/.efferent/efferent.db` by default. Postgres optional via `:db pg <url>` (or `EFFERENT_DB_URL`). Migrations bundle into the binary.
- **Skills + instruction files.** Drop `.md` files in `.efferent/skills/` — names + one-liners auto-inject into the system prompt; bodies lazy-load via `read_skill({name})`. `AGENT.md` (and `AGENT.local.md`) discovered from cwd up to home.
- **Web tools, no extra key.** `web_fetch` (HTTP + HTML→text) and `search_web` (Google or OpenAI **server-side** grounding — uses whichever provider you've logged in).
- **Sub-agent delegation.** Nested `SCOPE.md` files in your repo become `delegate_to_<scope>` tools — a focused sub-agent writes only in its directory, returns a summary, and bills its tokens into the parent's activity tree.
- **Handoff + context curation.** `:handoff` summarises the loaded view, writes a checkpoint, keeps originals untouched. `:context` opens a tree of turns + handoffs you can select and `:build` into a fresh session.
- **Headless modes too.** `--print` for one-shots, `--mode json` for JSONL events, `--mode rpc` for bidirectional JSON-RPC over stdio — same loop, different renderer.

## Install

Requires [Bun](https://bun.sh) at runtime (≥ 1.2). The npm package is a single self-contained Bun bundle.

```bash
npm i -g efferent
# or
bun add -g efferent
```

Then:

```bash
efferent                                 # full TUI (default in a TTY)
efferent "summarise packages/core"       # one-shot print mode
efferent --mode json "ls"                # stream JSONL events
efferent --mode rpc                      # JSON-RPC over stdio
efferent --resume <conversationId>       # continue an existing session
efferent --allow-bash                    # allow bash in non-interactive modes
efferent --cwd <path>                    # override the workspace
```

## Add a provider

From the TUI:

```
:login                  # pick subscription (OAuth) or API key
                        # → pick a provider (Claude / Gemini / OpenAI)
                        # → browser flow OR paste a masked key
:model                  # list the live catalogue, switch
:logout <provider>      # remove a credential
```

Or seed from the env at first launch: `EFFERENT_MODEL=openai:gpt-4o efferent` (anything explicit set via `:model` wins thereafter).

Credentials live **only** in `~/.efferent/auth.json` (atomic `0600` writes). Non-interactive modes can't run `:login`, so they require a credential already on disk.

## Skills

Drop a `.md` file under `.efferent/skills/` (per-project) or `~/.efferent/skills/` (global):

```markdown
---
name: commit-style
description: How to write a commit message for this repo.
---

(detailed procedure)
```

Names + one-liners inject into the system prompt at startup. Bodies are lazy-loaded by the model via `read_skill({name})` when relevant. Closer-to-cwd shadows farther on name collisions.

## Sub-agent scopes

Drop a `SCOPE.md` in any subdirectory:

```markdown
---
name: adapters
description: Owns packages/adapters/. Concrete implementations of @efferent/core ports.
---

(directory rules, layering, naming conventions)
```

The parent agent gets a `delegate_to_adapters` tool. The sub-agent inherits the toolkit, can only **write** inside its directory, runs in a fresh context window, and returns a one-line summary + `filesChanged`. Token usage rolls up into the activity tree.

## Develop

```bash
git clone https://github.com/xandreeddev/agent && cd agent
bun install
bun run typecheck && bun test         # the only correctness gates (no build step for dev)
bun packages/cli/src/main.ts          # run from source — Bun runs .ts directly
bun run build                         # bundle the CLI → packages/cli/dist/efferent.js
bun run eval [name …]                 # run eval suites (key-gated, no Docker)
```

Layout:

```
packages/
├── core/       pure domain — entities, ports, use cases, prompts (effect + @effect/ai only)
├── adapters/   Layer impls of core ports — provider SDKs + IO live here
├── cli/        composition root + four modes + hand-rolled TUI
└── evals/      Effect-native eval framework + the agent's suites
```

The dependency direction is strictly inward: `cli` → `adapters` → `core`. `core` imports nothing from siblings; `adapters` wraps one SDK per port; the driver composes the Layers at the edge and hands off to `BunRuntime.runMain`.

## Docs

- **[`AGENT.md`](./AGENT.md)** — architecture reference + conventions (the authoritative project doc).
- **[`docs/roadmap.md`](./docs/roadmap.md)** — what's deferred, what's in scope, what we're consciously skipping.
- **[`docs/comparison.md`](./docs/comparison.md)** — up-to-date feature comparison against Claude Code + pi.
- Per-package `SCOPE.md` (in `packages/*/`) — internal contracts for each scope.

## Tech

`effect@3.21` · `@effect/ai@0.35` (provider-agnostic) · `@effect/ai-google@0.14` · `@effect/ai-openai@0.39` · `@effect/cli@0.75` · `@effect/platform-bun@0.89` · `bun ≥ 1.2`. SQLite via `bun:sqlite`; Postgres via the bundled Effect adapter; raw mode + ANSI + Bun streams for the TUI.

## License

MIT.
