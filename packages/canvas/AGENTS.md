# @xandreed/canvas

Canvas is the first host for `@xandreed/ui-agent`, not the UI agent itself.

- `@xandreed/ui-agent/profiles/streaming-ui-v1` is the required, versioned execution profile. It pins
  planner/composer/repair models, effort, output budgets, timeouts, prompt
  versions, schema/recipe versions, incremental protocol, and fallback. Never
  inherit global model roles or silently fill missing required profile fields.
- The agent's internal channels are start, block patch, prop patch, component
  proposal, and theme patch operations. Their payload is governed typed data;
  Canvas must never add an HTML/CSS/class/HTMX/Alpine/SVG/URL parameter.
- `DefaultUiHostLive` registers tokens, standard recipes, assets, queries, and
  commands. Host capabilities decode, authorize, and run as Effects.
- `SqliteUiPageStoreLive`, `SqliteUiComponentCatalogLive`, and
  `SqliteUiThemeStoreLive` own durable page, catalog/usage, and theme state.
  Commit structured events before the browser sink. Resume folds these events;
  historical `ui_render` HTML is sanitized and replayed read-only.
- `/design-system` is the trusted catalog and theme lab. Its fixtures and
  controls are host-owned previews, not a model content fallback. Keep its
  JavaScript outside the initial Canvas critical path.
- The web edge compiles through Surface, streams HTMX OOB fragments, enforces
  same-origin + CSRF, and uses the CSP Alpine build. No Tailwind, Mermaid,
  React, filesystem, shell, or code tools.

Latency targets: shell <250ms; first content delta <1.5s p95; first meaningful
browser UI <5s p95; complete model-generated content <20s p95. Missing model
output is a visible failure, never a local fallback. Keep each block batch at
1–8 nodes and browser JS under 120KB uncompressed. Profile changes require the
sampled model × effort × protocol matrix through the real Canvas browser path.

Model enrichment never holds the session send gate. A follow-up interrupts the
previous background fiber and starts from the latest persisted page; each
attempt uses an isolated child conversation so cancellation cannot corrupt
message alternation.
