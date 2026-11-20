import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Option } from "effect"
import { Shell } from "@xandreed/sdk"
import type { Ran } from "@xandreed/sdk"
import { processShell } from "@xandreed/sdk/node"
import { Checkout } from "./checkout.port.js"
import { reviewLayers, validationLayers } from "./cli.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import { Forge } from "./forge.port.js"
import { BranchName, CommitSha, RepoName } from "./pull-request.entity.js"
import { NOT_ALLOWED } from "./repo-profile.entity.js"
import { directoryCache } from "./review-cache.adapter.js"
import type { ReviewCache } from "./review-cache.port.js"
import { directoryLogs } from "./review-logs.adapter.js"
import type { ReviewLogs } from "./review-logs.port.js"
import type { SandboxPlan } from "./sandbox.entity.js"
import { Sandboxes } from "./sandboxes.port.js"
import { sandboxValidations } from "./validations.adapter.js"
import type { ValidationRequest, ValidationRun } from "./validations.entity.js"
import { allowOnly, RESTORE_SNAPSHOT, SAVE_SNAPSHOT } from "./validations.entity.functions.js"
import { Validations } from "./validations.port.js"

const root = mkdtempSync(join(tmpdir(), "review-validations-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const PATH = process.env["PATH"] ?? "/usr/bin:/bin"
const repo = RepoName.make("owner/project")
const BASE = CommitSha.make("b".repeat(40))
const HEAD = CommitSha.make("c".repeat(40))
const INSTALL = "BUN_INSTALL_CACHE_DIR=/cache /opt/tool/bin/bun install --frozen-lockfile --ignore-scripts --backend=copyfile"
const VERSION = "/opt/tool/bin/bun --version"

const AGENTS = ["# Rules", "## Definition of done", "```bash", "bun install --frozen-lockfile", "bun run typecheck", "bun test", "test -z \"$(git status --porcelain)\"", "```"].join("\n")
const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", build: "x" } }),
  "packages/a/package.json": "{}",
  "bun.lock": "{ lockfile }",
  "AGENTS.md": AGENTS,
  "src/sum.ts": "export const sum = 1\n",
}
const HEAD_FILES: Readonly<Record<string, string>> = { ...BASE_FILES, "src/sum.ts": "export const sum = 2\n" }

const ran = (code: number, stdout = ""): Ran => ({ stdout, stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "Exited", code } })

/**
 * A checkout over files held in memory: `show` and `files` read them by commit, `clone` makes an empty folder;
 * `onBranch` says whether the base is on the default branch, and `links` the paths that are no regular file.
 */
const checkoutOf = (files: Readonly<Record<string, Readonly<Record<string, string>>>>, onBranch = true, links: Readonly<Record<string, ReadonlyArray<string>>> = {}) => Layer.succeed(Checkout, Checkout.of({
  notRegular: (_repo, at) => Effect.succeed(links[at] ?? []),
  fetch: () => Effect.void,
  diff: () => Effect.succeed(""),
  show: (_repo, at, path) => Effect.succeed(Option.fromNullishOr(files[at]?.[path])),
  worktree: () => Effect.die("no worktree in these tests"),
  clone: (_repo, at) => Effect.sync(() => mkdtempSync(join(root, `clone-${at.slice(0, 1)}-`))),
  entry: () => Effect.die("no tree in these tests"),
  blob: () => Effect.die("no blob in these tests"),
  files: (_repo, at) => Effect.succeed(Object.keys(files[at] ?? {})),
  grep: () => Effect.die("no search in these tests"),
  mergeBase: () => Effect.die("no merge base in these tests"),
  changedPaths: () => Effect.die("no paths in these tests"),
  onBranch: () => Effect.succeed(onBranch),
}))

/** The forge, for its default branch alone. */
const forge = Layer.succeed(Forge, Forge.of({
  pullRequest: () => Effect.die("no pull request in these tests"),
  ciRuns: () => Effect.die("no runs in these tests"),
  firstHead: () => Effect.die("no first head in these tests"),
  descriptionHistory: () => Effect.die("no description in these tests"),
  failedLog: () => Effect.die("no log in these tests"),
  defaultBranch: () => Effect.succeed(BranchName.make("main")),
}))

