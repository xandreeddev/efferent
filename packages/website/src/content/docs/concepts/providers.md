---
title: The multi-provider router
description: One LanguageModel port; provider and model resolved per request from your login and /model choice — a runtime concern, not a compile-time layer.
sidebar:
  label: Providers & models
  order: 4
---

The agent loop talks to one provider-agnostic `LanguageModel`. **Which** provider/model backs it is a
**runtime selection**, resolved on every call — never baked into a layer at build time.

## Per-request resolution

`RouterLanguageModelLive` reads the current model selection, resolves a key from the `AuthStore`
(refreshing a near-expiry OAuth token first), and builds the chosen provider's `@effect/ai` client
**per request** over a shared HTTP client. So a credential added mid-session with `:login`, or a `/model`
switch, takes effect on the **next turn** with no rebuild.

Supported providers: **Google** (Gemini), **OpenAI** (GPT / o-series), **Anthropic** (Claude, incl.
OAuth subscription), **OpenCode** (Kimi / DeepSeek / …), and **Ollama** (local).

## Selecting a model

Selection lives in settings as `model = "<provider>:<modelId>"` — the single source of truth, persisted
to `.efferent/config.json`. Pure helpers in `entities/Model.ts`:

```ts
formatModel("google", "gemini-3.5-flash")   // "google:gemini-3.5-flash"
parseModel("anthropic:claude-opus-4-6")      // { provider: "anthropic", modelId: "claude-opus-4-6" }
parseModel("gpt-4o")                          // bare id → provider inferred by shape
```

The live catalogue comes from `ModelRegistry.list()` (queried over raw HTTP for logged-in providers
only); context windows come from a generated catalogue snapshotted from [models.dev](https://models.dev).

## Two roles: main and fast

All **agentic** work runs on **main** (`settings.model`) — the root conversation *and* sub-agents
(delegation changes the context, not the brain). A second **fast** role (`settings.fastModel`; unset ⇒
main) backs one-shot helper calls reached via `UtilityLlm.complete(prompt, { role: "fast" })`: compaction
[middle digests](/docs/concepts/compaction/), the auto-approval judge, and session titles. Per-role
spend is tracked separately.

## Credentials

Keys live only in `~/.efferent/auth.json` (written by `:login`), never read from the environment on the
local path. The `AuthStore` port resolves them lazily per request. For CI/evals, `EnvAuthStoreLive` is the
**one** place provider key env vars are read. See [Getting started](/docs/getting-started/).

## Caching

Caching is aggressive but provider-native: OpenAI gets automatic prefix caching + a stable cache key,
Gemini relies on implicit context caching (stable prefix), and Anthropic gets explicit
`cache_control: ephemeral` breakpoints stamped by the router on the last system + last two messages every
call. This is exactly why [compression must keep the prefix byte-stable](/docs/concepts/compaction/).
