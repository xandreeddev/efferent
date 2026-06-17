<p align="center">
  <img src="https://raw.githubusercontent.com/xandreeddev/efferent/main/assets/logo-code.svg" alt="efferent &lt; code &gt;" width="520">
</p>

> A coding agent that lives in your terminal. **Effect.ts + Bun**, a modal multi-pane TUI (OpenTUI + SolidJS — no React, no Ink, no Electron), zero-config local history, multi-provider with subscription OAuth, context compression that never breaks the prompt cache, and sub-agent orchestration over a persistent context tree.

```bash
npm i -g @xandreed/code    # requires Bun (https://bun.sh); bin: efferent / eff
efferent                   # opens the TUI in the current project
                           # → type :login to add a provider
```

That's it. No `init`, no wizard, no env vars. **`:login`** picks a subscription (OAuth — Claude Pro/Max, OpenAI) or an API key (Anthropic / Google / OpenAI / OpenCode / Ollama), persists to `~/.efferent/auth.json`, and the next message goes out — same turn, no restart.

```
 ▌efferent  ⠹ Bash(bun test) 4s   ◆ 2 agents · fix parser, audit cli
 ┌─ Fix the failing foo test ──────────────┐  ┌─ activity ───────────┐
 │ ❯ fix the failing test in src/foo.ts    │  │ ctx ░░ 2% 18k/1M     │
 │                                         │  │ 1.2k out · 3 turns   │
 │ ● I'll read the test first.             │  │ Σ main 17k · fast 1k │
 │                                         │  │ ▾ ❯ fix the failing… │
 │ ▸ read · grep · edit  (3 tools, +6 -2)  │  │   ▾ turn 1  42 tok   │
 │                                         │  │     ✓ read_file(foo… │
 │ ● Bash(bun test src/foo.test.ts)        │  │     ✓ edit_file(foo… │
 │   ⎿ exit 0                              │  │ ── workspace ──      │
 │                                         │  │ src/foo.ts +6 -2     │
 │ ● Fixed — the regex was anchored too…   │  │ ▸ skills (2)         │
 └─────────────────────────────────────────┘  └──────────────────────┘
 ┌─ input · INSERT ───────────────────────────────────────────────────┐
 │ run the full suite                                                 │
 └────────────────────────────────────────────────────────────────────┘
  gemini-3.5-flash · fast gemini-3.1-flash-lite ░░ 2% 18k/1M · 86% cached · sqlite · ~/proj
```

## Why efferent

