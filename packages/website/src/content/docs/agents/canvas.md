---
title: canvas — the page builder
description: Natural language in, interactive pages out — through one gated output channel. No React, no filesystem, no shell.
---

canvas builds **interactive pages** from natural language in a browser-served
studio. Its entire power is one tool: `render_ui`. There is no filesystem, no
shell, no code execution — structurally, not by prompt.

```bash
bun run canvas [--port <n>] [--open] [--resume <id>]
```

## One channel, always gated

Every `render_ui` call runs surface's deterministic UI gates; a violation
rejects the whole render **with the findings as data**, so the model fixes
exactly what the gate names in the same run. A reply that pastes HTML into
chat instead is detected and bounced with one corrective turn — the page IS
the deliverable, chat is a caption channel.

## Two kinds of interactivity

- **Agent work** rides htmx over a WebSocket: a button that asks the agent
  for something posts an `/action/`, the agent renders, the page updates.
- **Page-local state** (timers, toggles, tabs) is vendored Alpine.js —
  admitted by the sanitizer's alpine mode, its expressions checked by a
  dedicated gate family (no foreign APIs, no `x-html`), with a strict CSP as
  the browser backstop. A pomodoro timer ticks client-side without an agent
  turn.

Pages compose the `cv-*` design system — a curated component vocabulary the
prompt teaches, so output looks coherent instead of model-improvised. The
sanitizer forbids those prefixes in agent-authored fragments from spoofing
the shell's own chrome.
