# @agent/core

Pure domain. Only runtime dependency: `effect`.

## Contents

- `domain/` — Schema-backed types (e.g., `Classification`). Pure values; no behavior beyond decode/validation.
- `ports/` — `Context.Tag` services describing capabilities the application needs from the outside world. Each port file pairs a `Data.TaggedError` (or several) with the Tag declaration.
- `src/index.ts` — public surface; everything other packages import comes through here.

## Rules

- Never import from `@agent/adapters`, `@agent/application`, `@agent/cli`, or `@agent/web`.
- Never import an IO library — no `ai`, no `@ai-sdk/*`, no `fs`, no `node:*`. If a use case needs a capability, declare a port; do not reach for an SDK directly.
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID so Effect's diagnostics stay useful: `Context.Tag("@agent/core/Llm")`.