- **Effect substrate, all the way down.** Ports and adapters are Layers, tools are an `@effect/ai` `Toolkit`, every error is tagged, every IO goes through a port. Swap a provider by swapping a Layer.
- **Multi-provider router, per-request.** One `LanguageModel` port; the active provider/model resolves on every call from `auth.json` + your `:model` choice — a login or model switch applies on the next turn, no rebuild. Anthropic (API key or Claude Pro/Max OAuth), Google, OpenAI (API key or Codex OAuth), OpenCode (Kimi), Ollama.
- **Prompt caching on all three majors.** OpenAI automatic + `prompt_cache_key`; Gemini implicit; Anthropic via auto-placed `cache_control` breakpoints (caching there is opt-in per request — most clients silently get none). The status bar shows the live `% cached`.
- **Model roles, not model ids.** All agentic work runs on **main**; helper calls (compression digests, approval judgments, session titles) run on **fast** (`:model fast`). The activity pane carries a per-role spend ledger: `Σ main 64k · fast 1k`.
- **Context compression that respects the cache.** Provider caches key on a byte-stable prefix, so history is never rewritten. Oversized tool results are compressed **once, at append time** — grep floods grouped per file with exact counts, build logs keep errors + stack traces + summaries, everything else gets a head/tail clip — always behind a **reversible marker** that tells the model how to retrieve what was dropped, plus a fast-tier digest of the omitted middle. At 85% of the window the session auto-folds via handoff: one deliberate prefix rebuild, then the cache is warm again.
- **Sub-agents over a persistent context tree.** One generic `run_agent` tool spawns a folder-scoped sub-agent — writes and bash confined to its folder, that folder's `SCOPE.md` injected as ambient context. Every spawn persists as a node: **resume** it, **branch** it, or **handoff** (seed a fresh context with a generated brief — continuity at a fraction of the tokens). `:tree` browses the whole branching history — switch sessions, preview any node, fork it into a new conversation, or type into it to resume in place. Independent folders fan out in parallel; all sub-agents in a turn share one token budget; nodes are stamped with the git HEAD they saw and get a staleness brief when the repo moved.
- **Approval without prompt fatigue.** An unmatched bash command is first classified by a fast-tier judge against the **permitted folders** (workspace root + whatever you've granted): ordinary work inside is allowed silently; anything reaching outside escalates to a modal that grants *the folder*, once. Denials (with your typed reason) return to the model as data it course-corrects on. `:set autoApprove off` for always-ask; headless modes keep the static `--allow-bash` gate.
- **Handoff + context curation.** `:handoff` folds the loaded history into a summary checkpoint (originals untouched, cumulative across folds). `:context` shows turns + checkpoints as a selectable tree — pick units, `:build` a fresh session from exactly them.
- **A real TUI.** Foldable turns and tool groups, markdown prose, syntax-highlighted code + diffs (tree-sitter), vim-style fold cursor + `/` search in every pane, mouse drag-select with OSC 52 yank, live agent state in the header, themes (`:theme`), session titles, resumable conversations with a startup picker.
- **Headless modes.** `efferent "<prompt>"` for one-shots, `--mode json` for JSONL events, `--mode rpc` for bidirectional JSON-RPC over stdio — same loop, different renderer.
- **Skills + instruction files.** Drop `.md` files in `.efferent/skills/` — names auto-inject into the system prompt, bodies lazy-load on demand. `AGENT.md` discovered from cwd up to home.
- **Web tools, no extra key.** `search_web` uses your logged-in provider's server-side grounding; `web_fetch` reads the source.
- **Zero-config storage.** SQLite at `~/.efferent/efferent.db` by default; Postgres optional (`:db pg <url>`).

## Install

Requires [Bun](https://bun.sh) ≥ 1.2. The npm package is a Bun bundle with two runtime dependencies (`@opentui/core` — the native terminal renderer loads via FFI — and `web-tree-sitter`); everything else is inlined.

```bash
npm i -g @xandreed/code     # or: bun add -g @xandreed/code  (bin: efferent / eff)
```

```bash
efferent                                 # full TUI (default in a TTY)
efferent "summarise packages/sdk-core"   # one-shot print mode
efferent --mode json "ls"                # stream JSONL events
efferent --mode rpc                      # JSON-RPC over stdio
efferent --resume <conversationId>       # continue a session headlessly
efferent --allow-bash                    # allow bash in non-interactive modes
efferent --cwd <path>                    # override the workspace
```

## Add a provider

```
:login                  # subscription (OAuth) or API key → pick a provider
:model                  # live model catalogue; :model fast for the helper role
:logout <provider>      # remove a credential
```

Credentials live **only** in `~/.efferent/auth.json` (atomic `0600` writes). Non-interactive modes require a credential already on disk.

## Everyday commands

| | |
|---|---|
| `:handoff` | fold history into a summary checkpoint |
| `:context` | browse + select turns/checkpoints, `b` builds a new session |
| `:tree` | the agent tree — sessions, sub-agent nodes, preview/fork/resume |
| `:sessions` | every conversation in this workspace, `↵` switches |
| `:settings` / `:set` | live-tunable knobs (budgets, compression, auto-approval…) |
| `:theme` | efferent · one-dark · tokyo-night |
| `Esc` | interrupt the running turn (sub-agents included) |
| `Ctrl-h/j/k/l` | move between panes · `v` cycles the side views |

## Skills

```markdown
---
name: commit-style
description: How to write a commit message for this repo.
---

(detailed procedure)
```

Drop it in `.efferent/skills/` (per-project) or `~/.efferent/skills/` (global). Names + one-liners inject at startup; bodies lazy-load via `read_skill({name})`. Closer-to-cwd shadows farther on name collisions.

## Sub-agents

```
run_agent({ name, folder, task, seedFromNode?, seedMode? })
```

The sub-agent gets the full toolkit but only **writes** inside `folder` (bash is cwd-bound there too), runs in its own persisted context, and returns a summary + files changed + a node id. `seedMode: "resume" | "branch" | "handoff"` continues, forks, or briefs from an earlier node. A `SCOPE.md` in any folder is standing context for whoever works there.

## Develop

```bash
git clone https://github.com/xandreeddev/efferent && cd efferent
bun install
bun run typecheck && bun test         # the correctness gates (no build step for dev)
bun packages/code/src/main.ts         # run from source — Bun runs .ts directly
bun run build                         # bundle → packages/code/dist/efferent.js
bun run eval [name …]                 # eval suites (key-gated)
```

```
packages/
├── core/       pure domain — entities, ports, use cases, prompts (effect + @effect/ai only)
├── adapters/   Layer impls of core ports — provider SDKs + IO live here
├── cli/        composition root + four modes + the OpenTUI/SolidJS TUI
└── evals/      Effect-native eval framework + the agent's suites
```

Dependency direction is strictly inward: `cli` → `adapters` → `core`. Tests are colocated (`bun test`, 440+, incl. property-based tests via effect's fast-check integration).

## Docs

- **[`AGENT.md`](./AGENT.md)** — the authoritative architecture reference.
- **[`docs/roadmap.md`](./docs/roadmap.md)** — what's deferred and what we're consciously skipping.
- **[`docs/models.md`](./docs/models.md)** — every LLM call site, its model selection, where the spend lands.
- **[`docs/tui.md`](./docs/tui.md)** — the full TUI manual.
- **[`docs/journeys.md`](./docs/journeys.md)** — user journeys + their verification status.

## Tech

`effect` · `@effect/ai` (+ `-anthropic`, `-google`, `-openai`) · `@effect/cli` · `@effect/platform-bun` · `@opentui/core` + `@opentui/solid` + `solid-js` · `bun:sqlite` / Postgres · tree-sitter for highlighting. **Bun ≥ 1.2.**

## License

[MIT](./LICENSE)
