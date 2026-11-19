---
"@xandreed/core": minor
"@xandreed/sdk": minor
---

0.23.0 replaces the engine of earlier releases with the kernel: a small core
(a journal, sessions and events) and every other part a plain Effect layer.
There is no `Agent.define`, no plugin graph and no loop to configure: a host
composes the layers it needs, with `Layer.provideMerge` or `Effect.provide`,
and writes its own loop over `modelAnswer` and `callTool`, which each store
what they produce. The release publishes six packages: `@xandreed/core`,
`@xandreed/sdk` (with its Node entry, `@xandreed/sdk/node`),
`@xandreed/evals`, `@xandreed/evals-cli`, `@xandreed/evals-langfuse` and
`@xandreed/evals-langsmith`. The eighteen packages of the engine
(`@xandreed/runtime`, `@xandreed/process-host` and the sixteen
`@xandreed/plugin-*`) are no longer published; "Removed" says what replaces
each, and "Migration" shows a program. The guide is `docs/kernel.md`, the
tutorial the learn track on the docs site, and each decision has its ADR
under `docs/adr/`.
