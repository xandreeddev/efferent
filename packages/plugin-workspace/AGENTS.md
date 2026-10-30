# @xandreed/plugin-workspace

The machine an agent runs on, as core's `FileSystem` and `Bash` ports (`FileSystemLive` over `node:fs/promises`, `BashLive` over `node:child_process`, both provided by `localSystemPlugin`); the workspace tools the model calls through those ports (read, ls, find, grep, write, edit, bash: `workspaceToolsPlugin`); and the `SKILL.md` directory loader (`skillsDirectoryPlugin`). Node 24 and Bun, POSIX only (Linux and macOS: `/`-rooted paths, process groups, a `:`-separated `PATH`; not Windows); it imports `node:*`, never Bun's own APIs. Layer `plugin-workspace` in `foundry.config.ts` (core, `effect`, `effect/ai`, `node:`); its tests are the `plugin-workspace-tests` layer, which also imports runtime, sdk, evals, the agent loop, memory-window, sessions and tool discovery to run the tools end to end.

## Rules

- Change `FileSystem` or `Bash` behaviour by adding the check to core's kit (`fileSystemConformance`, `bashConformance`) first; both adapters here must then pass it on Bun and Node.
- Every doc of these tools says confinement is a guardrail against a model's mistakes, not a sandbox (`bash` is unconfined; a path can change between its check and its use), and that `grep` is not time-bounded (its regular expression runs synchronously in the host; only nested repetition is refused).
- Map a Node error code to an `FsReason` in `fsReasonOf` (`src/local-system.entity.functions.ts`) and nowhere else.
- Resolve the shell once, at layer build, from the parent `PATH`, with no fallback (`ShellMissing`; a host sets `shell: "sh"` itself); kill a command as its process group (spawned detached; `-pid`, SIGKILL), signalling the bare pid only before the exit.
- Put guidance for the model in the tool descriptions and the `workspace.environment` section, never in skill instructions (an always-on skill's never reach the model); most of that text is unpinned or pinned with `toContain`, so a change to one adds its exact pin.
- `read` refuses a file over `maxFileBytes` unread, and sniffs an image only after the NUL probe calls the bytes binary (a text file may begin with `GIF89a`): the type comes from the bytes, `mediaTypeOf` (the name) only for `Binary`.
- Change a file only under its per-file lock (an `RcMap` of semaphores by real path, built with the runtime-scoped capability) and through a temporary file and a rename; in place when a rename would change the file's mode.
- Fail the skills directory with `HarnessError`s coded `skills.root`, `skills.limit` or `skills.files`, which `Agent.define` fails with as they are; an id clash with another capability is tool discovery's `skills.duplicate`.

## Public surface

- Local system: `localSystemPlugin`, `LocalSystemPluginLive`, `FileSystemLive`, `localFileSystem`, `BashLive`, `makeBash`, `LocalSystemConfig`, `localSystemDefaults`, `BashLiveOptions` (type), `fsReasonOf`.
- Workspace tools: `workspaceToolsPlugin`, `WorkspaceToolsPluginLive`, `workspaceTools`, `WorkspaceToolsConfig`, `workspaceToolsDefaults`, `WorkspaceToolName`, `WorkspaceSkillName`, `WORKSPACE_PERMISSIONS`, `workspaceToolSchemas`, the params and results (`ReadParams`/`ReadResult` … `BashParams`/`BashToolResult`, `TextEdit`, `LsEntry`, `GrepLine`, `GrepUnreadable`), `applyTextEdits`, `normalizeLine`.
- Skills directory: `skillsDirectoryPlugin`, `SkillsDirectoryPluginLive`, `loadSkillsDirectory`, `skillsCapability`, `SkillsDirectoryConfig`, `skillsDirectoryDefaults`, `SKILLS_CAPABILITY_ID`, `ALWAYS_SECTION_ID`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `localSystemPlugin` | `@xandreed/plugin-workspace/local` | runtime | `@xandreed/core/FileSystem`, `@xandreed/core/Bash` | none | none |
| `workspaceToolsPlugin` | `@xandreed/plugin-workspace/tools` | runtime | none | `efferent/Capabilities` | `@xandreed/core/FileSystem`, `efferent/SessionEnvironment`; optional: `@xandreed/core/Bash` |
| `skillsDirectoryPlugin` | `@xandreed/plugin-workspace/skills` | runtime | none | `efferent/Capabilities` | `@xandreed/core/FileSystem`; optional: `efferent/SessionEnvironment` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| The seven tool descriptions (`toolDescriptions`), and the `limit` maxima of read, ls, find and grep (`toolParameters`; parameters carry no descriptions) | `src/workspace-tools.entity.functions.ts:44-52`, `:36-41` | contains: read's image sentence and limit, `src/workspace-tools.entity.functions.test.ts:107`, `:112`, `src/workspace-tools.journey.test.ts:155`; grep's `limit` sentence and the four maxima, `src/workspace-tools.adapter.test.ts:485`; the rest of the six unpinned |
| `workspace.environment` section (`environmentText`) | `src/workspace-tools.entity.functions.ts:55-66` | contains: the heading and the root line, `src/workspace-tools.journey.test.ts:120`; the rest unpinned |
| Catalogue summaries of `workspace.read`, `workspace.edit`, `workspace.shell` (`read` is always on by default, so unlisted) | `src/workspace-tools.adapter.ts:22-24` | contains: `workspace.edit`'s, `src/workspace-tools.journey.test.ts:120`; the others unpinned |
| Always-on skills section (`alwaysSkillsText`) | `src/skills/skills-directory.entity.functions.ts:62-72` | exact, `src/skills/skills-directory.entity.functions.test.ts:43` |
| Result views (`renderRead` … `renderBash`, the `compact*` views) | `src/workspace-tools.entity.functions.ts:134-234` | exact: read window, image, binary and rejected-image notes, write, edit, ls, grep with context, grep's unreadable files, exit code (`src/workspace-tools.adapter.test.ts:64`, `:140`, `:183`, `:261`, `:305`, `:366`, `:400`, `:467`, `:504`; `src/workspace-tools.entity.functions.test.ts:42`, `:74`, `:93`); contains: lossy, ls cut, skipped files, timeout, output cut (`src/workspace-tools.adapter.test.ts:99`, `:366`, `:400`, `:521`, `:534`, `:580`); unpinned: find's notes, grep's caps and no-match line, the clipped-line and empty-file notes, the other compact views |
| `fileTooLargeHint` and the rejected-image hints | `src/workspace-tools.entity.functions.ts:109-112`, `:123-132` | exact, `src/workspace-tools.entity.functions.test.ts:120`, `:74`, `:93`, `src/workspace-tools.adapter.test.ts:162`; contains (`TooManyPixels`), `src/workspace-tools.entity.functions.test.ts:86` |
| Refusals (`Failure` codes and messages) | `src/read-tools.adapter.ts:30-145`, `src/write-tools.adapter.ts:76-119`, `src/workspace-path.entity.functions.ts:15-159`, `src/text-edit.entity.functions.ts:32-99`, `src/text-search.entity.functions.ts:61-64`, `src/bash-tool.adapter.ts:148` (a `BashError`'s) | codes: `src/workspace-tools.adapter.test.ts:64`, `:192`, `:216`, `:261`, `:305`, `:366`, `src/text-edit.entity.functions.test.ts:24`, `src/workspace-path.entity.functions.test.ts:41`, `:51`; exact messages: `FileTooLarge` (`src/workspace-tools.adapter.test.ts:162`), `Protected` (`:244`); contains: grep's pattern refusals, `src/text-search.entity.functions.test.ts:20`; every other message, `WorkspaceMissing` and bash's unpinned |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/local-system.entity.ts`, `src/local-system.entity.functions.ts` | `LocalSystemConfig`; `fsReasonOf`, `removalPlace` (refuses the root and a last `.` or `..`; `remove` then works on the parent's `realpath` plus the last name), the shell lookup, the stdin errors ignored (`EPIPE`, `ERR_STREAM_DESTROYED`) |
| `src/file-system.adapter.ts`, `src/bash.adapter.ts`, `src/plugin.adapter.ts` | `FileSystemLive` (`glob` is core's `walkGlob` over `list`, never `fs.glob`: no dot entries on Node, links followed on Bun), `BashLive` (environment from `parentEnv` through core's `resolveBashEnv`; output relayed by `relayOutput` into a stream buffer of `OUTPUT_BUFFER` events, the pipe paused while it is full, so on Node a slow reader holds the command back, while Bun reads a child's pipes ahead; what is left after the exit read at once; a pipe error fails the stream; output pipes closed `exitGraceMs` after the exit), `localSystemPlugin`, `workspaceToolsPlugin` |
| `text-window`, `text-edit`, `text-search`, `workspace-path` (`src/<name>.entity.ts` + `.entity.functions.ts`) | the tools' pure parts: line windows, byte cuts, the NUL probe, the BOM; `applyTextEdits` (exact, unique, non-overlapping edits against the original, the normalised fallback, CRLF) and `unifiedDiff`; grep's lines, context, caps and nested-repetition refusal; confinement through the real path of the nearest existing ancestor, `protect`, `excludesBelow` |
| `src/workspace-tools.entity.ts` + `.entity.functions.ts`; `src/read-tools.adapter.ts`, `src/write-tools.adapter.ts`, `src/bash-tool.adapter.ts`, `src/workspace-tools.adapter.ts` | config, params and results, descriptions, the environment text, result views; the tools, each declaring the services it reads per call (`WORKSPACE_SERVICES`, `FileSystem` and `SessionEnvironment`; `bash` adds `Bash`); `bash` folds `Bash.stream` into a tail, publishes `tool.progress` per `progressMs` and spills under `spillDir` keeping `spillKeep` files; `workspaceTools` assembles the capability (`workspace.read`; `workspace.edit` behind `fs.write`; `workspace.shell` behind `shell.exec`, left out without a `Bash` service) |
| `src/skills/` | `skillsDirectoryPlugin`: core's `collectSkillFiles` and `readSkillFiles` per root, roots resolved against the workspace, `idPrefix` and first-root-wins merge, `strict`, the limits, the always-on section |

## Tests

- Kits: `src/file-system.adapter.test.ts` and `src/bash.adapter.test.ts` run core's `fileSystemConformance` and `bashConformance` on Bun (the bash subject's `holdsBack` is off on Bun, which reads pipes ahead); `bun run verify:packages` runs both kits and the journey over the packed package on Bun and on Node (`node-imports.mjs`).
- `src/plugin.adapter.test.ts` (the local system as a plugin), `src/workspace-tools.adapter.test.ts` (the tools over a temporary directory), the pure pairs' tests (with fast-check properties), the key-free journey `src/workspace-tools.journey.test.ts` (`Agent.define` with a scripted model, an image `read` included) and `src/skills/*.test.ts` (an agent and a journey over a temporary directory). Run: `bun test packages/plugin-workspace`.

See the root AGENTS.md for the enforced rules and the definition of done.
