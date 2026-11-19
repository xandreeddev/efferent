# @xandreed/review

`efferent-review`, a pull request reviewer built on the kernel: it reads a pull request from its forge, its diff, the repository's rules and its CI, and prepares them for a review. This first cut asks no model: `efferent-review prepare <number> --repo <owner/name>` prints what a review would be given. Node 24 (the declared engine; the tests run on Bun): the package is not built, so the bin, `bin/efferent-review.mjs`, loads `src/main.ts` through `tsx`; layer `review` in `foundry.config.ts` (imports `@xandreed/sdk`, `@xandreed/sdk/node` and `node:` only). Private: it is gated like every package, but it is in neither the build's `names` nor `CURATED_ENTRIES`, and Changesets ignores it (`.changeset/config.json`, `ignoredNames` in `scripts/release-version-plan.ts`), so no release publishes it.

## Rules

- The orchestration is code, never a model: fetching, filtering, packing, running and digesting are pure functions with table tests (`*.entity.functions.ts`) or adapters behind a port.
- Every host command whose output is parsed (`gh … --json`, `gh api`, `git diff`, `git ls-tree`, `git cat-file`, `gh run view --log-failed`) is read whole through `runWhole`: the host's shell keeps `HOST_OUTPUT_BYTES` of each stream, and an output it cut fails with `OutputCut`, never parsed. An exit code the caller did not allow is `CommandFailed`.
- Every argument of a host command is quoted (`commandLine`): a path, a branch or a title from a pull request is data, never shell.
- A pull request's rules are read at its base commit (`show` at `base.sha`), so it cannot rewrite the rules it is reviewed by; a link (`CLAUDE.md` → `AGENTS.md`) is not read twice.
- `gh` and `git` run on the host's shell with the host's environment (`gh` reads its login there). Nothing of the pull request's runs on the host: a process of the host's user can read the parent's environment (`/proc/<pid>/environ`), the host's credentials and the shared clone, whatever variables it is given, so trimming the environment is no isolation. A pull request's commands run only through `Validations` over a `Shell` the host provides, which must be a sandbox; none ships, so the command line provides no `Validations` and has no `--run`. With one given, `prepareReview` runs `PrepareOptions.run` only for a head in the base repository whose author may write to it (`admin`, `maintain` or `write`), under `allowOnly` (a guard on which commands run, not isolation). CI's failed logs are the validation source.
- Every host-side git command is built by `gitArgv`: `core.hooksPath=/dev/null` (no hook of the clone's runs), `core.fsmonitor=false`, `protocol.allow=never` with only the transports given allowed (`https` by default), and `--literal-pathspecs` (a folder named `:(glob)x` or `:!x` is a name).
- Clones live under a cache root outside every git repository (`~/.efferent-review/<owner>/<repo>/` by default; `CacheRootRefused` otherwise): a bare clone in `mirror.git`, worktrees in `worktrees/`, removed when their scope closes, logs in `reviews/<number>-<head12>/`.
- CI runs are every run for the head's sha started by `pull_request`, `push`, `merge_group` or `pull_request_target` (`CI_EVENTS`), every page of runs and of jobs read (`gh api --paginate --slurp`); a run with no job is not listed. A failed log the forge no longer has is `NoLog`; one it refuses (auth, a repository 404) is that run's `Unavailable` entry, stripped and cut, and fails nothing else.
- Everything a log, a path or a title holds is the pull request's text. A digest strips escape sequences and control characters, cuts each line with the kernel's `clipTo` and bounds its failures and summary; a path is shown through `shownPath` (a JSON string when it holds a control character, a quote or a backslash), so a name cannot forge a line and maps back to one file.
- Which files the model reads: lockfiles, files the base's `.gitattributes` marks generated or vendored (a folder's name drops nothing), binary and deleted files are left out, each named in a line with its counts (a lockfile with whether a manifest changed too); a file that only loses lines is kept. The rest is packed manifests, CI files and small config first, then code largest first, then large config, then docs.
- Every policy is swappable: `prepareReview(repo, number, options, policies)` takes `ReviewPolicies` (`verdict`, `pack`, `rulesAlong`, `digest`, `mayRun`, `failed`), `STOCK_POLICIES` by default; the head is fetched by the ref the forge serves it under (`fetchRef`).
- Tests never reach a network: the forge is a stub `HostShell`; git runs on a fixture repository made in a temporary folder (`git-fixture.testing.ts`) with a generic identity and `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`.

