---
title: Workspace tools
description: read, write, edit, ls, find, grep and bash over an agent's workspace, with permissions, confinement, output limits and images.
---

# Workspace tools

`@xandreed/plugin-workspace` gives an agent the tools it works on a
directory with: `read`, `ls`, `find` and `grep` to look around, `write` and
`edit` to change files, and `bash` to run commands. They work through two
core ports, `FileSystem` and `Bash`, so the same tools run over the local
disk (`localSystemPlugin`), an in-memory file system (`FileSystemMemoryLive`)
or a host's own container or remote machine.

```ts
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"

const agent = yield* Agent.define({
  plugins: [
    memoryWindowPlugin, stepLoopPlugin, localSystemPlugin, workspaceToolsPlugin,
    { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write", "shell.exec"], maxCallsPerRun: 200 } },
  ],
  turnServices: [LanguageModel.LanguageModel],
  workspace: "/srv/checkout",
})
```

The workspace is `Agent.define`'s `workspace` (the process's directory by
default). Each call uses the `FileSystem`, `Bash` and `SessionEnvironment` of
the turn it runs in. The tools declare them (`bash` alone needs `Bash`), so a
turn whose services lack one fails to open its tools with
`requires.missing`, naming the tool and the service. The
`workspace.environment` section reads and declares the same services.

## The tools

