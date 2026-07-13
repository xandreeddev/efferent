# UI agent

The product is a reusable agent, not a bag of rendering tools:

```text
user request
  → pinned planner: manifest + IA + first component nodes
  → compact-line / JSONL / native-tool records
  → pinned composer: content, component props, theme / bounded repair
  → governed page graph + semantic theme
  → trusted component + token compiler
  → persisted HTMX fragments / CSP-Alpine behavior / accessible SVG
```

`@xandreed/ui-agent` owns the model-facing contract, orchestration, page-event,
component-catalog, theme, and host-capability ports. Start, block patch, prop
patch, component proposal, and theme patch records all invoke the same typed
toolkit handlers regardless of wire protocol.

`@xandreed/surface` owns trusted rendering. Its 60+ core components cover
layout, navigation, primitives, forms, application, marketing, documentation,
and feedback. Hosts supply validated semantic tokens and register assets,
typed queries, commands, and request identity. A missing anatomy can be
admitted as a fingerprinted workspace component only through the constrained
template AST—never raw markup, styles, attributes, or executable expressions.

Canvas is the reference host: localhost identity adapter, SQLite page/catalog/
theme state, a searchable design-system gallery and theme lab, HTMX-over-
WebSocket shell, CSRF/origin checks, CSP Alpine, and sanitized read-only replay
for legacy HTML events.

## Quality contract

- No model-authored HTML, CSS, utility classes, HTMX, Alpine expressions, SVG,
  JavaScript, arbitrary attributes, or remote URLs.
- Page archetypes have deterministic completeness rules and critical root
  slots; child nodes may arrive progressively through a flat adjacency graph.
- Invalid components, props, variants, behaviors, capabilities, assets,
  tokens, graph endpoints, oversized batches, and incomplete pages return
  precise semantic findings to the model and the eval trail.
- Reuse or add a variant before admitting a new component. Styling differences
  belong in themes. Fingerprints prevent equivalent structures from silently
  multiplying.
- Persistence precedes publication; catalog/token versions make resume stable.
- Targets are shell <250ms, first content delta <1.5s p95, meaningful browser
  UI <5s p95, and complete content <20s p95. Local content cannot satisfy them.
- Follow-ups interrupt the previous composition fiber and start an isolated
  attempt from the latest accepted page.

## Model and protocol selection

The reusable profile pins planner/composer/repair model, effort, budgets,
prompt/schema/recipe versions, fallback, and incremental protocol. The compact
line and A2UI-style JSONL protocols exist to avoid provider tool-argument
buffering; they are decoded incrementally and routed through the exact same
admission and persistence handlers as native tool calls.

Before pinning a profile, run `bun run evals:ui-matrix`. Its screening set
covers one landing, application, and document request across model, effort,
and protocol. `--task-set reference` expands to twelve application, landing,
and document products—including catalogs, workspaces, editorial sites,
runbooks, integration guides, and architecture decisions. Every trial uses the
real Canvas browser and persists raw timings, desktop/mobile screenshots, DOM
overflow, structured pages, and semantic failures under `.efferent/evals`.

```text
.25 Wilson90(valid complete refinement)
+ .20 Wilson90(first meaningful browser UI within 5s)
+ .15 design-system compliance
+ .15 information architecture
+ .10 request relevance
+ .10 exp(-p50 first-visible latency / 3s)
+ .05 repeated-sample consistency
```

Only successful finalists receive the fixed page-quality judge across
hierarchy, specificity, composition, and interaction quality. Failed providers
remain in the report. Add `--strict` only when an all-failed campaign must
return non-zero; use more than one sample before treating close scores as a
winner.
