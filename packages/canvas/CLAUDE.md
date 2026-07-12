# @xandreed/canvas

Canvas is the first host for `@xandreed/ui-agent`, not the UI agent itself.

- `@xandreed/ui-agent/profiles/streaming-ui-v1` is the required, versioned execution profile. It pins
  planner/composer/repair models, effort, output budgets, timeouts, prompt
  versions, schema/recipe versions, and fallback. Never inherit global model
  roles or silently fill missing profile fields.
- The agent's internal channels are `start_ui` and `patch_ui`. Their payload is
  typed page/block data; Canvas must never add an HTML/CSS/class/HTMX/Alpine/
  SVG/URL parameter.
- `DefaultUiHostLive` registers tokens, standard recipes, assets, queries, and
  commands. Host capabilities decode, authorize, and run as Effects.
- `SqliteUiPageStoreLive` commits structured events before the browser sink.
  Resume folds these events; historical `ui_render` HTML is sanitized and
  replayed read-only, never exposed as a new authoring tool.
- The web edge compiles through Surface, streams HTMX OOB fragments, enforces
  same-origin + CSRF, and uses the CSP Alpine build. No Tailwind, Mermaid,
  React, filesystem, shell, or code tools.

Latency contract: shell <250ms; first meaningful model block <2s p95; complete
model-generated page <5s p95. Missing model output is a visible failure, never
a local content fallback. Keep an initial model refinement at 1–8 blocks and browser JS
under 120KB uncompressed. Profile changes require `bun run evals:ui-matrix`
followed by the sampled pinned-profile Canvas battery.

Model enrichment never holds the session send gate. A follow-up interrupts the
previous background fiber and starts from the latest persisted page; each
attempt uses an isolated child conversation so cancellation cannot corrupt
message alternation.
