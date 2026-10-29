# @xandreed/plugin-workspace

The machine an agent runs on, as core's `FileSystem` and `Bash` ports:
`FileSystemLive` (`node:fs/promises`) and `BashLive` (`node:child_process`),
and `localSystemPlugin`, the runtime-scoped plugin that provides both. Runs
on Node 24 and Bun; it imports `node:*` modules and never Bun's own APIs.
POSIX only (Linux and macOS; CI runs Linux): `/`-rooted paths, process
groups (`detached`, `process.kill(-pid)`) and a `:`-separated `PATH`; it
does not work on Windows. On top of these ports, `workspaceToolsPlugin`
(`workspaceTools`) gives the model the workspace tools: read, write, edit,
ls, find, grep and bash; beside them is the skill directory loader
(`skillsDirectoryPlugin`, below).

- Both adapters pass core's kits, `fileSystemConformance` and
  `bashConformance`, on Bun (`bun test`) and on Node (`bun run
  verify:packages` runs them over the packed package in
  `node-imports.mjs`). A behaviour change starts as a kit check in core.
- `glob` is core's `walkGlob` over this adapter's `list`, never `fs.glob`
  (it lists no dot entries on Node and follows links on Bun).
- Error codes become `FsReason`s in one place, `fsReasonOf`
  (`local-system.entity.functions.ts`). `remove` never hands the path as
  given to `rmdir` or `rm` (the kernel would follow a trailing slash and
  resolve a last `..`): `removalPlace` refuses the root and a last `.` or
  `..`, the parent is resolved with `realpath`, and every call works on that
  parent plus the last name, as the in-memory backend does. `rename` names
  the side a failure came from (`lstat(from)` decides when either could).
- `BashLive` resolves the shell to an absolute path once, at layer build,
  from the parent `PATH`, with no fallback (a missing `bash` is
  `ShellMissing`; a host sets `shell: "sh"` itself); spawns it detached so
  the command leads its own process group; kills the group (`-pid`,
  SIGKILL) on timeout, on an
  interrupted stream and, with `killBackground`, when the command returns;
  signals the bare pid only before the exit; ignores `EPIPE` and
  `ERR_STREAM_DESTROYED` on stdin; and takes the parent environment from
  `parentEnv` (tests plant variables there) through `resolveBashEnv`.
  `exitGraceMs` after the exit it closes the output pipes, so a background
  process kept with `killBackground: false` needs its own output.
- Configuration is flat (`shell`, `killBackground`, `exitGraceMs`;
  `WorkspaceToolsConfig` likewise): plugin defaults merge one level deep.
- The workspace tools never touch `node:` or a runtime: they work through
  the `FileSystem`, `Bash` and `SessionEnvironment` of each call (read per
  call, so a turn's services can replace them), and run on any backend that
  passes the kits. Their pure parts are entity/functions pairs:
  `text-window` (line windows, head and tail cuts by lines and UTF-8 bytes,
  the NUL probe, the BOM), `text-edit` (`applyTextEdits`: exact, unique,
  non-overlapping edits against the original, the normalised fallback,
  CRLF; `unifiedDiff` over effect's `TextDiff` with `maxEdits: 10_000`),
  `text-search` (grep: lines cut before matching, context, caps, the
  refusal of nested repetition) and `workspace-path` (confinement through
  the real path of the nearest existing ancestor, `protect` globs,
  `excludesBelow` for path-shaped `exclude` globs). The tools themselves are the
  `*-tools.adapter.ts` files; `workspace-tools.adapter.ts` assembles the
  capability (skills `workspace.read` always on, `workspace.edit` behind
  `fs.write`, `workspace.shell` behind `shell.exec`) and the
  `workspace.environment` section. Guidance for the model goes in tool
  descriptions and that section, never in skill instructions (an always-on
  skill's instructions never reach the model).
- Confinement is a guardrail against a model's mistakes, not a sandbox:
  `bash` is unconfined, and a path can change between its check and its
  use. Nor is `grep`'s time bounded: its regular expression runs
  synchronously in the host process, and only nested repetition is
  refused. Say so wherever the tools are documented.
- `edit` refuses a file that is not valid UTF-8 (`decodeText` says
  `lossy`); `read`, `write`, `edit` and `grep` refuse a `stat` kind other
  than file or directory (`NotAFile`) before any read.
- `write` and `edit` hold a per-file lock (an `RcMap` of semaphores keyed
  by the real path) built with the capability, which is runtime-scoped, so
  turns of different sessions editing one file are serialised; they write
  through a temporary file and a rename, except when the temporary file's
  mode (under the umask) differs from the file's, or the file has bits a
  new file never gets: then in place. `bash` folds `Bash.stream` into a
  tail, publishes `tool.progress` once per `progressMs` (one event per run
  of one stream's output), and spills the output under `spillDir` (inside
  the workspace, so `read` can open it) up to `maxFileBytes`, keeping
  `spillKeep` files. `Bash` is read with `Effect.serviceOption` when
  the capability is built: without it there is no `bash` tool.
- The key-free journey (`workspace-tools.journey.test.ts`) drives the tools
  through `Agent.define` with a scripted model; `verify:packages` runs a
  packed version of it on Bun and Node.
- `src/skills/`: `skillsDirectoryPlugin` (runtime-scoped, requires
  `FileSystem`, reads `SessionEnvironment` when present, contributes
  `Capabilities`) loads directories of `SKILL.md` files once per agent. The
  reading is core's (`collectSkillFiles` over the port's `glob`, then
  `readSkillFiles`, which owns the id rule and the frontmatter); this
  package resolves roots against the workspace (`node:path`), merges roots
  (`idPrefix`, the first root winning an id), applies `strict` and the
  limits, and renders the always-on skills' section. Its errors are
  `HarnessError`s with codes (`skills.root`, `skills.limit`,
  `skills.files`) that `Agent.define` fails with as they are; a clash with
  another capability's skill is tool discovery's `skills.duplicate`. Its
  config is flat too. Tests run a scripted model through `Agent.define`
  over a temporary directory (`load_skill`, `read_skill_reference`) and a
  journey over several turns.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
