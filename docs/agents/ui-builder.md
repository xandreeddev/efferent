# UI agent

The product is a reusable agent, not a bag of rendering tools:

```text
user request
  → pinned fast model: recipe + manifest + IA + first blocks
  → pinned quality model: remaining content / bounded repair
  → typed PageManifest + UiBlock patches
  → trusted token + recipe compiler
  → persisted HTMX fragments / CSP-Alpine behavior / accessible SVG
```

`@xandreed/ui-agent` owns the model-facing contract, orchestration, page-event
and host-capability ports, admission rules, and reference pages. `start_ui` and
`patch_ui` are its internal structured output channels.

`@xandreed/surface` owns trusted rendering. Standard v1 recipes cover a hero
landing, an application workspace, and an architecture document. Hosts supply
validated JSON tokens and register approved recipes, assets, typed queries,
commands, and request identity. They cannot register arbitrary templates in v1.

Canvas is the reference host: localhost identity adapter, SQLite page events,
HTMX-over-WebSocket shell, CSRF/origin checks, CSP Alpine, and sanitized
read-only replay for legacy HTML events.

## Quality contract

- No model-authored HTML, CSS, utility classes, HTMX, Alpine expressions, SVG,
  JavaScript, or remote URLs.
- Page archetypes have deterministic completeness rules and critical slots.
- Invalid IDs, capabilities, assets, graph endpoints, token values, oversized
  batches, and incomplete pages return precise repair findings.
- Persistence precedes publication; recipe/token versions make resume stable.
- Shell <250ms, first meaningful model block <2s p95, complete model-generated
  page <5s p95. A run that misses either model-dependent SLA fails; no local
  content fallback may satisfy these gates.
- Scripted scenarios prove the bounce, correction, latest-follow-up cancellation,
  DB trail, and all three archetypes. The opt-in live battery owns latency and
  visual/content quality baselines.

The live battery is intentionally explicit and heavy:
`bun run evals:live canvas --samples 20 --no-check`. Review the first run,
then mint or update its baseline in the same change as any profile revision.

Before pinning a model profile, run `bun run evals:ui-matrix`. It screens the
configured models across low/medium/high effort and all three archetypes,
persists raw trials under `.efferent/evals`, and ranks candidates with:

```text
.25 Wilson90(valid refinement)
+ .20 Wilson90(first accepted patch within 10s)
+ .15 design-system compliance
+ .15 information architecture
+ .10 request relevance
+ .10 exp(-p50 first-patch latency / 10s)
+ .05 repeated-sample consistency
```

The top candidates receive the fixed page-quality judge across hierarchy,
specificity, composition, and interaction quality. Its score is advisory at
screening size and becomes meaningful only after repeated samples; consistency
is reported as unknown/zero when only one sample exists.
