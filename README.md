# efferent

A coding agent CLI on **Effect.ts + Bun** — modal TUI, zero-config SQLite history, multi-provider (Gemini/OpenAI/Claude), colocated evals. No React. Built in public.

```bash
# requires Bun (https://bun.sh)
npm i -g efferent          # or: bun add -g efferent
efferent                   # full TUI in the current project — then :login
efferent "fix the failing test in src/foo.ts"   # one-shot print mode (needs a prior :login)
```

`efferent` boots straight into the TUI. Add a provider in-session with **`:login`** — pick a **subscription** (OAuth: Claude Pro/Max) or an **API key**, choose the provider, and it works that turn with no restart. Switch models anytime with `:model`; `:logout <provider>` removes a credential. Credentials live only in `~/.efferent/auth.json` (no env vars, no `init`). History persists to `~/.efferent/efferent.db` (SQLite) with no setup; the status bar shows the active store. Switch to Postgres (or another SQLite path) with `:db pg <url>` (add `global` to apply everywhere) or the `EFFERENT_DB_URL` env var (env wins) — config is layered, so a folder can override the global.

## Develop

```bash
bun install
bun run typecheck && bun test
bun packages/cli/src/main.ts        # run from source (Bun runs .ts directly)
bun run build                       # bundle → packages/cli/dist/efferent.js
```
