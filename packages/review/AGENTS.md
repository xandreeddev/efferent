# @xandreed/review

`efferent-review`, a pull request reviewer built on the kernel: it reads a pull request from its forge, its diff, the repository's rules and its CI, and prepares them for a review. This first cut asks no model: `efferent-review prepare <number> --repo <owner/name>` prints what a review would be given. Node 24 (the declared engine; the tests run on Bun); layer `review` in `foundry.config.ts` (imports `@xandreed/sdk`, `@xandreed/sdk/node` and `node:` only). Private: it is gated like every package, but it is in neither the build's `names` nor `CURATED_ENTRIES`, and Changesets ignores it (`.changeset/config.json`, `ignoredNames` in `scripts/release-version-plan.ts`), so no release publishes it.

## Rules

- The orchestration is code, never a model: fetching, filtering, packing, running and digesting are pure functions with table tests (`*.entity.functions.ts`) or adapters behind a port.
- Every host command whose output is parsed (`gh … --json`, `gh api`, `git diff`, `git ls-tree`, `git cat-file`, `gh run view --log-failed`) is read whole through `runWhole`: the host's shell keeps `HOST_OUTPUT_BYTES` of each stream, and an output it cut fails with `OutputCut`, never parsed. An exit code the caller did not allow is `CommandFailed`.
- Every argument of a host command is quoted (`commandLine`): a path, a branch or a title from a pull request is data, never shell.
- A pull request's rules are read at its base commit (`show` at `base.sha`), so it cannot rewrite the rules it is reviewed by; a link (`CLAUDE.md` → `AGENTS.md`) is not read twice.
- `gh` and `git` run on the host's shell with the host's environment (`gh` reads its login there); a pull request's own commands (`--run`) run in `Validations`, under `allowOnly` the commands asked, with `PATH` and a throwaway `HOME` alone, and only for a head in the base repository whose author may write to it (`admin`, `maintain` or `write`). A bot, a fork, or a permission the forge will not give runs nothing.
- Clones live under a cache root outside every git repository (`~/.efferent-review/<owner>/<repo>/` by default; `CacheRootRefused` otherwise): a bare clone in `mirror.git`, worktrees in `worktrees/`, removed when their scope closes, logs in `reviews/<number>-<head12>/`.
- A CI run with no job is not listed; a failed log the forge no longer has is a `NoLog` result, never a failure.
- Tests never reach a network: the forge is a stub `HostShell`; git runs on a fixture repository made in a temporary folder (`git-fixture.testing.ts`) with a generic identity and `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`.

## Public surface

