# @xandreed/core

Shared schemas, service ports, message codecs and protocol helpers. Runtime
dependencies are Effect and the provider-neutral effect/ai contracts only.
No provider SDKs, filesystem IO, runtime graph, terminal, or host imports.

`src/loop` holds the References a step reads (`CurrentPromptCacheKey`,
`CurrentModelCallPolicy`, `CurrentAgentStep`, `CurrentTraceContent` with
`replayableContext`, `CurrentPromptProvenance`). `src/internal` holds what
the agent loop, the models plugin and the sdk share with core: the provider
mapping (`mapping.entity.functions.ts`), the stream fold, tool schemas, and
the JSON, glob and id helpers. `src/engine` holds the turn engine:
`TurnLive` (`turn.adapter.ts`), a turn's run and lifecycle
(`turn-run.usecase.functions.ts`, `turn-lifecycle.usecase.functions.ts`) and
its bus (`turn-bus.adapter.ts`).

The package has five entries, each an `index.ts` of explicit named exports:

| Entry | Holds | Semver | Who imports it (boundaries) |
|---|---|---|---|
| `@xandreed/core` (`src/index.ts`) | entities, ports, events and journal kinds, `define*`, errors and their guards, model-text frames, References, in-memory adapters | yes | every package |
| `./conformance` (`src/conformance/index.ts`) | every kit but the models plugin's, `ConformanceCheck`, `ConformanceFailure` and `check`, the helper a kit's checks are built with | yes | every package |
| `./internal` (`src/internal/index.ts`) | what first-party packages use of the provider mapping, the stream fold and tool schemas | none | plugin-agent-loop, plugin-models, sdk |
| `./engine` (`src/engine/index.ts`) | `TurnLive`, a turn's run and lifecycle, its bus | none; it moves into `@xandreed/sdk` in the next minor release | sdk |
| `./models` (`src/models/index.ts`) | `AuthStore`, `Credential`, `AuthError`, `SettingsStore`, `EngineSettings` and their kits | none; it moves into `@xandreed/plugin-models` in the next minor release | plugin-models |

A package reaches `./internal`, `./engine` or `./models` only when its
boundaries layer grants `core/<subpath>` (the core entry layer's
`restricted`). The root keeps each name these entries hold, deprecated
(`@deprecated Import from "@xandreed/core/<entry>".`), in the block at the
end of `src/index.ts`, until the next minor release: the conformance and
models names as re-exports, the `internal/` and `engine/` names declared
again (the same value, or a type of the same shape), since a root entry may
not re-export what those folders declare (`scripts/api-snapshot.ts`). A few
names declared there stay root API, not deprecated, because packages without
a grant use them: `compileGlob`, `globMatcher` and their types (the
workspace plugin), `harnessDefectsAsFailures` (the sessions plugin and the
agent loop), and `assistantModel` and `assistantUsage`.

Deprecated in this release and removed in the next minor one, each with an
`@deprecated` tag on its declaration: the session chassis (`makeSession`),
`src/spec`, `src/mcp` and `McpClient`, `AgentFailure` with its functions,
`Checkpoint`, `DecisionOutcome`, `defineAgent`, `defineConfig` and
`AgentDefinition`, `HarnessConfig.profile`, `profiles` and `Profile`, and
`EngineSettings.sandbox` and `viMode` (a settings file that holds them still
decodes). Behaviour does not change until they go.

The boundaries gate (`foundry.config.ts`) layers core by a file's role; a
file is in the first layer whose glob matches it:

| Layer | Files | May import |
|---|---|---|
| `core-model` | `*.entity.ts`; the References in `loop/` | nothing of core |
| `core-ports` | `ports/**` | model |
| `core-logic` | `*.entity.functions.ts`, `internal/**`, `turn/model-text.ts` | model, ports |
| `core` | everything else: adapters, harness, the memory session, prompt sections; and the entries (`**/index.ts`), which re-export every layer | model, ports, logic |
| `core-engine` | `engine/**` | model, ports, logic, core |
| `core-kits` | `*.conformance.ts` | model, ports, logic, core, engine: the step-loop and registry kits run turns over the engine |
| `core-tests` | `*.test.ts` | every layer, and `fast-check` and `bun:test`, which no other layer imports |

