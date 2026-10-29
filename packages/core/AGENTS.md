# @xandreed/core

Shared schemas, service ports, message codecs and protocol helpers. Runtime
dependencies are Effect and the provider-neutral effect/ai contracts only.
No provider SDKs, filesystem IO, runtime graph, terminal, or host imports.

Plugin and configuration contracts live in `src/harness`; service tags live in
`src/ports`. Entity files contain schemas and derived types. Behavior belongs
in paired `.functions.ts` modules. `definePlugin` bridges typed Layers at the
explicit `plugin.adapter.ts` boundary.

The step loop lives in `@xandreed/plugin-agent-loop`, plugin activation in
`@xandreed/runtime`, sessions in `@xandreed/plugin-sessions`, and the
composable agent (`Agent.define`, `Agent.turn`) in `@xandreed/sdk`. Foundry
is independent and supplies deterministic verification when a host chooses it.

Port contracts ship as conformance kits (`*.conformance.ts`, each exported
from `src/index.ts`). Run a port's kit against every adapter of it, and when
the port changes, on Node too (`verify:packages`). The kits share
the private helpers in `src/conformance.functions.ts` (`check`, `expect`,
`fail`, `freshId`, `headerOf`, `atTime`), and the step-loop and turn kits
`sameUsage`; they are not exported, and new kits use them too. That file is test support for the kits, not an entity's behaviour,
so it is not paired with `conformance.entity.ts`.

The `FileSystem` and `Bash` ports are what agent tools work through. Core
ships the ports, the in-memory `FileSystemMemoryLive` and the two kits; the
disk-backed `FileSystemLive` and `BashLive` live in
`@xandreed/plugin-workspace`, since core does no file-system or process IO,
and run both kits on Bun and Node. `walkGlob`
(`src/domain/file-system.entity.functions.ts`, a sorted walk over the port's
`list`) is how every backend implements `glob`, so it means the same
everywhere; `fs.glob` differs between Bun and Node. `src/workspace` holds
the in-memory backend and the kits. `resolveBashEnv` is the one place the
inherited-environment allowlist is applied. `bashConformance` has no adapter
in core: its self-test runs it against fakes that run nothing.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