The package is not published; `src/index.ts` names what a later step (the model's passes) builds on: `prepareReview` with `PrepareOptions`, `PreparedReview` and `summaryText`; the pure parts (`parseUnifiedDiff`, `renderDiff`, `fileVerdict`, `attributesOf`, `packDiff`, `droppedLines`, `rulesAlong`, `digestLog`); the ports `Forge`, `Checkout`, `Validations`, `ReviewLogs`, `HostShell`; and their adapters `ghForge`, `gitCheckout`, `processValidations` (`allowOnly`), `directoryLogs`, `hostShell` (`runWhole`), and `reviewCli`.

## Model-facing text

| Pinned text | Source | Pinned by |
|---|---|---|
| The diff the model reads: per file `File: <path> (<added, deleted, modified, renamed from <old>>, +A -D[, binary, not shown])`, then each hunk under `@@` and the function line git found, each line with its new-side number and `+` or a space, a removed line `-` with no number | `src/diff.entity.functions.ts` (`renderDiff`) | exact test `src/diff.entity.functions.test.ts#renders the model-facing diff in fixed words` |
| The packed diff: the kept files rendered, then `Left out of this diff:` and `- <path> (+A -D): <reason>` for the first `DROPPED_SHOWN` (30) files left out, then `- N more files (+A -D): <reason>` per reason for the rest, the reasons in the words of `DROPPED_BECAUSE` | `src/packed-diff.entity.functions.ts` (`packDiff`, `droppedLines`), `src/file-verdict.entity.ts` (`DROPPED_BECAUSE`) | exact tests `src/packed-diff.entity.functions.test.ts#renders the model-facing packed diff in fixed words`; `src/packed-diff.entity.functions.test.ts#past DROPPED_SHOWN, the files left out are counted by reason` |
| A log's digest: each failure (`(seen N times)` after a repeated one) with its location lines indented, then the summary joined by `; ` | `src/log-digest.entity.functions.ts` (`digestLog`) | exact tests `src/log-digest.entity.functions.test.ts#tsc: errors deduplicated with a count`; `src/log-digest.entity.functions.test.ts#a CI log: prefixes and timestamps read past` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | the `efferent-review` bin: reads the process's environment, runs `reviewCli` |
| `src/cli.adapter.ts`, `src/cli.entity.ts` | the command line, its usage and the layers it composes |
| `src/run-main.adapter.ts` | runs the command as the process's main fiber |
| `src/prepare-review.usecase.ts`, `src/prepare-review.entity.ts`, `src/prepare-review.entity.functions.ts` | the preparation, its options and result, and its summary |
| `src/pull-request.entity.ts` | the pull request and its branded ids |
| `src/diff.entity.ts`, `src/diff.entity.functions.ts` | the unified diff, read and rendered |
| `src/file-verdict.entity.ts`, `src/file-verdict.entity.functions.ts` | which files a review reads, and `.gitattributes` |
| `src/packed-diff.entity.ts`, `src/packed-diff.entity.functions.ts` | the diff packed under a budget |
| `src/repo-rules.entity.ts`, `src/repo-rules.entity.functions.ts` | the instruction files along the changed paths |
| `src/log-digest.entity.ts`, `src/log-digest.entity.functions.ts` | a log's digest |
| `src/host-command.entity.ts`, `src/host-command.entity.functions.ts`, `src/host-shell.port.ts`, `src/host-shell.adapter.ts` | the host's shell, read whole |
| `src/forge.entity.ts`, `src/forge.port.ts`, `src/forge-gh.adapter.ts` | the forge, through `gh` |
| `src/checkout.entity.ts`, `src/checkout.port.ts`, `src/checkout-git.adapter.ts` | the clone, through `git` |
| `src/validations.entity.ts`, `src/validations.port.ts`, `src/validations.adapter.ts` | a pull request's own commands |
| `src/review-logs.entity.ts`, `src/review-logs.port.ts`, `src/review-logs.adapter.ts` | where whole logs are kept |
| `src/git-fixture.testing.ts` | the fixture repository the tests clone |

## Tests

- `src/*.entity.functions.test.ts`: each pure function as a table; the model-facing texts pinned whole.
- `src/host-shell.adapter.test.ts`: an argument with a quote, `$(` and a backtick reaching the command as written; an output over 8 KiB read whole; a cut one failing with `OutputCut`; exits and timeouts.
- `src/forge-gh.adapter.test.ts`: `gh`'s answers from a stub shell: a pull request, a fork, a deleted fork, a bot, a permission refused, a bad sha, runs with no job and other events skipped, a workflow filter, a log found, missing or refused, a cut answer.
- `src/checkout-git.adapter.test.ts`: on the fixture, a diff over 8 KiB from where the head left a base that moved on, the verdicts with `.gitattributes`, `show` at each end (a link, a folder and a missing file none), a worktree removed with its scope, a commit missing, a cache root refused.
- `src/validations.adapter.test.ts`: `allowOnly` refusing an unlisted command; commands run with `PATH` and a deleted `HOME` alone, no variable of the host's, logs kept whole, a timeout.
- `src/prepare-review.usecase.test.ts`: the whole preparation over the fixture with a stub forge and validations; the skips; the summary pinned whole.
- `src/cli.adapter.test.ts`: the arguments, and each usage error.
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/review`.

See the root AGENTS.md for the enforced rules and the definition of done.
