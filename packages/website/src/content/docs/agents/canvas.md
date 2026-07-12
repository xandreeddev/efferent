---
title: canvas — the governed UI agent host
description: Typed page data in, token-governed HTMX and Alpine layouts out—in under five seconds, without model-authored HTML.
---

Canvas is the first host for Efferent's reusable UI agent. A user describes a
landing page, an application workspace, or an architecture document; the fast
model selects a trusted recipe and generates the first typed blocks, then the
quality model completes the page.

```bash
bun run canvas [--port <n>] [--open] [--resume <id>]
```

## The model emits data, not templates

The internal `start_ui` and `patch_ui` tools accept only a versioned page
manifest and typed blocks such as `hero`, `feature-grid`, `form`, `data-table`,
`decisions`, and `architecture`. They have no HTML, CSS, classes, HTMX,
Alpine expressions, JavaScript, SVG, or URL fields.

Surface is the trusted compiler. It selects the standard landing, application,
or document recipe; applies the host's validated semantic tokens; escapes all
content; wires registered actions; and renders typed graphs as accessible SVG.

## Purpose-built model profile

Canvas does not inherit arbitrary global model roles. Its versioned execution
profile pins:

- a fast model planner for recipe, manifest, information architecture, and first blocks;
- one replaceable quality composer for remaining content and completion;
- one low-effort repair attempt driven by deterministic findings;
- prompt, schema, recipe-set, model, effort, token, timeout, and fallback
  versions.

Startup fails if that contract is incomplete or drifts from the code. Model
changes require the Canvas latency and quality battery to be re-run.

## Streaming and actions

The shell appears immediately, but no page content appears until `start_ui`
from a real model call passes admission. Model-authored blocks are persisted to
SQLite before publication and compiled to HTMX out-of-band fragments. Missing
model output remains a visible failure. Reconnect and resume fold the same events.

The composer runs outside the serialized send gate. A follow-up cancels the
in-flight enrichment and starts a new isolated attempt from the latest page,
so a slow provider cannot queue interaction or corrupt conversation history.

Hosts register typed queries and commands. The renderer—not the model—creates
their endpoints and fields. Inputs are decoded, authorized against the host
session, and run as Effects. Alpine is limited to trusted local behavior
recipes such as tabs and disclosure; the CSP build requires no `unsafe-eval`.

The latency contract is shell under 250ms, first meaningful model block under
two seconds p95, and a complete model-generated page under five seconds p95.
A slow or unavailable provider fails those gates; it is never hidden by local
content. Planner and composer latency and quality are measured separately. Initial browser
JavaScript remains under 120KB uncompressed; there is no Tailwind or Mermaid runtime.

Existing raw-HTML Canvas conversations can still be sanitized and displayed,
but they are read-only. New turns have no raw fallback.

Run the real pinned-model latency battery explicitly—it is heavy and never
rides the default keyed eval expansion:

```bash
bun run evals:live canvas --samples 20 --no-check
```

Profile selection begins with the model × reasoning-effort matrix:

```bash
bun run evals:ui-matrix --samples 1 --top 3
```

It covers recipe app, product landing, and architecture-document requests,
persists per-trial timings and page specs under `.efferent/evals`, and reports
usable-page latency separately from first accepted model-patch latency. Ranking
uses Wilson lower confidence bounds, design-system compliance, information
architecture, request relevance, latency decay, and repeated-sample
consistency; only finalists receive the hierarchy/composition/interaction
quality judge. Increase samples before treating close scores as a winner.

After reviewing latency and quality evidence, mint the first baseline with
`--update-baselines`; subsequent profile changes compare against it.
