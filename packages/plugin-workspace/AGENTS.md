# @xandreed/plugin-workspace

The machine an agent runs on, as core's `FileSystem` and `Bash` ports:
`FileSystemLive` (`node:fs/promises`) and `BashLive` (`node:child_process`),
and `localSystemPlugin`, the runtime-scoped plugin that provides both. Runs
on Node 24 and Bun; it imports `node:*` modules and never Bun's own APIs.
POSIX only (Linux and macOS; CI runs Linux): `/`-rooted paths, process
groups (`detached`, `process.kill(-pid)`) and a `:`-separated `PATH`; it
does not work on Windows. Workspace tools (read, write, edit, ls, find,
grep, bash) and the skill directory loader are to live here too, on top of
these ports.

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
- Configuration is flat (`shell`, `killBackground`, `exitGraceMs`): plugin
  defaults merge one level deep.

See the root AGENTS.md for the enforced zero-baseline rules and checks.
