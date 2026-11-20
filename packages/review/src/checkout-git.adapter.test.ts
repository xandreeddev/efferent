import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Result } from "effect"
import { gitCheckout } from "./checkout-git.adapter.js"
import type { Transport } from "./checkout.entity.js"
import { entryOf, gitArgv, grepHitsOf, LS_SIZED_ENTRY, neutralFilters } from "./checkout.entity.functions.js"
import { Checkout } from "./checkout.port.js"
import { parseUnifiedDiff, renderDiff } from "./diff.entity.functions.js"
import { attributesOf, fileVerdict } from "./file-verdict.entity.functions.js"
import { AWKWARD_NAME, BIG_LINES, FORGED_NAME, gitFixture, MAGIC_FOLDERS } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { BranchName, CommitSha, FetchRef, RepoName } from "./pull-request.entity.js"

const fixture = gitFixture()
afterAll(() => fixture.cleanup())

const repo = RepoName.make("owner/project")
const base = { ref: BranchName.make("main"), sha: CommitSha.make(fixture.left) }
const head = { sha: CommitSha.make(fixture.head), fetchRef: FetchRef.make("refs/pull/1/head") }

/** A cache root of its own for each test, so no test leans on another's clone. */
const freshCache = () => mkdtempSync(join(fixture.root, "cache-"))

const checkoutLayer = (cacheRoot: string, transports: ReadonlyArray<Transport> = ["file"]) =>
  gitCheckout({ cacheRoot, remoteUrl: () => fixture.remote, transports }).pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))

const run = <A, E>(use: (checkout: Checkout["Service"]) => Effect.Effect<A, E>, cacheRoot = freshCache(), transports?: ReadonlyArray<Transport>) =>
  Effect.runPromiseExit(Effect.gen(function* () {
    return yield* use(yield* Checkout)
  }).pipe(Effect.provide(checkoutLayer(cacheRoot, transports))))

/** Fetch first, then `use`, in one fresh cache. */
const fetched = <A, E>(use: (checkout: Checkout["Service"]) => Effect.Effect<A, E>, cacheRoot = freshCache()) =>
  run((checkout) => Effect.andThen(checkout.fetch(repo, base, head), use(checkout)), cacheRoot)

const value = <A, E>(exit: Exit.Exit<A, E>): A => Exit.match(exit, { onSuccess: (a) => a, onFailure: (cause) => Effect.runSync(Effect.die(cause)) })
const failureTag = <A, E>(exit: Exit.Exit<A, E>) => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return reason?._tag === "Fail" && typeof reason.error === "object" && reason.error !== null && "_tag" in reason.error ? reason.error._tag : "no failure"
}

