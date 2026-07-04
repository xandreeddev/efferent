# @xandreed/web

The web UI's pure presentation layer: htmx fragments as server-rendered strings. The CLI's
web driver (`packages/cli/src/web/`) maps its view-models onto this package's structural prop
types and serves what this package renders — the dependency direction is strictly
`efferent (cli) → @xandreed/web → (nothing)`.

## Rules

- **Zero runtime dependencies.** Not even `@xandreed/sdk-core` — tool args/results are parsed
  structurally from `unknown` (the `toolDescribe.ts` discipline). If you think you need a dep,
  you're in the wrong package.
- **Never import from `efferent` (packages/cli) or any sibling.** The cli imports us.
- **No JSX.** The repo tsconfig pins `jsxImportSource: "@opentui/solid"`; this package is pure
  `.ts` — components are functions returning `Html` via the `html` tagged template.
- **Everything is a string.** No IO, no Effect, no DOM. Renderers are `(view, oob?) => Html`.
- **`raw()` appears in exactly two places**: the sanitizer's output (`sanitize.ts`) and vendored
  asset injection (`pages/shell.ts` / `assets/static.ts`). Anywhere else is a bug.
- **No hex colour literal outside `theme/palette.ts`**; `assets/app.css` (chrome) and
  `assets/kit.css` (the agent-facing `ef-*` vocabulary) paint only `var(--tok-*)` plus the
  theme-invariant scales (`--sp-*`/`--fs-*`/`--radius-*`, declared in app.css `:root`) — a test
  lints the served CSS for hex. The palettes are a **mirror of
  `packages/cli/src/cli/presentation/theme/palette.ts`** — change them together (marker comments
  on both sides; `WebSurfaces` incl. `shadow` is the web-only extension).
- Every `ef-*` class named in `docs/uiKit.ts` must exist in kit.css/app.css —
  `docs/uiKit.test.ts` enforces the doc↔css contract mechanically.
- DOM ids come from `ids.ts` (`domIdForKey` — injective, CSS-selector-safe). Identity keys mirror
  the TUI cache (`messageKey` positions, tool-call ids) so live-stream and history-projection
  fragments upsert to the same DOM node.
- OOB attributes (`hx-swap-oob`) are stamped in the component root, never by post-hoc string
  surgery; every top-level element of a WS message carries one explicitly.
- Vendored htmx (`src/assets/vendor/`) is pinned — version + sha256 recorded in each file's
  header comment and in `vendor/README.md`. Never edit vendored files.

## Layout

- `html.ts` — the `html` tagged template (auto-escape), `raw`, `join`, `render`.
- `ids.ts` — `domIdForKey` + the singleton region id constants (stage/tabs/drawers/dock included).
- `markdown.ts` — zero-dep markdown → `Html` (fences stamp `data-lang`; ```mermaid renders client-side).
- `sanitize.ts` — the allowlist sanitizer for `render_ui` (agent-authored) HTML. The security
  boundary; its attack-case tests are the spec. SVG stays banned — mermaid rides as SOURCE text.
- `derive.ts` — `deriveWorkspaceItem(toolName, args, ok, result)` → file/diff/plan/source cards.
- `theme/` — palette mirror, `WebTokens`, themes, `renderTokensCss()` (`--tok-*` custom props).
- `components/` — pure renderers: `page.ts` (a full-bleed `render_ui` page — sanitizes internally;
  the only seam where agent HTML crosses into markup), `tabs.ts` (the page tab bar), `activity.ts`
  (the phase/elapsed/interrupt strip), `reply.ts` (the latest-assistant bubble), plus message/
  toolPill (with `data-ref` click-to-open)/agents/plan/header/fileRef/diffCard/sourceCard/approval/
  queue/diffView/oob. `fragments/` — OOB append/upsert builders + `renderFullSync` (regions.ts is
  the anti-drift seam shared by shell + full-sync; drawer/stage/dock shells are shell-ONLY so
  client open/pin/dismiss state survives resyncs).
- `pages/shell.ts` — the full canvas-first document (stage + tabs + pages + empty hero, overlay
  drawers, floating dock with the command bar + hidden `page` viewing-context field);
  `protocol/` — path constants + client-message parsing (`page?` on chat, `withViewingContext`);
  `docs/uiKit.ts` — `RENDER_UI_KIT_DOC`, the agent-facing PAGE-builder reference;
  `assets/` — `app.css` (chrome), `kit.css` (the ef-* kit), `app.js` (client glue: drawers, tabs,
  refs, reply, activity ticker, scroll pin, resync), `diagrams.js` (the lazy mermaid pass —
  strict, token-themed, per-node error containment), vendored htmx + **mermaid.min.js 11.12.2**
  (~2.75MB, served lazily on first diagram), `static.ts` (the asset manifest the cli serves).

Tests are colocated (`*.test.ts`, bun:test).
