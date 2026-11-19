import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { CacheRootRefused, CommitMissing, GREP_TIMEOUT_MS, PatternRefused } from "./checkout.entity.js"
import type { BlobSha, GrepRequest, Transport, TreeEntry } from "./checkout.entity.js"
import { entryOf, gitArgv, grepHitsOf, LS_ENTRY, REGULAR } from "./checkout.entity.functions.js"
import { Checkout } from "./checkout.port.js"
import { CommandFailed } from "./host-command.entity.js"
import { runWhole } from "./host-shell.adapter.js"
import type { HostShell } from "./host-shell.port.js"
import { CommitSha } from "./pull-request.entity.js"
import type { HeadToFetch, PullEnd, RepoName } from "./pull-request.entity.js"
import { plainText } from "./log-digest.entity.functions.js"
import { clipTo } from "@xandreed/sdk"

/** The flags every diff is read with, whatever the host's git config says: no colour, no driver, `a/` and `b/`. */
export const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-U5", "-M", "--src-prefix=a/", "--dst-prefix=b/"] as const

/**
 * Where the checkout keeps its clones (`<root>/<owner>/<name>/`, a bare clone in `mirror.git`, worktrees in
 * `worktrees/`), and the URL each repository is cloned from (GitHub's over HTTPS by default; a test gives a folder).
 */
export interface GitCheckoutOptions {
  readonly cacheRoot: string
  readonly remoteUrl?: (repo: RepoName) => string
  /** The transports git may use, `https` alone by default (`gitArgv`). */
  readonly transports?: ReadonlyArray<Transport>
}

/** The folder at or above `path` that holds a `.git`, if any. */
const repositoryAbove = (path: string): Option.Option<string> => {
  let at = path
  for (;;) {
    if (existsSync(join(at, ".git"))) return Option.some(at)
    const up = dirname(at)
    if (up === at) return Option.none()
    at = up
  }
}

/**
 * The checkout through `git` on the host's shell, every command built by `gitArgv` (no hooks, no monitor, only the
 * transports given, literal paths): a bare clone per repository under the cache root, which must be an absolute
 * folder outside every git repository (`CacheRootRefused` otherwise). `fetch` clones once, then fetches the
 * base branch and the head's `fetchRef` (into `refs/review/<sha>`), and a commit still missing by its sha; `diff` is
 * `git diff base...head` with
 * `DIFF_FLAGS`, read whole; `show` reads a blob through `ls-tree`, so a link or a folder is none; `worktree` adds a
 * detached worktree under `worktrees/` and removes it, forced, when the scope closes.
 */
