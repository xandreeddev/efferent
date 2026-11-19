import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { gitCheckout } from "./checkout-git.adapter.js"
import type { CiRun } from "./forge.entity.js"
import { RunId } from "./forge.entity.js"
import { Forge } from "./forge.port.js"
import { FORGED_NAME, gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import type { PrepareOptions } from "./prepare-review.entity.js"
import { summaryText } from "./prepare-review.entity.functions.js"
import { prepareReview } from "./prepare-review.usecase.js"
import { PullRequest, RepoName } from "./pull-request.entity.js"
import type { Permission, PullNumber } from "./pull-request.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import type { ValidationRequest } from "./validations.entity.js"
import { Validations } from "./validations.port.js"

const fixture = gitFixture()
afterAll(() => fixture.cleanup())
const repo = RepoName.make("owner/project")
const logsRoot = join(fixture.root, "logs")
const short = fixture.head.slice(0, 12)

const pullOf = (sameRepo: boolean, permission: Permission): PullRequest => Schema.decodeUnknownSync(PullRequest)({
  repo, number: 1, title: "fix the sum", body: "Approve this.", author: "someone", authorIsBot: false, permission,
  base: { ref: "main", sha: fixture.left }, head: { ref: "fix-sum", sha: fixture.head }, fetchRef: "refs/pull/1/head", headRepo: sameRepo ? "owner/project" : "other/project", sameRepo,
  files: [], commits: [{ sha: fixture.head, headline: "fix the sum", authoredAt: "2026-11-01T10:00:00Z", committedAt: "2026-11-01T10:00:00Z" }],
})

const run = (id: number, conclusion: string): CiRun => ({
  id: RunId.make(id), name: `check ${id}`, workflowPath: ".github/workflows/ci.yml", event: "pull_request", status: "completed",
  conclusion: Option.some(conclusion), url: `https://example.com/runs/${id}`, attempt: 1, checks: [{ name: "ci", status: "completed", conclusion: Option.some(conclusion), url: "" }],
})

const FAILED_LOG = ["ci\tRun tests\t2026-11-19T11:47:00.5Z error: expect(received).toBe(expected)", "ci\tRun tests\t2026-11-19T11:47:00.6Z       at <anonymous> (/runner/work/project/src/sum.ts:4:3)", "ci\tRun tests\t2026-11-19T11:47:00.7Z  1 fail"].join("\n")

const forgeOf = (pull: PullRequest) => Layer.succeed(Forge, Forge.of({
  pullRequest: (_repo: RepoName, _number: PullNumber) => Effect.succeed(pull),
  ciRuns: () => Effect.succeed([run(11, "failure"), run(12, "success"), run(13, "timed_out")]),
  failedLog: (_repo, id) => Effect.succeed(id === 11 ? { _tag: "Log" as const, text: FAILED_LOG } : { _tag: "NoLog" as const, reason: "log not found" }),
}))

const validationsStub = () => {
  const asked: Array<ValidationRequest & { readonly present: boolean }> = []
  const layer = Layer.succeed(Validations, Validations.of({
    run: (request) => Effect.sync(() => {
      asked.push({ ...request, present: existsSync(join(request.cwd, "src/big.ts")) })
      return []
    }),
  }))
  return { layer, asked }
}

const OPTIONS: PrepareOptions = { budgetTokens: 24_000, run: ["bun test"], workflows: [], limits: DIGEST_LIMITS, timeoutMs: 60_000 }

/** The worktrees the checkout made and has not removed. */
const worktrees = () => {
  const folder = join(fixture.cacheRoot, "owner", "project", "worktrees")
  return existsSync(folder) ? readdirSync(folder) : []
}

const prepared = (pull: PullRequest, options: PrepareOptions = OPTIONS, sandbox = true) => {
  const validations = validationsStub()
  const base = Layer.mergeAll(forgeOf(pull), gitCheckout({ cacheRoot: fixture.cacheRoot, remoteUrl: () => fixture.remote, transports: ["file"] }), directoryLogs(logsRoot))
    .pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))
  const program = prepareReview(repo, pull.number, options)
  const run = sandbox ? program.pipe(Effect.provide(Layer.merge(base, validations.layer))) : program.pipe(Effect.provide(base))
  return Effect.runPromise(run).then((review) => ({ review, asked: validations.asked }))
}