interface Asked {
  readonly side: string
  readonly plan: SandboxPlan
  readonly command: string
}

/** Sandboxes that run nothing: each command is recorded with its plan and answered by `answer`, after `delayMs`. */
const sandboxesOf = (answer: (side: string, command: string) => Ran, delayMs = 0) => {
  const asked: Array<Asked> = []
  const layer = Layer.succeed(Sandboxes, Sandboxes.of({
    tools: ["bun", "node"],
    shell: (plan) => Effect.succeed(Shell.of({
      run: (request) => Effect.gen(function* () {
        const side = plan.workDir.includes("/scratch/") ? "scratch" : plan.workDir.includes("clone-c") ? "head" : "base"
        asked.push({ side, plan, command: request.command })
        if (delayMs > 0) yield* Effect.sleep(delayMs)
        return request.command === VERSION ? ran(0, "1.3.0\n") : answer(side, request.command)
      }),
    })),
  }))
  return { layer, asked }
}

const request = (over: Partial<ValidationRequest> = {}): ValidationRequest => ({
  repo, base: BASE, head: HEAD, run: [], profile: true, changedPaths: ["src/sum.ts"], limits: DIGEST_LIMITS, logFolder: "7-abc", commandTimeoutMs: 60_000, budgetMs: 600_000, ...over,
})

const validated = (cache: string, files: Readonly<Record<string, Readonly<Record<string, string>>>>, sandboxes: ReturnType<typeof sandboxesOf>, asked: ValidationRequest, checkout = checkoutOf(files)) =>
  Effect.runPromise(Effect.gen(function* () {
    return yield* (yield* Validations).run(asked)
  }).pipe(Effect.provide(sandboxValidations.pipe(Layer.provide(Layer.mergeAll(checkout, forge, sandboxes.layer, directoryLogs(join(cache, "logs")), directoryCache(cache)))))))

const ranOf = (run: ValidationRun) => run._tag === "Ran" ? run : undefined
const shape = (asked: ReadonlyArray<Asked>) => asked.filter((each) => each.side !== "scratch").map((each) => [each.side, each.command, each.plan.network, each.plan.repoBins, each.plan.binds.map((bind) => [bind.inner, bind.writable])])

describe("allowOnly", () => {
  test("runs a listed command as written and refuses any other with ShellRefused, running nothing", async () => {
    const [listed, other] = await Effect.runPromise(Effect.gen(function* () {
      const shell = allowOnly(["echo listed"], yield* Shell)
      return [yield* shell.run({ command: "echo listed" }), yield* Effect.exit(shell.run({ command: `echo listed; touch ${join(root, "ran")}` }))] as const
    }).pipe(Effect.provide(processShell({ cwd: root, env: { PATH } }))))
    expect(listed.stdout).toBe("listed\n")
    const reason = Exit.isFailure(other) ? other.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag).toBe("ShellRefused")
    expect(existsSync(join(root, "ran"))).toBe(false)
  })
})

