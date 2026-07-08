# @xandreed/providers

**The new line's edge**: `Layer` implementations of `@xandreed/engine`'s
ports. Side effects live here and nowhere else. Depends on the engine +
external SDKs only — never on foundry, never on any old-line package.

## Layout

```
src/
├── auth/      LocalAuthStoreLive (the SAME ~/.efferent/auth.json vocabulary
│              the previous line writes — existing logins keep working;
│              read-through per call; anthropic OAuth refresh wired; set/remove for
│              :login/:logout — set writes GLOBAL, remove clears every tier) ·
│              anthropicOAuth (full protocol: PKCE begin/exchange + refresh)
├── settings/  LocalSettingsStoreLive — config.json two-tier merge (global
│              ~/.efferent + local <cwd>/.efferent, local wins); reads only
│              the model roles, preserves every other key; setRole writes/
│              clears one role key in the LOCAL file · roleModelView (a
│              role-scoped SettingsStore view: load maps model = role ?? model)
├── llm/       compat (generic OpenAI-compatible /chat/completions client —
│              opencode's gateway; v1 non-streaming) · providers (per-call
│              service construction: opencode/google/anthropic/openai;
│              anthropic cache breakpoints + Claude Code system block on
│              subscription auth) · retry (transient-only retries, 120s
│              timeout, empty-response rejection) · router
│              (LanguageModelLive — re-resolves selection + key per call) ·
│              utilityLlm (fast tier: fastModel ?? model, one-shot)
├── store/     SqliteConversationStoreLive — bun:sqlite, its OWN db file
│              (never the frozen line's efferent.db), atomic positions
├── fs/ shell/ LocalFileSystemLive · LocalShellLive (non-zero exit = result)
```

## Rules

- ZERO-entry ratchet baseline (no let/loops/nullable-returns/try-catch/…).
- Keys are never captured at layer build — resolved from `AuthStore` per
  call, so a login or model switch applies on the next request.
- Every layer is `<Thing>Live`; constructor-parameterized ones take `(cwd,
  home)` or a path — no env reading inside adapters.
- v1 simplifications (add when an agent needs them): no streaming, no
  generateObject, no patient outage ladder, no openai-OAuth/ollama, no model
  catalogue.

## Tests

`bun test packages/providers` — key-free: auth/settings file semantics on
temp dirs, the SQLite store's position + fold contract, the compat client
against an injected fake fetch, the retry classifier.
