---
name: web
description: Owns packages/web/. htmx + SSE driver for the notes flow (not the coding agent). Local-only; no auth, no script-sanitisation. Do not expose publicly.
---

## What this is
Bun + `@effect/platform-bun` HTTP server. Routes call `runAgent(notesAgentConfig, ...)` and a second-pass `renderUi` via `LlmFast` (the cheap tier). The chat UI is htmx + Server-Sent Events; no React.

## Layout
```
src/
├── main.ts            HttpRouter + Layer composition + BunHttpServer
├── routes/
│   ├── index.ts       static index page
│   └── chat.ts        SSE stream endpoint — calls runAgent + renderUi
└── views/             template fragments (vocabulary: recipe-card, capture-card, empty-state)
```

## Hard rules
- htmx + SSE for interactions. No React, no SPA framework.
- ETA / typed template strings for rendering. Server-rendered HTML.
- Same composition-root rule as `@agent/cli`: route handlers call `@agent/core` use cases; Layers (adapters + `BunContext`) are provided at the edge.
- The web flow uses `notesAgentConfig`, not `coderAgentConfig`. Scoped sub-agents are coder-only.
- `LlmFast` powers `renderUi` (second-pass HTML rendering) and `capture` (extraction). The agent loop still uses smart-tier `Llm`.
- Local-only: don't add auth, don't sanitise HTML, don't expose to the public internet.