## Public surface

The package is not published; `src/index.ts` names what a later step (the model's passes) builds on: `prepareReview` with `PrepareOptions`, `PreparedReview`, `ReviewPolicies`, `STOCK_POLICIES` and `summaryText`; the pure parts (`parseUnifiedDiff`, `renderDiff`, `shownPath`, `fileVerdict`, `attributesOf`, `packDiff`, `droppedLines`, `rulesAlong`, `digestLog`, `plainText`, `gitArgv`); the ports `Forge`, `Checkout`, `Validations`, `ReviewLogs`, `HostShell`; and their adapters `ghForge`, `gitCheckout`, `shellValidations` (`allowOnly`), `directoryLogs`, `hostShell` (`runWhole`), and `reviewCli`.

## Model-facing text

| Pinned text | Source | Pinned by |
|---|---|---|
| The diff the model reads: per file `File: <path> (<added, deleted, modified, renamed from <old>>[, mode X to Y], +A -D[, binary, not shown])`, then each hunk under `@@` and the function line git found, each line with its new-side number and `+` or a space, a removed line `-` with no number | `src/diff.entity.functions.ts` (`renderDiff`) | exact tests `src/diff.entity.functions.test.ts#renders the model-facing diff in fixed words`; `src/checkout-git.adapter.test.ts#a binary file whose name forges a header` |
| A path as shown: as it is, or a JSON string (`\\`, `"` and each C0, DEL, C1, U+2028 and U+2029 character as `\uXXXX`) | `src/diff.entity.functions.ts` (`shownPath`) | exact test `src/diff.entity.functions.test.ts#a JSON string that reads back to the path` |
| The packed diff: the kept files rendered, then `Left out of this diff:`, each lockfile's `- <path> changed (+A -D); <manifests> changed too` (at most three named, `and N more`) or `; no manifest changed`, then `- <path> (+A -D): <reason>` for the first `DROPPED_SHOWN` (30) other files left out and `- N more files (+A -D): <reason>` per reason for the rest, the reasons in the words of `DROPPED_BECAUSE` | `src/packed-diff.entity.functions.ts` (`packDiff`, `droppedLines`), `src/file-verdict.entity.ts` (`DROPPED_BECAUSE`, `LOCKFILE_MANIFESTS`) | exact tests `src/packed-diff.entity.functions.test.ts#renders the model-facing packed diff in fixed words`; `src/packed-diff.entity.functions.test.ts#a lockfile's line names the manifests`; `src/packed-diff.entity.functions.test.ts#past DROPPED_SHOWN, the files left out are counted by reason`; `src/packed-diff.entity.functions.test.ts#shown escaped in a left-out line` |
| A log's digest (the pull request's text, framed when a prompt holds it): each failure (`(seen N times)` after a repeated one) with its location lines indented, each cut at `FAILURE_SHOWN` (300) with `clipTo`'s marker on a line of its own, then the summary joined by `; ` | `src/log-digest.entity.functions.ts` (`digestLog`) | exact tests `src/log-digest.entity.functions.test.ts#tsc: errors deduplicated with a count`; `src/log-digest.entity.functions.test.ts#a CI log: prefixes and timestamps read past`; `src/log-digest.entity.functions.test.ts#a long failure line is cut with clipTo` |
| A failed run whose log could not be read: `log unavailable: <the forge's reason, stripped and cut at 300>` | `src/prepare-review.usecase.ts` (`Unavailable`), `src/prepare-review.entity.functions.ts` (`summaryText`) | exact test `src/prepare-review.usecase.test.ts#the summary names the pull request` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | the `efferent-review` bin: reads the process's environment, runs `reviewCli` |
| `src/cli.adapter.ts`, `src/cli.entity.ts` | the command line, its usage and the layers it composes |
| `src/run-main.adapter.ts` | runs the command as the process's main fiber |
| `bin/efferent-review.mjs` | the bin on Node 24: registers `tsx` and imports `src/main.ts` |
| `src/prepare-review.usecase.ts`, `src/prepare-review.usecase.functions.ts`, `src/prepare-review.entity.ts`, `src/prepare-review.entity.functions.ts` | the preparation, its stock policies, its options, policies and result, and its summary |
| `src/pull-request.entity.ts` | the pull request and its branded ids |
| `src/diff.entity.ts`, `src/diff.entity.functions.ts` | the unified diff, read and rendered |
| `src/file-verdict.entity.ts`, `src/file-verdict.entity.functions.ts` | which files a review reads, and `.gitattributes` |
| `src/packed-diff.entity.ts`, `src/packed-diff.entity.functions.ts` | the diff packed under a budget |
| `src/repo-rules.entity.ts`, `src/repo-rules.entity.functions.ts` | the instruction files along the changed paths |
| `src/log-digest.entity.ts`, `src/log-digest.entity.functions.ts` | a log's digest |
| `src/host-command.entity.ts`, `src/host-command.entity.functions.ts`, `src/host-shell.port.ts`, `src/host-shell.adapter.ts` | the host's shell, read whole |
| `src/forge.entity.ts`, `src/forge.port.ts`, `src/forge-gh.adapter.ts` | the forge, through `gh` |
| `src/checkout.entity.ts`, `src/checkout.entity.functions.ts`, `src/checkout.port.ts`, `src/checkout-git.adapter.ts` | the clone, through `git` (`gitArgv`) |
| `src/validations.entity.ts`, `src/validations.port.ts`, `src/validations.adapter.ts` | a pull request's own commands |
| `src/review-logs.entity.ts`, `src/review-logs.port.ts`, `src/review-logs.adapter.ts` | where whole logs are kept |
| `src/git-fixture.testing.ts` | the fixture repository the tests clone |

