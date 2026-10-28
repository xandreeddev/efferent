---
title: Architecture
description: Package boundaries and service composition in the agent SDK.
---

# Efferent — composable agent SDK on Effect + Bun

Efferent separates service contracts, runtime composition, session lifecycle,
and host presentation. See the [framework guide](/docs/concepts/harness/) for
the plugin and configuration APIs.

## Architecture

- `core`: shared schemas, ports and protocol helpers; no provider or host imports.
- `runtime` → core: configuration, dependency graph and scoped plugin activation.
- `sdk` → runtime/core: sessions, replay, queues, cancellation and safe reconfiguration.
- `plugin-*` → core: independently configurable capabilities, including the agent loop.
- `evals`: tasks, trials, graders and suites; `evals-cli`, `evals-langfuse` and `evals-langsmith` add the local CLI and exporters.
- `foundry`: independent verification framework, no internal package dependencies.

All production packages participate in the zero-baseline architecture gates.
New session data uses `.efferent/runtime`; never delete old local data to reset it.
Build artifacts go under `.artifacts`; external-consumer checks exercise the
packed packages on Bun and Node without monorepo path aliases.
