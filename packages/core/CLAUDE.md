# @xandreed/core

Shared schemas, service ports, message codecs and protocol helpers. Runtime
dependencies are Effect and the provider-neutral @effect/ai contracts only.
No provider SDKs, filesystem IO, runtime graph, terminal, or host imports.

Plugin and configuration contracts live in `src/harness`; service tags live in
`src/ports`. Entity files contain schemas and derived types. Behavior belongs
in paired `.functions.ts` modules. `definePlugin` bridges typed Layers at the
explicit `plugin.adapter.ts` boundary.

The agent loop implementation lives in `@xandreed/plugin-agent-loop`, plugin
activation in `@xandreed/runtime`, and durable sessions in `@xandreed/sdk`.
The older generic session chassis remains for existing domain hosts. Foundry
is independent and supplies deterministic verification when a host chooses it.

See the root AGENT.md for the enforced zero-baseline rules and checks.