describe("validate", () => {
  test("only the base installs, with the network and the bot's cache, the bot's commands with no repository bin; the head restores the base's snapshot with no network and no cache", async () => {
    const cache = join(root, "profile")
    const sandboxes = sandboxesOf((side, command) => side === "base" && command === "bun test" ? ran(1, "1 fail") : ran(0))
    const run = ranOf(await validated(cache, { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, sandboxes, request({ run: ["bun run build", "curl x"] })))
    expect(run?.profile).toEqual([
      { command: "bun install --frozen-lockfile", from: "instructions", kept: false, reason: NOT_ALLOWED.install },
      { command: "bun run typecheck", from: "instructions", kept: true, reason: "passed on the base" },
      { command: "bun test", from: "instructions", kept: false, reason: "on the base it exited with 1" },
      { command: "test -z \"$(git status --porcelain)\"", from: "instructions", kept: false, reason: NOT_ALLOWED.syntax },
      { command: "bun run test", from: "script", kept: true, reason: "passed on the base" },
      { command: "bun run build", from: "by-hand", kept: true, reason: "asked for by hand" },
      { command: "curl x", from: "by-hand", kept: false, reason: NOT_ALLOWED.unknown },
    ])
    expect(shape(sandboxes.asked)).toEqual([
      ["base", INSTALL, true, false, [["/cache", true]]],
      ["base", SAVE_SNAPSHOT, false, false, [["/snapshot", true]]],
      ["base", "bun run typecheck", false, true, []],
      ["base", "bun test", false, true, []],
      ["base", "bun run test", false, true, []],
      ["head", RESTORE_SNAPSHOT, false, false, [["/snapshot", false]]],
      ["head", "bun run typecheck", false, true, []],
      ["head", "bun run test", false, true, []],
      ["head", "bun run build", false, true, []],
    ])
    // The version is asked offline, in an empty folder, by the bot.
    expect(sandboxes.asked.filter((each) => each.side === "scratch").map((each) => [each.command, each.plan.network, each.plan.repoBins])).toEqual([[VERSION, false, false]])
    expect(sandboxes.asked[1]?.plan.binds[0]?.host.startsWith(join(cache, "owner", "project", "packages", "bun"))).toBe(true)
    // No sandbox of the head's ever has the network or a writable bind.
    expect(sandboxes.asked.filter((each) => each.side === "head").some((each) => each.plan.network || each.plan.binds.some((bind) => bind.writable))).toBe(false)
    expect(run?.digests.map((digest) => [digest.source, digest.logPath])).toEqual([
      [{ _tag: "Command", command: "bun run typecheck" }, join(cache, "logs", "7-abc", "head-1.log")],
      [{ _tag: "Command", command: "bun run test" }, join(cache, "logs", "7-abc", "head-2.log")],
      [{ _tag: "Command", command: "bun run build" }, join(cache, "logs", "7-abc", "head-3.log")],
    ])
    expect(readFileSync(join(cache, "logs", "7-abc", "base-2.log"), "utf8")).toBe("1 fail")

    // Again, at the same base: every verdict is known and the snapshot kept, so no clone of the base is made.
    const again = sandboxesOf(() => ran(0))
    const second = ranOf(await validated(cache, { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, again, request()))
    expect(second?.profile.filter((entry) => entry.from !== "by-hand").filter((entry) => entry.command.startsWith("bun run") || entry.command === "bun test").map((entry) => [entry.command, entry.kept, entry.reason])).toEqual([
      ["bun run typecheck", true, "passed on this base before"],
      ["bun test", false, "on the base it exited with 1 (known from an earlier review)"],
      ["bun run test", true, "passed on this base before"],
    ])
    expect(shape(again.asked).map(([side, command]) => [side, command])).toEqual([["head", RESTORE_SNAPSHOT], ["head", "bun run typecheck"], ["head", "bun run test"]])

    // Another base, the same files: verdicts are per base, so each is asked again, and the base installs again.
    const MOVED = CommitSha.make("d".repeat(40))
    const moved = sandboxesOf(() => ran(0))
    await validated(cache, { [MOVED]: BASE_FILES, [HEAD]: HEAD_FILES }, moved, request({ base: MOVED }))
    expect(shape(moved.asked).filter(([side]) => side === "base").map(([, command]) => command)).toEqual([INSTALL, SAVE_SNAPSHOT, "bun run typecheck", "bun test", "bun run test"])
    expect(readdirSync(join(cache, "owner", "project", "node-modules")).length).toBe(2)
  })

  test("a base not on the default branch runs nothing, called directly too: no install, no snapshot, no verdict", async () => {
    const cache = join(root, "untrusted")
    const sandboxes = sandboxesOf(() => ran(0))
    const run = await validated(cache, { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, sandboxes, request({ run: ["bun test"] }), checkoutOf({ [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, false))
    expect([run, sandboxes.asked, existsSync(join(cache, "owner"))]).toEqual([{ _tag: "Refused", reason: "the base is not on the repository's default branch, so nothing is installed or run" }, [], false])
  })

  test("a dependency file that is a link or a submodule at either end runs nothing", async () => {
    for (const links of [{ [HEAD]: ["package.json"] }, { [BASE]: ["packages/a/package.json"] }, { [HEAD]: ["patches/x.patch"] }]) {
      const sandboxes = sandboxesOf(() => ran(0))
      const run = await validated(join(root, "links"), { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, sandboxes, request(), checkoutOf({ [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, true, links))
      expect([run, sandboxes.asked]).toEqual([{ _tag: "Refused", reason: "a dependency file is a link or a submodule, so nothing is installed or run" }, []])
    }
  })

  test("a head whose dependency files differ from the base's runs nothing: a lockfile, any workspace's package.json, a manager's config, a patch", async () => {
    for (const [path, text] of [["bun.lock", "{ changed }"], ["packages/a/package.json", "{ \"x\": 1 }"], ["packages/b/package.json", "{}"], [".npmrc", "registry=x"], ["bunfig.toml", "[install]"], ["patches/left-pad.patch", "+x"]] as const) {
      const sandboxes = sandboxesOf(() => ran(0))
      const run = await validated(join(root, `deps-${path.length}`), { [BASE]: BASE_FILES, [HEAD]: { ...HEAD_FILES, [path]: text } }, sandboxes, request({ run: ["bun test"] }))
      expect([run, sandboxes.asked]).toEqual([{ _tag: "Refused", reason: "dependencies changed: not validated locally (CI covers it)" }, []])
    }
  })

  test("a base that does not install runs nothing on the head; a budget spent leaves the rest unrun", async () => {
    const broken = sandboxesOf((side, command) => side === "base" && command === INSTALL ? ran(1) : ran(0))
    const failed = ranOf(await validated(join(root, "fails"), { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, broken, request({ profile: false, run: ["bun test", "bun run build"] })))
    expect([failed?.digests, failed?.unrun]).toEqual([[], [{ command: "bun test", reason: "the base's install could not be restored on the head" }, { command: "bun run build", reason: "the base's install could not be restored on the head" }]])
    expect(broken.asked.filter((each) => each.side === "head").map((each) => each.command)).toEqual([])

    const slow = sandboxesOf(() => ran(0), 700)
    const spent = ranOf(await validated(join(root, "slow"), { [BASE]: BASE_FILES, [HEAD]: HEAD_FILES }, slow, request({ profile: false, run: ["bun test", "bun run build"], budgetMs: 2_200 })))
    expect([spent?.digests.map((digest) => digest.source), spent?.unrun]).toEqual([[{ _tag: "Command", command: "bun test" }], [{ command: "bun run build", reason: "the clone's time budget ran out before it ran" }]])
  })

  test("a base with no lockfile, or a manager the host lacks, runs nothing and says why", async () => {
    const sandboxes = sandboxesOf(() => ran(0))
    const none = await validated(join(root, "none"), { [BASE]: { "package.json": "{}" }, [HEAD]: {} }, sandboxes, request())
    const pnpm = await validated(join(root, "pnpm"), { [BASE]: { "pnpm-lock.yaml": "x" }, [HEAD]: {} }, sandboxes, request())
    expect([none, pnpm, sandboxes.asked]).toEqual([
      { _tag: "Refused", reason: "the base has no lockfile (bun.lock, pnpm-lock.yaml, yarn.lock or package-lock.json), so nothing is installed" },
      { _tag: "Refused", reason: "the repository installs with pnpm, which the host does not have" },
      [],
    ])
  })

  test("type-level: the validations need sandboxes, a checkout, logs and the cache, never a Shell; the command line gives Validations only with --run or --validate, and never a Shell", () => {
    type Needs<L> = L extends Layer.Layer<infer _Out, infer _Error, infer In> ? In : never
    type Gives<L> = L extends Layer.Layer<infer Out, infer _Error, infer _In> ? Out : never
    type ValidationNeeds = Needs<typeof sandboxValidations>
    const needs: [Checkout | Forge | Sandboxes | ReviewLogs | ReviewCache] extends [ValidationNeeds] ? true : false = true
    const noShellNeeded: [Shell] extends [ValidationNeeds] ? false : true = true
    type Plain = Gives<ReturnType<typeof reviewLayers>>
    type Asked = Gives<ReturnType<typeof validationLayers>>
    const plain: [Validations] extends [Plain] ? false : true = true
    const asked: [Validations] extends [Asked] ? true : false = true
    const noShell: [Shell] extends [Plain | Asked] ? false : true = true
    expect([needs, noShellNeeded, plain, asked, noShell]).toEqual([true, true, true, true, true])
  })
})
