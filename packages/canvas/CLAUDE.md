# @xandreed/canvas

**The ui-builder agent** (`bun run canvas [--port <n>] [--resume <id>] [--open]`):
a browser-served canvas where the agent builds interactive PAGES with natural
language. First greenfield consumer of the new line — engine chassis +
providers edge + surface substrate; NEVER touches the old packages
(boundaries-gated).

## The harness (docs/agents/ui-builder.md, on the new line)

- **One output channel**: `render_ui` (id/title/html/mode/active). The
  handler runs surface's deterministic UI gates on EVERY call — a finding
  rejects the whole render with the findings as feedback
  (`failureMode: "return"`), so the model fixes exactly what the gate names
  in the same run. Size cap 128KB → "stream with append".
- **Sanitizer at render time**: agent HTML crosses into markup at exactly one
  seam (`sanitizeHtml` in `web/render.ts`). Chrome ids/classes live on the
  `ef-`/`ui-` prefixes the sanitizer forbids in agent content — the shell
  can't be spoofed.
- **No filesystem, no shell, no code tools** — structural, not prompt-level.
- **Two kinds of interactivity**: page-LOCAL state (timers, toggles, tabs)
  is vendored Alpine.js — sanitize's alpine mode admits the directives,
  validateUi's `alpine-expr` family bans foreign APIs in expressions, and a
  strict CSP on the shell is the browser backstop (no external connects).
  AGENT work stays htmx `/action/` posts. The `cv-*` design system in
  app.css is the component vocabulary the prompt teaches.
- **Chat is a caption channel**: a reply that pastes HTML as chat text is
  detected (`looksLikeHtmlDump`) and corrected with ONE bounded follow-up
  turn — the pomodoro-as-snippet failure can't recur silently.
- **Replay ≡ live**: the WS pump folds the session ledger through the same
  `reduceEvent` on connect and live (`foldLedger` pins it in tests).

## Layout

```
src/
├── prompt.ts    the general page-builder identity (pages, not chat replies)
├── toolkit.ts   render_ui + makeCanvasHandlers(sink) — the gate chokepoint
├── session.ts   engine makeSession; CanvasEvent = LoopEvent | ui_render
├── web/         state (pure fold) · render (fragments; the sanitize seam) ·
│                shell · server (Bun.serve: htmx-over-WS broadcast pump,
│                POST /action/chat + /action/ui → session.send)
└── main.ts      composition root (providers at the edge)
assets/          app.css/app.js chrome + pinned vendored htmx/ws-ext/tailwind
```

v1 simplifications: binds 127.0.0.1 only (no boot token), no mermaid, no
reference drawer, chrome tabs client-side only. Vendored: htmx + ws ext +
tailwind runtime + alpinejs (pinned in vendor/README.md).

## Tests

`bun test packages/canvas` — key-free: the gate chokepoint (clean render /
UiRejected findings / HtmlTooLarge), the model fold (replace/append, focus
rules, busy/error). Live scenarios are Playwright-driven (see docs/agents/).
