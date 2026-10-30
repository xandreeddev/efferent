# @xandreed/plugin-workspace

The machine an agent runs on, as core's `FileSystem` and `Bash` ports (`FileSystemLive` over `node:fs/promises`, `BashLive` over `node:child_process`, both provided by `localSystemPlugin`); the workspace tools the model calls through those ports (read, ls, find, grep, write, edit, bash: `workspaceToolsPlugin`); and the `SKILL.md` directory loader (`skillsDirectoryPlugin`). Node 24 and Bun, POSIX only (Linux and macOS: `/`-rooted paths, process groups, a `:`-separated `PATH`; not Windows); it imports `node:*`, never Bun's own APIs. Layer `plugin-workspace` in `foundry.config.ts` (core, `effect`, `effect/ai`, `node:`); its tests are the `plugin-workspace-tests` layer, which also imports runtime, sdk, evals, the agent loop, memory-window, sessions and tool discovery to run the tools end to end.

## Rules

- Change `FileSystem` or `Bash` behaviour by adding the check to core's kit (`fileSystemConformance`, `bashConformance`) first; both adapters here must then pass it on Bun and Node.
- Every doc of these tools says confinement is a guardrail against a model's mistakes, not a sandbox (`bash` is unconfined; a path can change between its check and its use), and that `grep` is not time-bounded (its regular expression runs synchronously in the host; only nested repetition is refused).
- Map a Node error code to an `FsReason` in `fsReasonOf` (`src/local-system.entity.functions.ts`) and nowhere else.
- Resolve the shell once, at layer build, from the parent `PATH`, with no fallback (`ShellMissing`; a host sets `shell: "sh"` itself); kill a command as its process group (spawned detached; `-pid`, SIGKILL), signalling the bare pid only before the exit.
- Put guidance for the model in the tool descriptions and the `workspace.environment` section, never in skill instructions (an always-on skill's never reach the model); every text the model reads is pinned exactly beside its source (see Model-facing text), so a change to one updates its pin, and new text adds one.
- `read` refuses a file over `maxFileBytes` unread, and sniffs an image only after the NUL probe calls the bytes binary (a text file may begin with `GIF89a`): the type comes from the bytes, `mediaTypeOf` (the name) only for `Binary`.
- Change a file only under its per-file lock (an `RcMap` of semaphores by real path, built with the runtime-scoped capability) and through a temporary file and a rename; in place when a rename would change the file's mode.
- Fail the skills directory with `HarnessError`s coded `skills.root`, `skills.limit` or `skills.files`, which `Agent.define` fails with as they are; an id clash with another capability is tool discovery's `skills.duplicate`.

## Public surface

- Local system: `localSystemPlugin`, `LocalSystemPluginLive`, `FileSystemLive`, `localFileSystem`, `BashLive`, `makeBash`, `LocalSystemConfig`, `localSystemDefaults`, `BashLiveOptions` (type), `fsReasonOf`.
- Workspace tools: `workspaceToolsPlugin`, `WorkspaceToolsPluginLive`, `workspaceTools`, `WorkspaceToolsConfig`, `workspaceToolsDefaults`, `WorkspaceToolName`, `WorkspaceSkillName`, `WORKSPACE_PERMISSIONS`, `workspaceToolSchemas`, the params and results (`ReadParams`/`ReadResult` … `BashParams`/`BashToolResult`, `TextEdit`, `LsEntry`, `GrepLine`, `GrepUnreadable`). How `edit` applies its edits (`applyTextEdits`, `normalizeLine`) stays inside the package.
- Skills directory: `skillsDirectoryPlugin`, `SkillsDirectoryPluginLive`, `loadSkillsDirectory`, `skillsCapability`, `SkillsDirectoryConfig`, `skillsDirectoryDefaults`, `SKILLS_CAPABILITY_ID`, `ALWAYS_SECTION_ID`.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests, the scripts and the docs import the three plugins, `localFileSystem` and `makeBash`, and the rest, which no first-party code imports, are tagged `@public` at their declarations.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `localSystemPlugin` | `@xandreed/plugin-workspace/local` | runtime | `@xandreed/core/FileSystem`, `@xandreed/core/Bash` | none | none |
| `workspaceToolsPlugin` | `@xandreed/plugin-workspace/tools` | runtime | none | `efferent/Capabilities` | `@xandreed/core/FileSystem`, `efferent/SessionEnvironment`; optional: `@xandreed/core/Bash` |
| `skillsDirectoryPlugin` | `@xandreed/plugin-workspace/skills` | runtime | none | `efferent/Capabilities` | `@xandreed/core/FileSystem`; optional: `efferent/SessionEnvironment` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| The seven tool descriptions (`toolDescriptions`), and the `limit` maxima of read, ls, find and grep (`toolParameters`; parameters carry no descriptions) | `src/workspace-tools.entity.functions.ts:50-58`, `:42-47` | exact: the seven under the defaults and under other limits, without `spillDir` and with an empty `exclude`, `src/workspace-tools.entity.functions.test.ts:139`, `:151`; `read` without `readImages` and at each image limit, `:115`, `:122`; each tool carries its description, `src/workspace-tools.adapter.test.ts:522`; structure: the four maxima, `src/workspace-tools.adapter.test.ts:522` |
| `workspace.environment` section (`environmentText`) | `src/workspace-tools.entity.functions.ts:61-72` | exact: every line, and the section without each tool's line and each clause, `src/workspace-tools.entity.functions.test.ts:171`, `:183` |
| Catalogue summaries of `workspace.read`, `workspace.edit`, `workspace.shell` (`read` is always on by default, so unlisted) | `src/workspace-tools.adapter.ts:22-24` | exact, `src/workspace-tools.adapter.test.ts:690` |
| Always-on skills section (`alwaysSkillsText`) | `src/skills/skills-directory.entity.functions.ts:68-78` | exact, `src/skills/skills-directory.entity.functions.test.ts:43` |
| Result views (`renderRead` … `renderBash`, the `compact*` views) | `src/workspace-tools.entity.functions.ts:141-242` | exact: every note and branch of each view and compact view, `src/workspace-tools.entity.functions.test.ts:209`, `:223`, `:231`, `:240`, `:250`, `:278`, the image notes, `:51`, `:72`, `:83`, `:95`, `:101`; through the tools, `src/workspace-tools.adapter.test.ts:65`, `:105`, `:146`, `:158`, `:181`, `:189`, `:266`, `:314`, `:392`, `:430`, `:504`, `:543`, `:574`, `:632` |
| `fileTooLargeHint` and the rejected-image hints | `src/workspace-tools.entity.functions.ts:116-119`, `:130-139` | exact, `src/workspace-tools.entity.functions.test.ts:130`, `:83`, `:95`, `:101`, `src/workspace-tools.adapter.test.ts:96`, `:168` |
| Refusals (`Failure` codes and messages) | `src/read-tools.adapter.ts:30-145`, `src/write-tools.adapter.ts:76-119`, `src/workspace-path.entity.functions.ts:15-167`, `src/text-edit.entity.functions.ts:32-99`, `src/text-search.entity.functions.ts:61-64`, `src/bash-tool.adapter.ts:146` (a `BashError`'s) | exact: read's, `src/workspace-tools.adapter.test.ts:65`, `:96`, `:168`; write's and edit's, `:266`, `:314`, `:346`; ls's, find's and grep's, `:392`, `:407`, `:430`; `NotAFile`, `:198`; `Protected`, `:249`, `src/workspace-path.entity.functions.test.ts:88`; bash's (the `BashError`'s reason and message, as they are), `src/workspace-tools.adapter.test.ts:599`; `OutsideWorkspace`, a dangling link, `WorkspaceMissing` and `fsFailure`'s, `src/workspace-path.entity.functions.test.ts:50`, `:61`, `:72`; the edit refusals, `src/text-edit.entity.functions.test.ts:33`; grep's pattern refusals (the engine's reason in a syntax error's), `src/text-search.entity.functions.test.ts:28` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/local-system.entity.ts`, `src/local-system.entity.functions.ts` | `LocalSystemConfig`; `fsReasonOf`, `removalPlace` (refuses the root and a last `.` or `..`; `remove` then works on the parent's `realpath` plus the last name), the shell lookup, the stdin errors ignored (`EPIPE`, `ERR_STREAM_DESTROYED`) |
| `src/file-system.adapter.ts`, `src/bash.adapter.ts`, `src/plugin.adapter.ts` | `FileSystemLive` (`glob` is core's `walkGlob` over `list`, never `fs.glob`: no dot entries on Node, links followed on Bun), `BashLive` (environment from `parentEnv` through core's `resolveBashEnv`; output relayed by `relayOutput` into a stream buffer of `OUTPUT_BUFFER` events, the pipe paused while it is full, so on Node a slow reader holds the command back, while Bun reads a child's pipes ahead; what is left after the exit read at once; a pipe error fails the stream; output pipes closed `exitGraceMs` after the exit), `localSystemPlugin`, `workspaceToolsPlugin` |
| `text-window`, `text-edit`, `text-search`, `workspace-path` (`src/<name>.entity.ts` + `.entity.functions.ts`) | the tools' pure parts: line windows, byte cuts, the NUL probe, the BOM; `applyTextEdits` (exact, unique, non-overlapping edits against the original, the normalised fallback, CRLF) and `unifiedDiff`; grep's lines, context, caps and nested-repetition refusal; confinement through the real path of the nearest existing ancestor, `protect`, `excludesBelow` |
| `src/workspace-tools.entity.ts` + `.entity.functions.ts`; `src/read-tools.adapter.ts`, `src/write-tools.adapter.ts`, `src/bash-tool.adapter.ts`, `src/workspace-tools.adapter.ts` | config, params and results, descriptions, the environment text, result views; the tools, each declaring the services it reads per call (`WORKSPACE_SERVICES`, `FileSystem` and `SessionEnvironment`; `bash` adds `Bash`), and the `workspace.environment` section, declaring the same per render (`definePromptSection`); `bash` folds `Bash.stream` into a tail, publishes `tool.progress` per `progressMs` and spills under `spillDir` keeping `spillKeep` files; `workspaceTools` assembles the capability (`workspace.read`; `workspace.edit` behind `fs.write`; `workspace.shell` behind `shell.exec`, left out without a `Bash` service) |
| `src/skills/` | `skillsDirectoryPlugin`: core's `collectSkillFiles` and `readSkillFiles` per root, roots resolved against the workspace, `idPrefix` and first-root-wins merge, `strict`, the limits, the always-on section |

## Tests

- Kits: `src/file-system.adapter.test.ts` and `src/bash.adapter.test.ts` run core's `fileSystemConformance` and `bashConformance` on Bun (the bash subject's `holdsBack` is off on Bun, which reads pipes ahead); `bun run verify:packages` runs both kits and the journey over the packed package on Bun and on Node (`node-imports.mjs`).
- `src/plugin.adapter.test.ts` (the local system as a plugin), `src/workspace-tools.adapter.test.ts` (the tools over a temporary directory), the pure pairs' tests (with fast-check properties), the key-free journey `src/workspace-tools.journey.test.ts` (`Agent.define` with a scripted model, an image `read` included) and `src/skills/*.test.ts` (an agent and a journey over a temporary directory). Run: `bun test packages/plugin-workspace`.

See the root AGENTS.md for the enforced rules and the definition of done.