| Tool | Skill | Parameters | What the model gets |
| --- | --- | --- | --- |
| `read` | `workspace.read`, on from the first step | `path`, `offset`, `limit` | up to 2000 lines or 50 KB of a text file, and the `offset` to continue from; a PNG, JPEG, GIF or WebP image, as an image; any other binary file is reported, not shown |
| `ls` | `workspace.read` | `path`, `limit` | a directory's entries; directories end in `/`, links in `@` |
| `find` | `workspace.read` | `pattern`, `path`, `limit` | the files whose path matches a glob (`**/*.ts`), relative to the root |
| `grep` | `workspace.read` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit` | `path:line:text` for each matching line, with context lines when asked |
| `write` | `workspace.edit`, needs `fs.write` | `path`, `content` | what was created or replaced |
| `edit` | `workspace.edit`, needs `fs.write` | `path`, `edits: [{ oldText, newText }]` | how many blocks were replaced, and where |
| `bash` | `workspace.shell`, needs `shell.exec` | `command`, `timeout` (seconds), `stdin` | the end of the output, how the command ended, and where the whole output was saved |

A failure is a result the model reads and corrects in the same turn
(`{ error, message }`, named for what is wrong: `NotFound`, `OutsideWorkspace`, `Protected`,
`NoMatch`, `AmbiguousMatch`, `NotUtf8`, `NotAFile`, `AccessDenied`, …). A command that exits non-zero, is killed by a
signal or runs past its timeout is a result too. The `workspace.edit` and
`workspace.shell` skills appear in the skill catalogue; the model loads them
with `load_skill`.

## Permissions

`write` and `edit` need the grant `fs.write`; `bash` needs `shell.exec`.
Tool discovery grants nothing unless told to, through its `grants` option or
a turn's `PermissionGrants`, so out of the box the agent can only look.
Without the grant, `load_skill` answers `PermissionDenied` and the tools
stay unavailable. Putting `edit` or `shell` in the plugin's `always` makes
them active from the first step, and fails the turn when the grant is
missing.

A coding turn reads and edits many times: raise tool discovery's
`maxCallsPerRun` (64 by default) to 200 or more.

## A guardrail, not a sandbox

- Paths are resolved against the workspace root. With `confine` (the
  default) a path that leads outside it is refused, whether written with
  `..`, as an absolute path or through a symbolic link, including a new file
  under a linked directory.
- `write` and `edit` refuse the `protect` globs: `.git/**` and
  `.efferent/**` by default.
- `find` and `grep` never enter linked directories or the `exclude` names
  (`node_modules`, `.git`, `.efferent`; an entry with a `/` is a path
  relative to the root, wherever the search starts).
- `read`, `write`, `edit` and `grep` refuse a pipe, socket or device
  (`NotAFile`) rather than wait on it.
- Commands get the variables in `bashEnv` and an allowlist of the host's
  (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM`, `SHELL`,
  `TMPDIR`, `TZ`), never the host's API keys unless `bashInheritEnv` is set.

These checks stop a model's mistakes. They do not contain a hostile one:
`bash` runs any command the host process may run, and a path can change
between its check and its use. Nor do they bound how long `grep` takes: its
regular expression runs synchronously in the host process, and stopping the
turn cannot interrupt it. Lines are cut to 500 characters before matching,
and a pattern that repeats a repeating group (`(a+)+`) is refused, but
other backtracking patterns (`(a|a)*`) can still hold the process on a
hostile line. To run untrusted work, give the agent a
`FileSystem` and `Bash` that live in a container or a VM; the
[conformance kits](/docs/concepts/conformance) check such adapters.

## Long output

- `read` shows a window and the offset to continue from:
  `[Showing lines 1-2000 of 5400. Use offset=2001 to continue.]`.
- `ls`, `find` and `grep` stop at 500 entries, 1000 paths and 100 matching
  lines, and what `find` and `grep` show is cut to 2000 lines or 50 KB.
  `grep` cuts lines to 500 characters before matching them.
- A file that is not valid UTF-8 is shown with U+FFFD in place of the bytes
  that are not, and a notice; `edit` refuses it.
- `bash` keeps the last 2000 lines or 50 KB of a command's output. When there
  is more, it is saved under `.efferent/runtime/tool-output`, up to 32 MB
  (what `read` opens; past that the rest is not saved and the result says
  so), and the result names the file. The newest 50 such files are kept.
- While a command runs, its output is gathered for 250 ms at a time and
  published as transient `tool.progress` events, one per run of output from
  one stream, for a host to show live.

## Images

`read` returns a PNG, JPEG, GIF or WebP file as an image the model sees
(its tool description says so). The type is the one its bytes are, whatever
its name says: core's `sniffImageType` reads it, and `mediaFromBytes`
checks the image. The result is `{ _tag: "Image", path, image }`, its view
text one line, `[Image docs/chart.png (image/png, 182 KB).]`, and the image
goes to the model with it, as an image of the tool result. The session
stores the image once, inside the result. A route that reads no images gets
a label line in its place (see [Images](/docs/concepts/providers#images)
for the routes and the limits).

An image over 3.75 MiB (`MEDIA_LIMITS.imageBytes`) or 8000 pixels a side,
or one whose header gives no size, is not sent: `read` returns an
`ImageRejected` note with its path, type, size and why, and, for a size,
tells the model to read a smaller copy (scaled down or recompressed with
`bash`). A file over `maxFileBytes` is refused (`FileTooLarge`) before this
check, unread; for an image the refusal says to read a smaller copy too, and
the tool description gives the smaller of the two limits.

Set `readImages: false` to keep images out of the session, for models that
read text only (an endpoint without `images`, or memory with
`maxMediaChars: 0`): such a model would get a label line, while the session
still stored the bytes. With it, images are reported as binary files, like
any other.

## Edits

`edit` takes several replacements at once. Each `oldText` must appear
exactly once in the file as it was before the call, and replacements must
not overlap. When the exact text is not found, it is matched once more with
whitespace, quotes and dashes normalised (`fuzzyEdit`), and that match must
be unique too. Line endings and a byte-order mark are kept. A file that is
not valid UTF-8 (Latin-1, say) is refused with `NotUtf8`, since writing it
back would replace the bytes it cannot decode. The result carries a unified
diff for a host's UI (`onTool(workspaceToolSchemas.edit, …)` hands it over
typed); the model is told only what changed where.

`write` and `edit` replace a file through a temporary file and a rename, so
nothing reads half a file, except when the rename would change the file's
permissions: a file whose mode a new file would not get under the process's
umask (an executable, private or read-only file, or a group-writable one
under the usual umask 022) is written in place instead, keeping its mode. They wait for each other on the same file across
sessions. `write` refuses to empty a file that has content.

## Configuration

The options are flat; every one has a default
(see the [plugin reference](/docs/concepts/plugin-reference)):

| Option | Default | Meaning |
| --- | --- | --- |
| `tools` | all seven | the tools to register |
| `always` | `["read"]` | skills on from the first step: `read`, `edit`, `shell` |
| `confine` | `true` | refuse paths outside the workspace |
| `protect` | `.git/**`, `.efferent/**` | globs `write` and `edit` refuse |
| `exclude` | `node_modules`, `.git`, `.efferent` | names (or, with a `/`, paths from the root) `find` and `grep` skip |
| `maxLines`, `maxBytes` | 2000, 51 200 | the most `read`, `find` and `grep` show, and the tail `bash` keeps |
| `lsEntries`, `findResults`, `grepMatches` | 500, 1000, 100 | caps on `ls`, `find` and `grep` |
| `grepLineChars` | 500 | the width `grep` cuts lines to |
| `maxFileBytes` | 32 MB | the largest file `read`, `edit` and `grep` load (an image too), and the most of an output `bash` saves |
| `readImages` | `true` | `read` returns PNG, JPEG, GIF and WebP files as images |
| `fuzzyEdit` | `true` | the normalised fallback of `edit` |
| `bashTimeoutMs`, `bashMaxTimeoutMs` | 120 000, 600 000 | a command's timeout, and the most the model may ask for |
| `bashEnv`, `bashInheritEnv`, `bashEnvAllow` | `{}`, `false`, the allowlist | a command's environment |
| `bashSessionEnv` | `false` | add `EFFERENT_SESSION_ID`, `EFFERENT_RUN_ID`, `EFFERENT_WORKSPACE` |
| `spillDir`, `spillKeep` | `.efferent/runtime/tool-output`, 50 | where whole outputs go, and how many stay |
| `progressMs` | 250 | how long output gathers before it is published as `tool.progress` events |
| `environmentSection`, `sectionOrder` | `true`, 800 | the system-prompt section about the workspace |

The local adapters run on Linux and macOS, on Node 24 and Bun.