A port that needs a type from a functions file gets it from the entity file
(`LogQuery` is in `memory-log.entity.ts`); what code beneath the engine needs
does not live in it (`sessionAttributes` and `turnAttributes`, which the
in-memory log and the sessions plugin use, are session functions).

Plugin and configuration contracts live in `src/harness`; service tags live in
`src/ports`. Entity files contain schemas and derived types. Behavior belongs
in paired `.functions.ts` modules. `definePlugin` bridges typed Layers at the
explicit `plugin.adapter.ts` boundary: a layer may need only what its
`requires` lists, and `build` hands it the graph's untyped services through
`provideDeclared` (`src/harness/plugin.entity.functions.ts`), which checks
each declared key by key (`requires.missing`) and runs the work in the
caller's own context, never a captured one. A plugin that does not compile
against its declaration declares the service; never widen the layer's type
or cast it through. `defineTool` holds a tool's handler to its `requires`
the same way (`provideDeclared` under the tool's name, so the erased
`RegisteredTool.handler` needs nothing), and keeps the declared keys,
References aside, as `RegisteredTool.requires`: a registry checks them
when it opens a run's tools (`toolRegistryConformance`).
`definePromptSection` does the same for a section's `render` (its keys are
`PromptSection.requires`), so `PromptSection.render` needs nothing and the
turn renders sections where it is called, with no context of its own: a
section that reads services is built with it, and a render that lacks one
fails with `requires.missing`.

Tell a `HarnessError` (or another tagged error) by its tag and fields, with
`isHarnessError` (`src/harness/plugin.entity.functions.ts`), never with
`instanceof`: a host can load two copies of core, each with its own class,
and the other copy's errors would lose their codes. A failure's framework
code comes from `harnessCodeOf` (`src/harness/harness-code.entity.functions.ts`):
a `HarnessError`'s own, the code a begin refusal, `TurnClosed` or
`ReservedKind` stands for (`TAGGED_CODES`), a tagged error's own `code`,
never an untagged value's (a Node or SQLite error's `code` is `errorCodeOf`).
`HARNESS_CODES` is the published list of the codes the packages raise or
store: add a new one there, with its meaning in the event reference's
`ERROR_CODES` (`scripts/generate-event-reference.ts`, which fails on a
raised code the list lacks), and never rename or remove one; first-party
code builds a `HarnessError` of one with `harnessError(code, message, cause)`.
The writer and the ports on the turn's path over it fail with `TurnError`
(`src/session/sessions.entity.ts`), most of whose members have no `code`
field: match `TurnClosed`, `ReservedKind`, `SessionContended` and
`SessionLogError` by tag (`Effect.catchTag`), read a turn failure's code
with `harnessCodeOf`, and widen a port to `TurnError` only when its
implementations reach the writer. `isTurnError` tells one by its tag and
fields, from any copy of core: `harnessDefectsAsFailures` and the bus
restore one carried as a defect, and a loop or a registry lets one through
rather than wrap it. `PLUGIN_API_VERSION` is 3 since the writer raises the
tags; versions 1 and 2 still load. A `TurnRunner` (`Agent.turn`) fails a
turn that cannot begin with its `TurnBeginError` as it is, never a
`HarnessError` made from it (`turnConformance` checks `SessionBusy`).

The step loop lives in `@xandreed/plugin-agent-loop`, plugin activation in
`@xandreed/runtime`, sessions in `@xandreed/plugin-sessions`, and the
composable agent (`Agent.define`, `Agent.turn`) in `@xandreed/sdk`. Foundry
is independent and supplies deterministic verification when a host chooses it.

