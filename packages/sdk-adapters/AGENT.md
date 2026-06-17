# @efferent/adapters

Concrete implementations of `@efferent/core` ports. Side effects live here and nowhere else.

## Layout

One subfolder per concern:

- `llm/` — the multi-provider model tier: `router.ts` (`RouterLanguageModelLive` — resolves provider + key **per request**), `providers.ts` (`makeProviderLanguageModel` for Google / OpenAI / Anthropic incl. OAuth + cache breakpoints; `openAiCodex.ts`, `openCode.ts`, `ollama.ts` variants), `modelRegistry.ts` (live catalogue), `utilityLlm.ts` (fast helper tier), `webSearch.ts` (provider-server-side grounding).
- `auth/` — `local.ts` (`LocalAuthStoreLive`: `~/.efferent/auth.json`, atomic `0600` writes, OAuth refresh), `env.ts` (`EnvAuthStoreLive` — evals/CI only; the *only* place provider key env vars are read), `oauth/anthropic.ts` (PKCE protocol).
- `database/` — `migrator.ts` (store selection: SQLite default, Postgres via `EFFERENT_DB_URL`), `conversationStore/` + `contextTreeStore/` (SQLite + Postgres impls), `migrations/`.
- `settings/` — `local.ts` (project + global `config.json`).
- `fs/`, `shell/`, `http/` — local FileSystem / Shell / Http port impls.

## Rules

- Each adapter is a `Layer` named `<Thing>Live` providing exactly one port (or a bundle like `ModelLive` that merges a tier).
- External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Never let an untyped error escape.
- Keys are never captured at layer build — resolve from `AuthStore` per call so `:login` / `:model` apply on the next request without a rebuild.
- Adapters may depend on `@efferent/core` and external SDKs only. Never import from `@efferent/cli` or other adapters' internals.
- Migrations are registered in `migrator.ts` via `Migrator.fromRecord` (bundle-safe) — one record per store flavor.