export const gitCheckout = (options: GitCheckoutOptions): Layer.Layer<Checkout, CacheRootRefused, HostShell> => Layer.effect(Checkout, Effect.gen(function* () {
  const host = yield* Effect.context<HostShell>()
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, host)
  if (!isAbsolute(options.cacheRoot)) return yield* Effect.fail(new CacheRootRefused({ root: options.cacheRoot, message: "the cache root must be an absolute folder" }))
  const root = resolve(options.cacheRoot)
  const inside = repositoryAbove(root)
  if (Option.isSome(inside)) return yield* Effect.fail(new CacheRootRefused({ root, message: `the cache root is inside the git repository at ${inside.value}: a clone never goes inside a repository` }))
  const remoteUrl = options.remoteUrl ?? ((repo: RepoName) => `https://github.com/${repo}.git`)
  const repoDir = (repo: RepoName) => join(root, ...repo.split("/"))
  const mirror = (repo: RepoName) => join(repoDir(repo), "mirror.git")
  const transports = options.transports ?? ["https"]
  const git = (repo: RepoName, ...args: ReadonlyArray<string>) => gitArgv(transports, mirror(repo), args)

  const has = (repo: RepoName, sha: CommitSha) =>
    Effect.map(runWhole(git(repo, "cat-file", "-e", `${sha}^{commit}`), { exits: [0, 1, 128] }), (whole) => whole.code === 0)

  const fetch = Effect.fn("checkout.fetch")(function* (repo: RepoName, base: PullEnd, head: HeadToFetch) {
    if (!existsSync(join(mirror(repo), "HEAD"))) {
      yield* Effect.tryPromise({
        try: () => mkdir(repoDir(repo), { recursive: true }),
        catch: (cause) => new CommandFailed({ reason: "unavailable", command: "mkdir", message: `the cache folder cannot be made: ${cause instanceof Error ? cause.message : "no reason given"}` }),
      })
      yield* runWhole(gitArgv(transports, null, ["clone", "--bare", "--quiet", "--", remoteUrl(repo), mirror(repo)]))
    }
    yield* runWhole(git(repo, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base.ref}:refs/heads/${base.ref}`, `+${head.fetchRef}:refs/review/${head.sha}`))
    for (const sha of [base.sha, head.sha]) {
      if (yield* has(repo, sha)) continue
      yield* runWhole(git(repo, "fetch", "--quiet", "--no-tags", "origin", sha), { exits: [0, 1, 128] })
      if (!(yield* has(repo, sha))) return yield* Effect.fail(new CommitMissing({ sha, message: `the commit ${sha} is not in ${repo} after fetching it` }))
    }
  }, provided)

  const diff = Effect.fn("checkout.diff")(function* (repo: RepoName, base: CommitSha, head: CommitSha) {
    const whole = yield* runWhole(git(repo, "-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "diff", ...DIFF_FLAGS, `${base}...${head}`))
    return whole.stdout
  }, provided)

  const show = Effect.fn("checkout.show")(function* (repo: RepoName, at: CommitSha, path: string) {
    const listed = yield* runWhole(git(repo, "ls-tree", "-z", at, "--", path))
    const entry = listed.stdout.split("\0").find((line) => line.endsWith(`\t${path}`))
    const match = entry === undefined ? null : /^(\d+) blob ([0-9a-f]+)\t/.exec(entry)
    if (match === null || match[1] === "120000") return Option.none<string>()
    const blob = yield* runWhole(git(repo, "cat-file", "blob", match[2] ?? ""))
    return Option.some(blob.stdout)
  }, provided)

  const worktree = Effect.fn("checkout.worktree")(function* (repo: RepoName, at: CommitSha) {
    const path = join(repoDir(repo), "worktrees", `${at.slice(0, 12)}-${randomUUID().slice(0, 8)}`)
    return yield* Effect.acquireRelease(
      Effect.as(runWhole(git(repo, "worktree", "add", "--detach", "--quiet", path, at)), path),
      () => runWhole(git(repo, "worktree", "remove", "--force", path)).pipe(
        Effect.tapError((error) => Effect.logWarning("a review's worktree could not be removed by git, so its folder is deleted", error)),
        Effect.catch(() => Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.andThen(runWhole(git(repo, "worktree", "prune"))))),
        Effect.ignore({ log: "Warn", message: "a review's worktree folder could not be deleted" }),
      ),
    )
  }, provided)

  const entry = Effect.fn("checkout.entry")(function* (repo: RepoName, at: CommitSha, path: string) {
    const listed = yield* runWhole(git(repo, "ls-tree", "-z", at, "--", path))
    const found = listed.stdout.split("\0").find((line) => line.endsWith(`\t${path}`))
    const match = found === undefined ? null : LS_ENTRY.exec(found)
    return match === null ? { _tag: "Missing" } satisfies TreeEntry : entryOf(match[1] ?? "", match[2] ?? "", match[3] ?? "")
  }, provided)

  const blob = Effect.fn("checkout.blob")(function* (repo: RepoName, id: BlobSha) {
    return (yield* runWhole(git(repo, "cat-file", "blob", id))).stdout
  }, provided)

  const files = Effect.fn("checkout.files")(function* (repo: RepoName, at: CommitSha) {
    const listed = yield* runWhole(git(repo, "ls-tree", "-r", "-z", "--full-tree", at))
    return listed.stdout.split("\0").flatMap((line) => {
      const match = LS_ENTRY.exec(line)
      return match !== null && match[2] === "blob" && REGULAR.includes(match[1] ?? "") ? [line.slice(match[0].length)] : []
    })
  }, provided)

  const grep = Effect.fn("checkout.grep")(function* (repo: RepoName, at: CommitSha, request: GrepRequest) {
    // The pattern always follows -e and the paths --, so a pattern that starts with - is a pattern, never an option.
    const args = git(repo, "grep", "-z", "-n", "-I", "--no-color", "--no-textconv", request.regex ? "-E" : "-F", "-e", request.pattern, at, "--", ...Option.toArray(request.path))
    // 128 is git's refusal of a regular expression only when one was asked for; else it is a failure like any other.
    const whole = yield* runWhole(args, { exits: request.regex ? [0, 1, 128] : [0, 1], timeoutMs: GREP_TIMEOUT_MS })
    if (whole.code === 128) return yield* Effect.fail(new PatternRefused({ message: clipTo(plainText(whole.stderr.trim()), 300) }))
    return grepHitsOf(whole.stdout, at)
  }, provided)

  const mergeBase = Effect.fn("checkout.merge_base")(function* (repo: RepoName, one: CommitSha, other: CommitSha) {
    const args = git(repo, "merge-base", one, other)
    const sha = (yield* runWhole(args)).stdout.trim()
    return yield* Schema.decodeUnknownEffect(CommitSha)(sha).pipe(
      Effect.mapError(() => new CommitMissing({ sha: `${one}...${other}`, message: `${one} and ${other} have no commit in common in ${repo}` })),
    )
  }, provided)

  return Checkout.of({ fetch, diff, show, worktree, entry, blob, files, grep, mergeBase })
}))