Port contracts ship as conformance kits (`*.conformance.ts`, each exported
from `src/conformance/index.ts`, the models plugin's from
`src/models/index.ts`). Run a port's kit against every adapter of it, and
when the port changes, on Node too (`verify:packages`). The kits share
the helpers in `src/conformance.functions.ts` (`check`, `expect`,
`fail`, `freshId`, `headerOf`, `atTime`), the step-loop and turn kits
`sameUsage`, the turn, sessions and memory kits the one-pixel image
`pixelPng`, and the sessions and task kits `kindsOf`, `settles` and
`eventually`; new kits use them too, and only `check` is exported
(`./conformance`). That file is test support for the kits, not an entity's behaviour,
so it is not paired with `conformance.entity.ts`.
Core has no adapter of `Sessions`, `Tasks` or `ToolRegistry`: their kits
(`sessionsConformance`, `tasksConformance`, `toolRegistryConformance`) run
in the plugins that implement them (`plugin-sessions` and
`plugin-session-sqlite`, `plugin-tasks`, `plugin-tool-discovery`), whose
tests also hold the kits' self-tests, careless wrappers of the plugin's own
adapter that must fail; `taskRunnerConformance` has its self-test here,
over fiber runners written in the test. The registry kit builds its turns
over `TurnLive` and a writer of its own that keeps the turn in memory: a
kit ships in the build, which leaves test code out (`*.test.*`, `testing`
modules and folders: `scripts/build-check.ts`), so it cannot import
`recordingTurnWriter`.

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
what `Sessions.begin` stores. A tool returns them inside its result: the
`ToolResult` entry keeps the encoded result whole and `MediaSlot`s into it
(an image is stored once), checked once by `toolResultMedia` when
`recordTail` writes it, and `renderLog` alone decides which images a request
sends (`RenderOptions.media`; an `OmitMedia` compaction, recorded by the
turn when a provider refuses an image, applies whatever the strategy).
Anything that turns a log into text (search, transcripts, traces,
fingerprints, estimates) goes through `elideMediaData` or
`userMessageText`, never the base64.

Text the model reads that no user typed uses the frames in
`src/turn/model-text.ts`: `hostNote` for a note the host adds as a
user-role message (`[Host note: …]`, never "system" or "source of
truth"), `framed(tag, text)` for untrusted text such as tool output,
transcripts and summaries (the tag inside it escaped in any case or
spacing), and `clipTo` / `clippedMarker` for a cut that says how much it
dropped. Pin every such text with an exact test beside it.

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
`Agent.turn`'s input, bus subscribers (`engine/turn-bus.adapter.ts`), a live layer's
dependencies (`makeLiveLayer`) and the session chassis's (`makeSession`).
It drops the trace and log state of the place it was captured: the parent
span, so spans nest where the replayed work runs; the span annotations and
links, and the log annotations and log spans, which would replace those of
that fiber (the turn's ids); the captured span's stack frame; and
`CurrentTraceContent`, which is read per call. The one deliberate
exception is `InProcessTaskRunnerLive` (`plugin-tasks`): it starts each
piece of work on a new fiber with the services it was built with, the
only ones that work has, so the work nests under the span current where the
runner was built and reads the trace content set there. The sdk tracer
tests (`packages/sdk/src/agent.trace.test.ts`) fail when a replay
re-parents `tool.*`, handler or `engine.run` spans or drops the turn's ids
from its spans or a tool handler's logs.

Span attributes and log annotations share their keys: `turnAttributes`
(`efferent.session.id`, `efferent.run.id`, `efferent.turn`) and
`sessionAttributes` (`src/session/sessions.entity.functions.ts`). `traceTurn`
(`src/engine/turn-lifecycle.usecase.functions.ts`) opens `agent.turn`;
`traceTurnBegin` opens `agent.turn.begin`, its sibling, around a begin. Put no span between `traceTurn` and `guardTurn`: a failed turn's
usage goes on the span current where `guardTurn` runs.

Core's own spans are `Effect.fn` and few: `turn.persist_reply` (`TurnLive`'s
`persistReply`, under `agent.turn`), `skills.collect` (`collectSkillFiles`)
and the in-memory log's `session_log.<op>`, with `efferent.session.id` when
the operation names a session. Everything else is `Effect.fnUntraced`: entity
functions and decoders; constructors (`make*`, and `openLogSession`, which
`TurnLive` runs between `traceTurn` and `guardTurn`); the views a turn's code
works with (`turnOf`, `stepRequestOf`); helpers called per event, step or
entry (`publishToolProgress`, the memory log's `append`, the step request's
`dispatch`); and the kits.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