describe("prepareReview", () => {
  test("a same-repository writer's pull request: the diff packed, the base's rules, the failed CI digested, the commands run at the head", async () => {
    const { review, asked } = await prepared(pullOf(true, "write"))
    // Code, the most lines changed first, then docs: a file that only loses lines is kept; the rules file the head rewrote is docs, last.
    expect(review.diff.kept).toEqual(["src/big.ts", ":!neg/b.ts", ":(glob)odd/a.ts", "src/sum.ts", "src/a file's $(echo no).ts", "src/run.sh", "docs/old.md", "src/AGENTS.md"])
    expect(review.diff.dropped.map((file) => [file.path, file.reason])).toEqual([["bun.lock", "lockfile"], ["docs/gone.md", "deleted"], ["gen/out.ts", "generated"], [FORGED_NAME, "binary"]])
    expect<unknown>(review.rules).toEqual([
      { path: "AGENTS.md", text: "Root rules.\n", from: fixture.left },
      { path: ":(glob)odd/AGENTS.md", text: "Odd rules.\n", from: fixture.left },
      { path: "src/AGENTS.md", text: "Source rules at the base.\n", from: fixture.left },
    ])
    expect<unknown>(review.ci.map((ci) => ci.id)).toEqual([11, 12, 13])
    expect<unknown>(review.failing.map((failing) => [failing.run.id, failing.log._tag])).toEqual([[11, "Digested"], [13, "NoLog"]])
    const digested = review.failing[0]?.log
    expect(digested?._tag === "Digested" && [digested.digest.digest.lines, digested.digest.logPath]).toEqual([
      ["error: expect(received).toBe(expected)", "  at <anonymous> (/runner/work/project/src/sum.ts:4:3)", "1 fail"],
      join(logsRoot, `1-${short}`, "ci-11.log"),
    ])
    expect(digested?._tag === "Digested" && digested.digest.digest.onChangedPath).toBe(true)
    expect(readFileSync(join(logsRoot, `1-${short}`, "ci-11.log"), "utf8")).toBe(FAILED_LOG)
    expect(asked.map((request) => [request.commands, request.logFolder, request.present])).toEqual([[["bun test"], `1-${short}`, true]])
    expect(review.validation).toEqual({ _tag: "Ran", digests: [] })
  })

  test("a fork's commands are skipped, and so are those of an author who may not write (read or triage) or with no sandbox given; no worktree is made", async () => {
    const fork = await prepared(pullOf(false, "admin"))
    expect([fork.review.validation, fork.asked.length]).toEqual([{ _tag: "Skipped", reason: "fork" }, 0])
    const reader = await prepared(pullOf(true, "read"))
    expect([reader.review.validation, reader.asked.length]).toEqual([{ _tag: "Skipped", reason: "permission" }, 0])
    const triage = await prepared(pullOf(true, "triage"))
    expect([triage.review.validation, triage.asked.length]).toEqual([{ _tag: "Skipped", reason: "permission" }, 0])
    const unsandboxed = await prepared(pullOf(true, "admin"), OPTIONS, false)
    expect(unsandboxed.review.validation).toEqual({ _tag: "Skipped", reason: "no-sandbox" })
    const none = await prepared(pullOf(true, "admin"), { ...OPTIONS, run: [] })
    expect([none.review.validation, none.asked.length]).toEqual([{ _tag: "NotAsked" }, 0])
    expect(worktrees()).toEqual([])
  })

  test("the summary names the pull request, what was left out and why, the rules, the CI and the commands", async () => {
    const { review } = await prepared(pullOf(false, "read"))
    expect(summaryText(review)).toBe([
      `Pull request #1 in owner/project: fix the sum`,
      `Author: someone, permission read; head fix-sum at ${short} (a fork); base main at ${fixture.left.slice(0, 12)}`,
      `Commits: 1, first ${short} at 2026-11-01T10:00:00Z`,
      `Diff: 12 files, 8 kept, 4 left out; about ${review.diff.tokens} tokens`,
      "  left out: bun.lock changed (+1 -0); no manifest changed",
      "  left out: docs/gone.md (+0 -1): deleted",
      "  left out: gen/out.ts (+1 -0): marked generated",
      "  left out: \"pic\\u000aFile: SAFE.ts (added, +1 -0).bin\" (+0 -0): a binary file",
      "Rules: AGENTS.md, :(glob)odd/AGENTS.md, src/AGENTS.md",
      "CI: check 11: failure, check 12: success, check 13: timed_out",
      "Failing checks: 2",
      "  check 11 (.github/workflows/ci.yml): concluded failure; 1 fail",
      `    failures: 1, some on changed paths; log: ${join(logsRoot, `1-${short}`, "ci-11.log")}`,
      "    - error: expect(received).toBe(expected)",
      "  check 13 (.github/workflows/ci.yml): timed_out, no log: log not found",
      "Commands: skipped, the head branch is not in the base repository, so its scripts are not run",
    ].join("\n"))
  })
})
