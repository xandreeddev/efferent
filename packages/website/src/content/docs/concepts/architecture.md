---
title: Architecture
description: Package boundaries and service composition in the agent SDK.
---

# Efferent — composable agents on Effect 4 for Node 24 and Bun

Efferent separates service contracts, runtime composition, session lifecycle,
and host presentation. See the [framework guide](/docs/concepts/harness/) for
the plugin and configuration APIs.

## Architecture

- `core`: shared schemas, ports and protocol helpers; no provider or host imports.
- `runtime` → core: plugin dependency graph and scoped plugin activation.
- `sdk` → runtime/core: `Agent.define` and `Agent.turn`, the composable agent over sessions.
- `plugin-*` → core: independently configurable capabilities, including the agent loop.
- `process-host` → core: a bounded, versioned stdio binding for a host-supplied TurnRunner, Sessions and optional Tasks; the host supplies its Agent, model/services and entry module.
- `evals`: tasks, trials, graders and suites; `evals-cli`, `evals-langfuse` and `evals-langsmith` add the local CLI and exporters.
- `foundry`: independent verification framework, no internal package dependencies.

All production packages participate in the zero-baseline architecture gates.
New session data uses `.efferent/runtime`; never delete old local data to reset it.
Build artifacts go under `.artifacts`; external-consumer checks exercise the
packed packages on Bun and Node without monorepo path aliases.

The directory session store (`plugin-session-files`) runs on Node 24 and Bun;
the SQLite adapter is Bun-only. The directory backend needs exclusive hard
links and atomic renames, and processes sharing it need clocks in step. Hosts
choose storage and explicitly authorize takeover and startup recovery.

The process host reuses the same turn, task and inbox services. It owns neither
model selection nor another work scheduler. A parent can submit durable input
while a turn is running; committed journal rows supply lifecycle events and
scoped turn subscriptions supply projected progress. See
[SDK and sessions](/docs/concepts/harness/) for composition and the
[process protocol guide](/docs/guides/process-protocol/) for the host entry
point and transport contract.