describe("gitArgv", () => {
  test("no hooks, no monitor, no host attributes or lfs filter, only the transports given, literal paths, then -C and the command", () => {
    const quiet = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.required=false"]
    expect(gitArgv(["https"], "/cache/o/r/mirror.git", ["ls-tree", "-z", "HEAD", "--", ":!x"])).toEqual([
      "git", ...quiet, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "--literal-pathspecs", "-C", "/cache/o/r/mirror.git", "ls-tree", "-z", "HEAD", "--", ":!x",
    ])
    expect(gitArgv(["file"], null, ["clone"])).toEqual([
      "git", ...quiet, "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "--literal-pathspecs", "clone",
    ])
  })

  test("neutralFilters turns off every driver the host's config defines, a name with dots included", () => {
    expect(neutralFilters("filter.lfs.smudge git-lfs smudge -- %f\nfilter.lfs.required true\nfilter.crypt.v2.clean x\ncore.bare false\n")).toEqual([
      ...["smudge=", "clean=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.lfs.${setting}`]),
      ...["smudge=", "clean=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.crypt.v2.${setting}`]),
    ])
    expect(neutralFilters("")).toEqual([])
  })

  test("a clone's checkout runs no filter driver of the host's that the head's own .gitattributes names; plain git, the control, does", async () => {
    // A repository whose head commits `* filter=crypt`, and a host whose config defines that driver.
    const remote = mkdtempSync(join(fixture.root, "driver-remote-"))
    const git = (...args: ReadonlyArray<string>) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-C", remote, ...args], { env: fixture.env }).toString().trim()
    git("init", "--quiet", "-b", "main")
    writeFileSync(join(remote, "a.txt"), "a\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "base")
    const baseSha = CommitSha.make(git("rev-parse", "HEAD"))
    writeFileSync(join(remote, ".gitattributes"), "* filter=crypt\n")
    writeFileSync(join(remote, "b.txt"), "b\n")
    git("add", "-A")
    git("commit", "--quiet", "-m", "head")
    const headSha = CommitSha.make(git("rev-parse", "HEAD"))
    git("update-ref", "refs/pull/9/head", headSha)
    git("reset", "--quiet", "--hard", baseSha)
    const marker = join(fixture.root, "driver-ran")
    const env = { ...fixture.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.crypt.smudge", GIT_CONFIG_VALUE_0: `touch ${marker}; cat` }
    const layer = gitCheckout({ cacheRoot: freshCache(), remoteUrl: () => remote, transports: ["file"] }).pipe(Layer.provide(hostShell({ cwd: fixture.root, env })))
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const checkout = yield* Checkout
      yield* checkout.fetch(repo, { ref: BranchName.make("main"), sha: baseSha }, { sha: headSha, fetchRef: FetchRef.make("refs/pull/9/head") })
      return yield* Effect.scoped(Effect.map(checkout.clone(repo, headSha), (path) => readFileSync(join(path, "b.txt"), "utf8")))
    }).pipe(Effect.provide(layer)))
    expect([Exit.isSuccess(exit) ? exit.value : "failed", existsSync(marker)]).toEqual(["b\n", false])
    git("update-ref", "refs/heads/head", headSha)
    execFileSync("git", ["clone", "--quiet", "--branch", "head", remote, join(fixture.root, "driver-plain")], { env })
    expect(existsSync(marker)).toBe(true)
  })

  test("a clone's checkout runs no lfs filter and reads no attributes file of the host's; plain git, the control, does run it", async () => {
    const marker = join(fixture.root, "lfs-ran")
    const attributes = join(fixture.root, "host-attributes")
    writeFileSync(attributes, "* filter=lfs\n")
    const env = { ...fixture.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.attributesFile", GIT_CONFIG_VALUE_0: attributes, GIT_CONFIG_KEY_1: "filter.lfs.smudge", GIT_CONFIG_VALUE_1: `touch ${marker}; cat` }
    const layer = gitCheckout({ cacheRoot: freshCache(), remoteUrl: () => fixture.remote, transports: ["file"] }).pipe(Layer.provide(hostShell({ cwd: fixture.root, env })))
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const checkout = yield* Checkout
      yield* checkout.fetch(repo, base, head)
      return yield* Effect.scoped(checkout.clone(repo, head.sha))
    }).pipe(Effect.provide(layer)))
    expect([Exit.isSuccess(exit), existsSync(marker)]).toEqual([true, false])
    execFileSync("git", ["clone", "--quiet", fixture.remote, join(fixture.root, "plain-clone")], { env })
    expect(existsSync(marker)).toBe(true)
  })
})

describe("the tree's entries and a search's lines, as git prints them", () => {
  test("entryOf: a regular file by its blob and size, a link, a submodule, a folder; any other mode is no file", () => {
    const blob = "a".repeat(40)
    expect<unknown>([entryOf("100644", "blob", blob, 12), entryOf("100755", "blob", blob, 0), entryOf("120000", "blob", blob, 9), entryOf("160000", "commit", blob, Number.NaN), entryOf("040000", "tree", blob, Number.NaN), entryOf("100664", "blob", blob, 3), entryOf("100644", "blob", "not-a-sha", 3), entryOf("100644", "blob", blob, Number.NaN)]).toEqual([
      { _tag: "File", blob, bytes: 12 }, { _tag: "File", blob, bytes: 0 }, { _tag: "Link" }, { _tag: "Submodule" }, { _tag: "Folder" }, { _tag: "Missing" }, { _tag: "Missing" }, { _tag: "Missing" },
    ])
  })

  test("the sized listing: ls-tree -l pads a size with spaces, and a tree's is -", () => {
    expect(LS_SIZED_ENTRY.exec(`100644 blob ${"a".repeat(40)}    1234\tsrc/a b.ts`)?.slice(1, 5)).toEqual(["100644", "blob", "a".repeat(40), "1234"])
    expect(LS_SIZED_ENTRY.exec(`040000 tree ${"b".repeat(40)}       -\tsrc`)?.slice(1, 5)).toEqual(["040000", "tree", "b".repeat(40), "-"])
  })

  test("grepHitsOf: commit:path NUL line NUL text, a path with a line feed or a colon read whole, a line number that is none passed over", () => {
    const at = "c".repeat(40)
    const output = `${at}:src/a.ts\u00003\u0000  const a = 1\n${at}:odd\nname:x.ts\u000012\u0000b: c\n${at}:src/b.ts\u0000zero\u0000skip\n`
    expect(grepHitsOf(output, at)).toEqual([{ path: "src/a.ts", line: 3, text: "  const a = 1" }, { path: "odd\nname:x.ts", line: 12, text: "b: c" }])
    expect(grepHitsOf("", at)).toEqual([])
  })
})

