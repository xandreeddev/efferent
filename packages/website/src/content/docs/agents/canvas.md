---
title: canvas — the governed UI agent host
description: Model-generated component graphs and semantic themes, compiled into trusted HTMX and Alpine surfaces.
---

Canvas is the first host for Efferent's reusable UI agent. A user describes a
landing page, application workspace, or architecture document; the planner
produces the information architecture and first governed component nodes, then
the composer fills content, component props, and semantic theme.

```bash
bun run canvas [--port <n>] [--open] [--resume <id>]
```

## The model emits a governed component graph

The agent retrieves a small request-relevant subset of a 60+ component core
catalog. Start, block-patch, prop-patch, component-proposal, and theme-patch
operations accept only versioned manifests, catalog component nodes, and
semantic tokens. They have no HTML, CSS, classes, arbitrary attributes, HTMX,
Alpine expressions, JavaScript, SVG, or URL fields.

Surface resolves the flat node graph, applies a scoped token theme, escapes all
content, wires registered actions, and renders typed graphs as accessible SVG.
If the catalog truly lacks an anatomy, the agent can propose a fingerprinted
workspace component using a bounded template AST. Equivalent structures reuse
an existing component or become a variant.

Canvas exposes `/design-system` as a searchable component gallery and theme
lab. Themes alter semantic color, derived shades, typography, spacing, borders,
radius, density, elevation, contrast, and motion without changing component
identity.

## Purpose-built model profile

Canvas does not inherit arbitrary global model roles. Its versioned execution
profile pins:

- a planner for manifest, information architecture, and first nodes;
- one replaceable composer for remaining content and completion;
- one bounded repair attempt driven by deterministic findings;
- prompt, schema, recipe-set, model, effort, token, timeout, incremental
  protocol, and fallback versions.

Startup fails if that contract is incomplete or drifts from code. Model and
prompt changes require the model × effort × protocol browser matrix.

## Streaming, actions, and follow-ups

The shell appears immediately, but no page content appears until a start record
from a real model call passes admission. Compact line records, A2UI-style JSONL,
and native tool calls are transports over the same handlers—not scripted page
generators. Every accepted node, prop, and theme event is persisted to SQLite
before publication and compiled to HTMX out-of-band fragments. Missing model
output remains a visible failure; reconnect and resume fold the same events.

The composer runs outside the serialized send gate. A follow-up cancels the
in-flight enrichment and starts an isolated attempt from the latest page, so a
slow provider cannot queue interaction or corrupt conversation history.

Hosts register typed queries and commands. The renderer—not the model—creates
their endpoints and fields. Inputs are decoded, authorized against the host
session, and run as Effects. Alpine is limited to trusted local behavior
recipes such as tabs and disclosure; the CSP build requires no `unsafe-eval`.

Targets are shell under 250ms, first content delta under 1.5 seconds p95, first
meaningful browser UI under five seconds p95, and complete content under 20
seconds p95. A slow or unavailable provider is recorded as a semantic failure;
it is never hidden by local content. Initial browser JavaScript remains under
120KB uncompressed; there is no Tailwind or Mermaid runtime.

Existing raw-HTML Canvas conversations can still be sanitized and displayed,
but they are read-only. New turns have no raw fallback.

## Model-backed evaluation

```bash
bun run evals:ui-matrix --samples 1 --top 3
```

The default matrix screens recipe application, product landing, and
architecture-document requests over model × effort × protocol candidates.
Pass `--task-set reference` to run the twelve-product corpus spanning catalogs,
workspaces, editorial marketing, runbooks, integrations, and architecture
decisions. Each trial submits through the actual Canvas browser form, observes
DOM paint, captures desktop/mobile screenshots and overflow, then reads the
SQLite page and failure trail. Ranking
uses Wilson lower confidence bounds, design-system compliance, information
architecture, request relevance, latency decay, and repeated-sample
consistency; only finalists receive the hierarchy/composition/interaction
quality judge.

Failed providers and runtime defects remain in the report as failed trial rows,
and every settled trial is saved to the evidence `trials/` directory as soon as
it finishes — a crashed campaign keeps its completed trials. Use `--strict`
only when an all-failed matrix should return non-zero, and increase samples
before treating close scores as a winner. The larger pinned-profile battery remains explicit:

```bash
bun run evals:live canvas --samples 20 --no-check
```
