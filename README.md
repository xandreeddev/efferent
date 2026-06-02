# efferent

A coding agent CLI on **Effect.ts + Bun** — modal TUI, zero-config SQLite history, multi-provider (Gemini/OpenAI), colocated evals. No React. Built in public.

```bash
# requires Bun (https://bun.sh)
npm i -g efferent          # or: bun add -g efferent
efferent init              # set up ~/.efferent (API key, default model)
efferent                   # full TUI in the current project
efferent "fix the failing test in src/foo.ts"   # one-shot print mode
```

History persists to `~/.efferent/efferent.db` (SQLite) with no setup; set `EFFERENT_DB_URL` to use Postgres instead.

## Develop

```bash
bun install
bun run typecheck && bun test
bun packages/cli/src/main.ts        # run from source (Bun runs .ts directly)
bun run build                       # bundle → packages/cli/dist/efferent.js
```
