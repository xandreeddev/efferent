<p align="center">
  <img src="../../assets/logo-sdk.svg" alt="efferent { sdk }" width="520">
</p>

# @xandreed/sdk-adapters

> Concrete `Layer` implementations of the [`@xandreed/sdk-core`](../sdk-core) ports. **Every side effect lives here and nowhere else.**

The middle ring of the architecture: `adapters` depends on `core` + the external SDK each adapter wraps, and never on the CLI. Each adapter is a `Layer` named `<Thing>Live` providing exactly one port (or a bundle like `ModelLive` that merges a tier).

## Layout — one subfolder per concern

- **`llm/`** — the multi-provider model tier. `router.ts` (`RouterLanguageModelLive` — resolves provider + key **per request**), `providers.ts` (Google / OpenAI / Anthropic incl. OAuth + cache breakpoints), `openAiCodex.ts` · `openCode.ts` · `ollama.ts` variants, `modelRegistry.ts` (live catalogue), `utilityLlm.ts` (the fast helper tier), `webSearch.ts` (provider server-side grounding).
- **`auth/`** — `local.ts` (`LocalAuthStoreLive`: `~/.efferent/auth.json`, atomic `0600` writes, OAuth refresh), `env.ts` (`EnvAuthStoreLive` — evals/CI only; the *only* place provider key env vars are read), `oauth/anthropic.ts` (PKCE).
- **`database/`** — `migrator.ts` (store selection: SQLite default, Postgres via `EFFERENT_DB_URL`), `conversationStore/` + `contextTreeStore/` (SQLite + Postgres impls), `migrations/`.
- **`settings/`**, **`fs/`**, **`shell/`**, **`http/`** — `config.json` settings + the local FileSystem / Shell / Http port impls.

## Rules

- External promises go through `Effect.tryPromise`, mapped into the port's tagged error — never let an untyped error escape.
- **Keys are never captured at layer build** — resolve from `AuthStore` per call, so `:login` / `:model` apply on the next request without a rebuild.
- Depend on `@xandreed/sdk-core` + external SDKs only. Never import from the CLI or another adapter's internals.
- Migrations register in `migrator.ts` via `Migrator.fromRecord` (bundle-safe) — one record per store flavor.

Part of [**efferent**](../../README.md) — a coding agent on Effect.ts + Bun.