## Tests

- `src/*.entity.functions.test.ts`: each pure function as a table; the model-facing texts pinned whole.
- `src/host-shell.adapter.test.ts`: an argument with a quote, `$(` and a backtick reaching the command as written; an output over 8 KiB read whole; a cut one failing with `OutputCut`; exits and timeouts.
- `src/forge-gh.adapter.test.ts`: `gh`'s answers from a stub shell: a pull request, a fork, a deleted fork, a bot (`app/<name>`), a permission refused, a bad sha, runs over two pages from pull request and push alike, one with no job and other events skipped, jobs over pages, a workflow filter, a log found, missing, expired, or refused by auth or a repository 404 (failures with their reason), a cut answer.
- `src/checkout-git.adapter.test.ts`: `gitArgv`; on the fixture, each test in a cache of its own: a diff over 8 KiB from where the head left a base that moved on, folders named `:(glob)odd` and `:!neg`, a binary file whose name forges a header and a mode change read from git's own output and rendered escaped, the verdicts with `.gitattributes`, `show` at each end (a link, a folder and a missing file none, a magic folder's rules read), a worktree removed with its scope on success, failure and interruption, a commit missing, a transport not allowed, a cache root refused.
- `src/run-main.adapter.test.ts`: signals and exit codes over a fake process; the bin on `node` through `tsx` (needs `node` on `PATH`).
- `src/review-logs.adapter.test.ts`: a log kept under its name; names leading out and a relative folder refused.
- `src/validations.adapter.test.ts`: `allowOnly` refusing an unlisted command; commands run through the shell given, logs kept whole, a timeout; `type-level:` the stock validations need a `Shell`, and the command line's layers give neither a `Shell` nor `Validations`.
- `src/prepare-review.usecase.test.ts`: the whole preparation over the fixture with a stub forge and validations; a log the forge refused as that run's entry; the skips (fork, read, triage, no sandbox), no worktree made; swapped policies; the summary pinned whole.
- `src/cli.adapter.test.ts`: the arguments, and each usage error.
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/review`.

See the root AGENTS.md for the enforced rules and the definition of done.
