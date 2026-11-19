import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Layer, Option, Result } from "effect"
import { gitCheckout } from "./checkout-git.adapter.js"
import { Checkout } from "./checkout.port.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { attributesOf, fileVerdict } from "./file-verdict.entity.functions.js"
import { AWKWARD_NAME, BIG_LINES, gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { BranchName, CommitSha, PullNumber, RepoName } from "./pull-request.entity.js"

const fixture = gitFixture()
afterAll(() => fixture.cleanup())

const repo = RepoName.make("owner/project")
const base = { ref: BranchName.make("main"), sha: CommitSha.make(fixture.left) }
const head = CommitSha.make(fixture.head)

const checkoutLayer = (cacheRoot: string) =>
  gitCheckout({ cacheRoot, remoteUrl: () => fixture.remote }).pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))

const run = <A, E>(use: (checkout: Checkout["Service"]) => Effect.Effect<A, E>, cacheRoot = fixture.cacheRoot) =>
  Effect.runPromiseExit(Effect.gen(function* () {
    return yield* use(yield* Checkout)
  }).pipe(Effect.provide(checkoutLayer(cacheRoot))))

const value = <A, E>(exit: Exit.Exit<A, E>): A => Exit.match(exit, { onSuccess: (a) => a, onFailure: (cause) => Effect.runSync(Effect.die(cause)) })

describe("gitCheckout", () => {
  test("clones once, fetches the head, and reads the diff from where the head left the base, whole past 8 KiB", async () => {
    const text = value(await run((checkout) => Effect.andThen(checkout.fetch(repo, PullNumber.make(1), base, head), checkout.diff(repo, base.sha, head))))
    expect(text.length).toBeGreaterThan(8192)
    const files = Result.getOrThrow(parseUnifiedDiff(text))
    expect(files.map((file) => [file.path, file.change, file.additions, file.deletions])).toEqual([
      ["bun.lock", "added", 1, 0],
      ["docs/old.md", "modified", 0, 2],
      ["gen/out.ts", "added", 1, 0],
      ["src/AGENTS.md", "modified", 1, 1],
      [AWKWARD_NAME, "added", 1, 0],
      ["src/big.ts", "added", BIG_LINES, 0],
      ["src/sum.ts", "modified", 1, 1],
    ])
    // The base's later commit (README.md) is not in a diff from where the head left the base.
    expect(files.some((file) => file.path === "README.md")).toBe(false)
    expect(existsSync(join(fixture.cacheRoot, "owner", "project", "mirror.git", "HEAD"))).toBe(true)
  })

  test("with .gitattributes at the base, the verdicts drop the lockfile, the generated and the deletion-only files", async () => {
    const [text, attributes] = value(await run((checkout) => Effect.all([checkout.diff(repo, base.sha, head), checkout.show(repo, base.sha, ".gitattributes")], { concurrency: 1 })))
    const rules = attributesOf(Option.getOrElse(attributes, () => ""))
    const verdicts = Result.getOrThrow(parseUnifiedDiff(text)).map((file) => fileVerdict(file.path, file, rules))
    expect(verdicts.flatMap((verdict) => (verdict._tag === "Dropped" ? [[verdict.path, verdict.reason]] : []))).toEqual([
      ["bun.lock", "lockfile"],
      ["docs/old.md", "deletion-only"],
      ["gen/out.ts", "generated"],
    ])
  })

  test("show reads a file at a commit: the base's rules, not the head's; none for a link, a missing file or a folder", async () => {
    const shown = value(await run((checkout) => Effect.forEach(
      [[base.sha, "src/AGENTS.md"], [head, "src/AGENTS.md"], [base.sha, "CLAUDE.md"], [base.sha, "REVIEW.md"], [base.sha, "src"], [head, AWKWARD_NAME]] as const,
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
    ])
  })

  test("a worktree holds the head while its scope is open and is gone after", async () => {
    const seen = value(await run((checkout) => Effect.scoped(Effect.map(checkout.worktree(repo, head), (path) => ({ path, sum: readFileSync(join(path, "src/sum.ts"), "utf8") })))))
    expect(seen.sum).toContain("total += value * 1")
    expect(existsSync(seen.path)).toBe(false)
  })

  test("fetching again reuses the clone", async () => {
    const exit = await run((checkout) => checkout.fetch(repo, PullNumber.make(1), base, head))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a commit the remote does not have is CommitMissing", async () => {
    const exit = await run((checkout) => checkout.fetch(repo, PullNumber.make(1), base, CommitSha.make("0".repeat(40))))
    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag).toBe("CommitMissing")
  })

  test("a cache root inside a git repository, or not absolute, is refused", async () => {
    for (const root of [join(fixture.remote, "cache"), "relative/cache"]) {
      const exit = await run((checkout) => checkout.diff(repo, base.sha, head), root)
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      expect(reason?._tag === "Fail" && reason.error._tag).toBe("CacheRootRefused")
    }
  })
})
