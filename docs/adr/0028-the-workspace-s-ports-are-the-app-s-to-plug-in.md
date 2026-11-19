# ADR 0028: The workspace's ports are the app's to plug in: files on a disk, a shell, a search

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel/node` (new: `diskFiles`, `DiskFilesOptions`, `DEFAULT_IGNORE`,
  `DEFAULT_MAX_BYTES`, `processShell`, `ProcessShellOptions`), `@xandreed/sdk/kernel` (new: the `Shell` contract, its
  kit and `scriptedShell`, the tool `runCommand`; the `Search` contract, its kit, `filesSearch` and the tool
  `searchFiles`; `recoverTurns` gives a `Recovery`)
- **Amends:** ADR 0017 (the kernel now ships a disk, on the Node entry; the search's adapter holds `Files` for its
  tool), ADR 0024 (two ports join the Node entry; one session `recoverTurns` cannot read no longer stops it)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine and every `plugin-*` package are removed before the next release. The old workspace plugin gives a
Node agent a real disk, a shell, text search and images. The kernel had the `Files` contract (ADR 0017) with an
in-memory adapter and four file tools, and nothing on a disk. The maintainer decided that each of these is
pluggable: an app plugs in what it means its agent to have, and permission is always the app's, never a tool's.

## Decision

### Pluggable, and permission is the app's

- Each part is a contract with a kit, an adapter, and a tool in a plugin folder of its own, which a host merges into
  its toolkit or leaves out: `fileTools` over `Files`, `shellTools` over `Shell`, `searchTools` over `Search`. No
  tool asks anyone (ADR 0017; ADR 0012's `approve` stays a tool's own choice, and these tools do not make it). An app
  that wants a rule wraps the contract (a `Shell` that declines with `ShellRefused`, as a `Files` declines with
  `FilesRefused`); one that wants a person asks in its loop with `approveIn` before it runs the call
  (`shell.test.ts` shows both). A contract wrapper that asks a person is rejected for the reason ADR 0017 gives: its
  calls run with no turn in their type, and an answer is a record of a turn.

### Files on a disk: `diskFiles({ root, maxBytes?, ignore? })`

It passes `filesConformance`, and every case the kit in memory never meets is decided here and tested
(`node/files-disk/disk-files.adapter.test.ts`):

- **A path never leaves the root.** `FilePath` already refuses `..`; the adapter also takes each path's real path
  (links followed) and declines one outside the root's (`FilesRefused`, "it leads outside the workspace"), read or
  written. A new file's nearest existing folder is checked before any folder is made, so a link to a folder outside
  cannot be written through. A link inside the root is followed. This holds a model's paths to the root; it is not a
  sandbox against another process of the machine, which could swap a folder for a link between the check and the
  write.
- **A file that is not UTF-8 is declined in words** ("it is not UTF-8 text"), never read with replacement
  characters: an edit is a compare and set over the text read, and would write U+FFFD back over the bytes it could
  not read. A byte-order mark is kept as the character it is, so a file is written back with it.
- **A file over a bound** (`maxBytes`, 1 MiB by default, 262 pages of `readFile`) is declined, read or written; a
  search passes over it and counts it.
- **A name that makes no `FilePath`** (a `:`, a `\`, a control character, a path over `PATH_LIMIT`) is left out of
  `list` and not gone into: the model could not name it anyway, and the contract's `list` gives `FilePath`s.
- **Links in a listing:** a link to a file of the root is listed; a link that leads outside, to nothing, or back to
  itself (a loop) is left out; a link to a folder is not walked, so no loop of links is walked and no file is listed
  twice. Read, a loop is declined ("it is a link that leads back to itself"), a link to nothing is `FileNotFound`,
  and a write to one is declined ("a link that leads to nothing").
- **What `list` leaves out:** the names in `ignore` at any depth and what is in them, `.git` and `node_modules` by
  default (`DEFAULT_IGNORE`; a host's list replaces it), since a search reads every listed file. Ignored is only not
  listed: a path under it can still be read and written. A host that keeps a folder from the agent declines it.
- **A write is whole:** the text goes to `.efferent-<uuid>.tmp` in the file's folder, is flushed, and is renamed over
  the file, which keeps its mode; the folder is flushed after. A rename needs the folder writable, not the file: a
  write that expects nothing replaces a file the system would not let it open, and one that expects its text cannot
  read it and fails `FileChanged`. A crash leaves the old file or the new one, and maybe
  a temporary file, which `list` never shows. They are not swept: another process may be writing one.
- **Compare and set holds within the process:** the check of what a write expects and its rename take the
  workspace's lane, one write at a time for every `diskFiles` of the process over the same real root (as the
  journals' writer does). Another process that writes the file between the check and the rename is not seen, and
  its change is replaced. A person's editor is such a process: the window is the length of one write.
- **The medium:** a call the system does not allow (`EACCES`, `EPERM`) is declined in words, which the model reads;
  any other failure of the file system is `FilesUnavailable`, a defect of the call. A root that is not a folder fails
  the layer with `FilesUnavailable`.

### A shell: the `Shell` contract and `processShell({ cwd, env?, shell?, outputBytes?, timeoutMs? })`

- **The contract:** `run({ command, cwd?, timeoutMs? })` runs `sh -c <command>` and gives `Ran`: the end of stdout
  and of stderr, the bytes cut before each (`stdoutCut`, `stderrCut`), and how it ended (`Exited` with its code,
  `TimedOut`, `Killed` by a signal: one the shell did not send, or its own when its scope closed under the run). A
  non-zero exit, a timeout and a signal are results;
  `ShellUnavailable` is a command that could not run at all (a defect of the tool's call), `ShellRefused` a host's
  rule. Output keeps its **end**, at most `outputBytes` (8 KiB) of each stream, never half a character: the end says
  how a command ended. 8 KiB, not more, because a result of `runCommand` is stored and a memory that sends every
  result (`flatMemory`) sends it in every later prompt: at most 16 KiB a call at the default. Its kit, `shellConformance`, has ten checks; `scriptedShell(script)` answers a script, so the
  tool's tests spawn nothing.
- **Environment:** a command gets exactly the variables of the adapter's `env`, empty by default. The adapter never
  reads `process.env`, so no gate exemption is needed (`ENVIRONMENT_EDGES` is unchanged) and a tool that never asks
  cannot print the host's keys. The shell needs no variable to start, since it is started by its absolute path
  (`/bin/sh`); with no `PATH`, `sh` looks commands up on its own default path. A host that wants its own `PATH`,
  `HOME` or `LANG` passes them. A command also sees what `sh` sets for itself (`PWD`, `SHLVL`, `_`, `OLDPWD`); the
  kit's `environment` check allows those and nothing else. The tool's parameters are the command and a timeout,
  never an environment or a folder.
- **The kill:** the shell is spawned detached, so it leads a process group of its own, and a run ends, however it
  ends, by `SIGKILL` to that whole group: once it timed out, once the shell returned (what it left in the
  background goes with it), when the fiber running it is interrupted, and for every run still going when the
  layer's scope closes. The kit's `timeout-kills`, `return-kills`, `interrupt-kills` and `close-kills` checks start a
  `sleep` in the background, read its pid from a file, and wait for it to be gone; each fails on a careless shell
  that stops only the shell's own process on that path (`shell-kit.test.ts`). Process-group kill was not assumed on
  Bun: it was probed (a detached `sh` whose background `sleep` dies with the group, and survives a kill of the shell
  alone) and is held by the kit on Bun 1.3.0 in the tests and on Node 24 and Bun in the packed consumer fixture.
  `SIGKILL` at once, with no `SIGTERM` first: a command cut short by a timeout is not asked to tidy up, and a host
  whose commands must, runs them under their own `timeout`. A process that leaves the group (`setsid`, a daemon that
  detaches) is not reached; after the shell is gone the run waits two seconds for the pipes such a process holds,
  then stops reading.
- **Not confined.** A command runs with the host's rights, wherever its paths lead; `cwd` is a starting folder and
  nothing more; it is not the `Files` root and is not checked against it. The tool's description says so to the
  model ("with the host's rights"). Giving `runCommand` to a model is the app's decision, with the layers above.
- **Not ported from the old engine:** streaming output and progress while a command runs, stdin, a spill file of
  the whole output, and resolving a shell by name on a `PATH`. POSIX only (Linux, macOS): it relies on process
  groups.

### Search: the `Search` contract, `filesSearch`, and no ripgrep

- **The contract:** `find({ pattern, regex?, folder?, glob?, limit })` gives the lines that hold the pattern, each
  with its path, line and column (from 1) and its text, a line over 200 characters shown as 200 around the match;
  ordered by path in code-unit order, then line, which the kit pins; at most `limit`, with `more`; `skipped`, the
  files that could not be read as text. A pattern is found as it is written, or with `regex` as a JavaScript regular
  expression with no flags; one that is empty, holds a line break, is over 1,000 characters, does not compile, or
  repeats (`*`, `+`, `{n,}`, `{n,m}` past 1) a group that holds a choice or a quantifier (`(a|aa)+`, `(a+)+`,
  `(\w+\s?)*`, `(\d+\.){3}`: `RepeatedGroup`) fails with `PatternInvalid`, which the tool words without the
  engine's own words (they differ between runtimes). A host may keep its search to text as written:
  `filesSearch({ regex: false })` refuses every regular expression (`RegexOff`), in fixed words the model reads. A
  glob with no `/` keeps files by name, one with a `/` by path; `*` and `?` stay within a name, `**` crosses folders.
  Its kit, `searchConformance`, has nine checks.
- **One adapter, pure, over `Files`:** `filesSearch` lists the folder, keeps what the glob keeps, and reads each
  file through `Files`, so it imports no runtime module and is on the browser entry: the same search runs over a
  page's workspace in memory and over `diskFiles`, whose bound and listing rules are what it reads. A file declined
  or gone is passed over and counted. It holds `Files` for its tool alone, never for a part that builds the agent's
  state or a prompt: ADR 0017's first condition holds, and `files.test.ts` lists it among the parts that may import
  the files contract.
- **No ripgrep adapter.** Ripgrep's regular expressions are Rust's, not JavaScript's: the same pattern would match
  otherwise depending on the adapter a host plugged in, and the model reads one description. The search keeps one
  syntax, the engine's the model is told of.
- **A regular expression the check misses can hold the whole process.** It runs on the process's own JavaScript
  engine, which nothing can interrupt once it matches: no timeout, no interruption of the fiber and no Stop reaches
  it, and the process answers nothing else until it ends. The check refuses the forms whose matches split many ways
  (a repeated group holding a choice or a quantifier), which are the exponential ones; it does not catch every slow
  pattern (`a*a*a*$` is polynomial, and slow enough on a long line). The old engine ran regular expressions in a
  worker it could stop; a pure adapter has none. A host that cannot afford a miss turns regular expressions off with
  `filesSearch({ regex: false })`. The bound on a file (`maxBytes`) bounds the input, not the time. Nor does it cut a line before matching, as the old engine did to bound a line's time: a match past the cut
  would not be found, and the search says it found every line it did not skip.
- **No cap per file.** The old engine took at most a quarter of its limit from one file of a folder's search, so one
  file could not fill the answer. This search keeps the contract's order and lets `more` mean one thing (there were
  more lines, in that order); a model that sees one file fill its answer narrows with `folder` or `glob`.

### Recovery passes over a session it cannot read

`recoverTurns` gives a `Recovery`, `{ closed, unreadable }`: a session whose journal the store says is `Unreadable`
(a damaged line) is logged, named with the store's words (`UnreadableSession`) and passed over, and the turns of the
sessions after it are closed. Beside the closed turns rather than mixed into them, so a host that reads `closed`
reads what it read before, and one that must not start over a damaged store has the list to act on. Any other
failure of the store still fails the step. A damaged *header* line still fails the store's `list`, which is the
storage contract's and unchanged. ADR 0024's consequence carries a dated note.

## Consequences

- A host on Node or Bun gives a kernel agent a folder, a shell and a search without the old engine's packages, each
  a layer it plugs in or leaves out; the browser entry gains the search and the shell's contract, tool and script,
  and still imports no runtime module.
- `docs/kernel.md` and ADR 0017's "the kernel ships no disk" no longer hold for the Node entry; the browser entry still
  ships none.
- A host that reads `recoverTurns` as an array changes to `.closed`.
- A command can do anything the host process can. The kernel's only defence is that the tool is not given by
  default and never runs on its own.
- The kill after the shell exits names its group id at once, in the same moment the exit is heard; only a system
  whose process ids wrap around within that moment could have given the id to another group, which the kill would
  then reach. Nothing names the group after it: the run leaves the scope's list, and its release does not kill again.
- A host killed while a command runs (`SIGKILL`, a crash) leaves the command running: its group is its own session,
  nothing holds its timeout any more, and nothing stops it.
- A temporary file a crash leaves in a folder of `diskFiles` stays there: none is swept, since another process may be
  writing one. A listing never shows it.
- A `runCommand` result can put up to twice `outputBytes` into every later prompt under a memory that sends every
  result (16 KiB at the default of 8 KiB a stream); `pointed` and the window memory shorten what they send, and a host
  that raises `outputBytes` raises this with it.
- A host that leaves regular expressions on accepts that a pattern the check misses can hold its process.

## Left open

- **Media:** a store of images and other bytes for the model, in its own cut.
- **Compare and set across processes:** a lock or a version the file system keeps, when two processes write one
  workspace.
- **A search with a time bound:** a worker the Node entry runs it in, so a host can keep regular expressions and still
  stop one.
- **Streaming a command's output** to the turn while it runs (`plugin.render`'s progress), and stdin.

## What would reopen this

- A ripgrep adapter, if the contract gained a syntax both engines read the same way, or a way to say which engine a
  pattern is for that the model reads.
- A runtime where process groups do not hold (a Bun release that spawns otherwise, Windows): the kit's `*-kills`
  checks fail there first.
- A part other than a tool that must read the workspace, or search it.

A change to this decision is a new record that supersedes this one; this one is not edited.
