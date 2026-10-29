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
`fail`, `freshId`, `headerOf`, `atTime`), the step-loop and turn kits
`sameUsage`, and the sessions and task kits `kindsOf`, `settles` and
`eventually`; they are not exported, and new kits use them too. That file is test support for the kits, not an entity's behaviour,
so it is not paired with `conformance.entity.ts`.
Core has no adapter of `Sessions`, `Tasks` or `ToolRegistry`: their kits
(`sessionsConformance`, `tasksConformance`, `toolRegistryConformance`) run
in the plugins that implement them (`plugin-sessions` and
`plugin-session-sqlite`, `plugin-tasks`, `plugin-tool-discovery`), whose
tests also hold the kits' self-tests, careless wrappers of the plugin's own
adapter that must fail; `taskRunnerConformance` has its self-test here,
over fiber runners written in the test. The registry kit builds its turns
over `TurnLive` and a writer of its own that keeps the turn in memory: a
kit ships in the build, which leaves `testing.ts` files out, so it cannot
import `recordingTurnWriter`.

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

Images are `Media` values (`src/domain/media.entity.ts`): base64 inline,
checked from their bytes by `mediaFromBytes` / `mediaFromBase64` (the only
image sniffing and header parsing in the repository), within `MEDIA_LIMITS`.
A user's message carries them as `attachments`; `normalizeUserMessage` is
what `Sessions.begin` stores. Anything that turns a log into text (search,
transcripts, traces, fingerprints, estimates) goes through `elideMediaData`
or `userMessageText`, never the base64.

Skills as files: `harness/skill-files.entity.ts` and its functions read a
tree of `SKILL.md` files without IO (`readSkillFiles`, which never fails and
returns the issues; `skillsFromFiles`, strict) and collect one through the
`FileSystem` port (`collectSkillFiles`, over `glob`). The frontmatter parser
there is the skills' own YAML subset; `spec/frontmatter.ts` stays the flat
one the spec codec uses.

A context captured with `Effect.context()` to be provided again later,
around work that runs somewhere else, goes through `replayableContext`
(`src/loop/traceContent.ts`): the services tool handlers, policy and loop
callbacks run with (the registry, `stepRequestOf`, `turnOf`, `runLoop`),
a model layer's dependencies (the models plugin), the services of
`Agent.turn`'s input, bus subscribers (`turn-bus.ts`), a live layer's
dependencies (`makeLiveLayer`) and the session chassis's (`makeSession`).
It drops the trace state of the place it was captured: the parent span, so
spans nest where the replayed work runs; the span annotations and links,
which would replace those of that fiber (the turn's ids); and
`CurrentTraceContent`, which is read per call. The one deliberate
exception is `InProcessTaskRunnerLive` (`plugin-tasks`): it starts each
piece of work on a new fiber with the services it was built with, the
only ones that work has, so the work nests under the span current where the
runner was built and reads the trace content set there. The sdk tracer
tests (`packages/sdk/src/agent.trace.test.ts`) fail when a replay
re-parents `tool.*`, handler or `engine.run` spans or drops the turn's ids.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