describe("gitCheckout", () => {
  test("clones, fetches the head by the forge's ref, and reads the diff from where the head left the base, whole past 8 KiB", async () => {
    const cacheRoot = freshCache()
    const text = value(await fetched((checkout) => checkout.diff(repo, base.sha, head.sha), cacheRoot))
    expect(text.length).toBeGreaterThan(8192)
    const files = Result.getOrThrow(parseUnifiedDiff(text))
    expect(files.map((file) => [file.path, file.change, file.additions, file.deletions])).toEqual([
      [`${MAGIC_FOLDERS[1]}/b.ts`, "modified", 1, 1],
      [`${MAGIC_FOLDERS[0]}/a.ts`, "modified", 1, 1],
      ["bun.lock", "added", 1, 0],
      ["docs/gone.md", "deleted", 0, 1],
      ["docs/old.md", "modified", 0, 2],
      ["gen/out.ts", "added", 1, 0],
      [FORGED_NAME, "added", 0, 0],
      ["src/AGENTS.md", "modified", 1, 1],
      [AWKWARD_NAME, "added", 1, 0],
      ["src/big.ts", "added", BIG_LINES, 0],
      ["src/run.sh", "modified", 0, 0],
      ["src/sum.ts", "modified", 1, 1],
    ])
    // The base's later commit (README.md) is not in a diff from where the head left the base.
    expect(files.some((file) => file.path === "README.md")).toBe(false)
    expect(existsSync(join(cacheRoot, "owner", "project", "mirror.git", "HEAD"))).toBe(true)
  })

  test("a binary file whose name forges a header, and a mode change, read from git's own output and rendered escaped", async () => {
    const files = Result.getOrThrow(parseUnifiedDiff(value(await fetched((checkout) => checkout.diff(repo, base.sha, head.sha)))))
    const forged = files.filter((file) => file.path === FORGED_NAME || file.path === "src/run.sh")
    expect(renderDiff(forged)).toBe([
      "File: \"pic\\u000aFile: SAFE.ts (added, +1 -0).bin\" (added, +0 -0, binary, not shown)",
      "",
      "File: src/run.sh (modified, mode 100644 to 100755, +0 -0)",
    ].join("\n"))
  })

  test("with .gitattributes at the base, the verdicts drop the lockfile, the generated, the binary and the deleted files, and keep one that only loses lines", async () => {
    const [text, attributes] = value(await fetched((checkout) => Effect.all([checkout.diff(repo, base.sha, head.sha), checkout.show(repo, base.sha, ".gitattributes")], { concurrency: 1 })))
    const rules = attributesOf(Option.getOrElse(attributes, () => ""))
    const verdicts = Result.getOrThrow(parseUnifiedDiff(text)).map((file) => fileVerdict(file.path, file, rules))
    expect(verdicts.flatMap((verdict) => (verdict._tag === "Dropped" ? [[verdict.path, verdict.reason]] : []))).toEqual([
      ["bun.lock", "lockfile"],
      ["docs/gone.md", "deleted"],
      ["gen/out.ts", "generated"],
      [FORGED_NAME, "binary"],
    ])
  })

  test("show reads a file at a commit, its path literal: the base's rules, not the head's; none for a link, a missing file or a folder", async () => {
    const shown = value(await fetched((checkout) => Effect.forEach(
      [
        [base.sha, "src/AGENTS.md"], [head.sha, "src/AGENTS.md"], [base.sha, "CLAUDE.md"], [base.sha, "REVIEW.md"], [base.sha, "src"],
        [head.sha, AWKWARD_NAME], [base.sha, `${MAGIC_FOLDERS[0]}/AGENTS.md`], [base.sha, `${MAGIC_FOLDERS[1]}/AGENTS.md`],
      ] as const,
      ([at, path]) => checkout.show(repo, at, path),
      { concurrency: 1 },
    )))
    expect(shown).toEqual([
      Option.some("Source rules at the base.\n"),
      Option.some("Source rules the pull request rewrote.\n"),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.some("export const awkward = true\n"),
      Option.some("Odd rules.\n"),
      Option.none(),
    ])
  })

  test("a worktree holds the head while its scope is open and is gone after, whether the scope succeeds, fails or is interrupted", async () => {
    const cacheRoot = freshCache()
    const seen = value(await fetched((checkout) => Effect.scoped(Effect.map(checkout.worktree(repo, head.sha), (path) => ({ path, sum: readFileSync(join(path, "src/sum.ts"), "utf8") }))), cacheRoot))
    expect(seen.sum).toContain("total += value * 1")
    expect(existsSync(seen.path)).toBe(false)

    let failedIn = ""
    const failed = await run((checkout) => Effect.scoped(Effect.flatMap(checkout.worktree(repo, head.sha), (path) => {
      failedIn = path
      return Effect.fail("the review failed")
    })), cacheRoot)
    expect([Exit.isFailure(failed), failedIn.length > 0, existsSync(failedIn)]).toEqual([true, true, false])

    const interrupted = value(await run((checkout) => Effect.gen(function* () {
      const made = yield* Deferred.make<string>()
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(checkout.worktree(repo, head.sha), (path) => Effect.andThen(Deferred.succeed(made, path), Effect.never))))
      const path = yield* Deferred.await(made)
      const there = existsSync(path)
      yield* Fiber.interrupt(fiber)
      return { path, there }
    }), cacheRoot))
    expect([interrupted.there, existsSync(interrupted.path)]).toEqual([true, false])
  })

  test("a clone holds the commit in a folder that shares nothing with the shared clone, and is deleted with its scope", async () => {
    const cacheRoot = freshCache()
    const seen = value(await fetched((checkout) => Effect.scoped(Effect.map(checkout.clone(repo, head.sha), (path) => {
      const objects = join(path, ".git", "objects")
      return {
        path,
        sum: readFileSync(join(path, "src/sum.ts"), "utf8"),
        alternates: existsSync(join(objects, "info", "alternates")),
        hooks: existsSync(join(path, ".git", "hooks")) ? readdirSync(join(path, ".git", "hooks")) : [],
        linked: readdirSync(objects, { recursive: true }).map(String).filter((name) => /^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(name) || name.endsWith(".pack")).some((name) => statSync(join(objects, name)).nlink > 1),
        worktrees: existsSync(join(cacheRoot, "owner", "project", "mirror.git", "worktrees")),
      }
    })), cacheRoot))
    expect(seen.sum).toContain("total += value * 1")
    expect([seen.alternates, seen.hooks, seen.linked, seen.worktrees]).toEqual([false, [], false, false])
    expect(seen.path.startsWith(join(cacheRoot, "owner", "project", "clones"))).toBe(true)
    expect(existsSync(seen.path)).toBe(false)

    let failedIn = ""
    const failed = await run((checkout) => Effect.scoped(Effect.flatMap(checkout.clone(repo, base.sha), (path) => {
      failedIn = path
      return Effect.fail("the review failed")
    })), cacheRoot)
    expect([Exit.isFailure(failed), failedIn.length > 0, existsSync(failedIn)]).toEqual([true, true, false])
    expect(failureTag(await run((checkout) => Effect.scoped(checkout.clone(repo, CommitSha.make("0".repeat(40)))), cacheRoot))).toBe("CommitMissing")
    expect(readdirSync(join(cacheRoot, "owner", "project", "clones"))).toEqual([])
  })

  test("fetching again reuses the clone", async () => {
    const cacheRoot = freshCache()
    expect(Exit.isSuccess(await fetched(() => Effect.void, cacheRoot))).toBe(true)
    expect(Exit.isSuccess(await fetched(() => Effect.void, cacheRoot))).toBe(true)
  })

  test("a commit the remote does not have is CommitMissing", async () => {
    const exit = await run((checkout) => checkout.fetch(repo, base, { ...head, sha: CommitSha.make("0".repeat(40)) }))
    expect(failureTag(exit)).toBe("CommitMissing")
  })

  test("a transport not allowed is refused by git: a folder remote with only https allowed does not clone", async () => {
    const exit = await run((checkout) => checkout.fetch(repo, base, head), freshCache(), ["https"])
    expect(failureTag(exit)).toBe("CommandFailed")
  })

  test("a cache root inside a git repository, or not absolute, is refused", async () => {
    for (const root of [join(fixture.remote, "cache"), "relative/cache"]) {
      expect(failureTag(await run((checkout) => checkout.diff(repo, base.sha, head.sha), root))).toBe("CacheRootRefused")
    }
  })
})
