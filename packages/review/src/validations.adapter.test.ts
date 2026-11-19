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
import { CommitSha, RepoName } from "./pull-request.entity.js"
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
const INSTALL = "BUN_INSTALL_CACHE_DIR=/cache bun install --frozen-lockfile --ignore-scripts --backend=copyfile"

const AGENTS = ["# Rules", "## Definition of done", "```bash", "bun install --frozen-lockfile", "bun run typecheck", "bun test", "test -z \"$(git status --porcelain)\"", "```"].join("\n")
const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", build: "x" } }),
  "bun.lock": "{ lockfile }",
  "AGENTS.md": AGENTS,
}

const ran = (code: number, stdout = ""): Ran => ({ stdout, stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "Exited", code } })

/** A checkout over files held in memory: `show` reads them by commit, `clone` makes an empty folder. */
const checkoutOf = (files: Readonly<Record<string, Readonly<Record<string, string>>>>) => Layer.succeed(Checkout, Checkout.of({
  fetch: () => Effect.void,
  diff: () => Effect.succeed(""),
  show: (_repo, at, path) => Effect.succeed(Option.fromNullishOr(files[at]?.[path])),
  worktree: () => Effect.die("no worktree in these tests"),
  clone: (_repo, at) => Effect.sync(() => {
    const dir = mkdtempSync(join(root, `clone-${at.slice(0, 1)}-`))
    return dir
  }),
  entry: () => Effect.die("no tree in these tests"),
  blob: () => Effect.die("no blob in these tests"),
  files: () => Effect.die("no files in these tests"),
  grep: () => Effect.die("no search in these tests"),
  mergeBase: () => Effect.die("no merge base in these tests"),
  changedPaths: () => Effect.die("no paths in these tests"),
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
        const side = plan.workDir.includes("clone-c") ? "head" : "base"
        asked.push({ side, plan, command: request.command })
        if (delayMs > 0) yield* Effect.sleep(delayMs)
        return answer(side, request.command)
      }),
    })),
  }))
  return { layer, asked }
}

const request = (over: Partial<ValidationRequest> = {}): ValidationRequest => ({
  repo, base: BASE, head: HEAD, run: [], profile: true, changedPaths: ["src/sum.ts"], limits: DIGEST_LIMITS, logFolder: "7-abc", commandTimeoutMs: 60_000, budgetMs: 600_000, ...over,
})

const validated = (cache: string, files: Readonly<Record<string, Readonly<Record<string, string>>>>, sandboxes: ReturnType<typeof sandboxesOf>, asked: ValidationRequest) =>
  Effect.runPromise(Effect.gen(function* () {
    return yield* (yield* Validations).run(asked)
  }).pipe(Effect.provide(sandboxValidations.pipe(Layer.provide(Layer.mergeAll(checkoutOf(files), sandboxes.layer, directoryLogs(join(cache, "logs")), directoryCache(cache)))))))

const ranOf = (run: ValidationRun) => run._tag === "Ran" ? run : undefined

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
  test("the profile asked on the base: the install with the network and the bot's cache, each check offline; only what passed runs on the head, from the base's snapshot", async () => {
    const cache = join(root, "profile")
    const sandboxes = sandboxesOf((side, command) => side === "base" && command === "bun test" ? ran(1, "1 fail") : ran(0))
    const run = ranOf(await validated(cache, { [BASE]: BASE_FILES, [HEAD]: BASE_FILES }, sandboxes, request({ run: ["bun run build", "curl x"] })))
    expect(run?.profile).toEqual([
      { command: "bun install --frozen-lockfile", from: "instructions", kept: false, reason: NOT_ALLOWED.install },
      { command: "bun run typecheck", from: "instructions", kept: true, reason: "passed on the base" },
      { command: "bun test", from: "instructions", kept: false, reason: "on the base it exited with 1" },
      { command: "test -z \"$(git status --porcelain)\"", from: "instructions", kept: false, reason: NOT_ALLOWED.syntax },
      { command: "bun run test", from: "script", kept: true, reason: "passed on the base" },
      { command: "bun run build", from: "by-hand", kept: true, reason: "asked for by hand" },
      { command: "curl x", from: "by-hand", kept: false, reason: NOT_ALLOWED.unknown },
    ])
    const packages = join(cache, "owner", "project", "packages", "bun")
    expect(sandboxes.asked.map((each) => [each.side, each.command, each.plan.network, each.plan.binds.map((bind) => [bind.inner, bind.writable, bind.host.startsWith(cache)])])).toEqual([
      ["base", INSTALL, true, [["/cache", true, true]]],
      ["base", SAVE_SNAPSHOT, false, [["/snapshot", true, true]]],
      ["base", "bun run typecheck", false, []],
      ["base", "bun test", false, []],
      ["base", "bun run test", false, []],
      ["head", RESTORE_SNAPSHOT, false, [["/snapshot", false, true]]],
      ["head", "bun run typecheck", false, []],
      ["head", "bun run test", false, []],
      ["head", "bun run build", false, []],
    ])
    expect(sandboxes.asked[0]?.plan.binds[0]?.host).toBe(packages)
    expect(run?.digests.map((digest) => [digest.source, digest.ended, digest.logPath])).toEqual([
      [{ _tag: "Command", command: "bun run typecheck" }, "exited with 0", join(cache, "logs", "7-abc", "head-1.log")],
      [{ _tag: "Command", command: "bun run test" }, "exited with 0", join(cache, "logs", "7-abc", "head-2.log")],
      [{ _tag: "Command", command: "bun run build" }, "exited with 0", join(cache, "logs", "7-abc", "head-3.log")],
    ])
    expect(Option.map(run?.install ?? Option.none(), (digest) => digest.source)).toEqual(Option.some({ _tag: "Command", command: RESTORE_SNAPSHOT }))
    expect(readFileSync(join(cache, "logs", "7-abc", "base-2.log"), "utf8")).toBe("1 fail")

    // Again, at the same base: every verdict is known, so no clone of the base is made.
    const again = sandboxesOf(() => ran(0))
    const second = ranOf(await validated(cache, { [BASE]: BASE_FILES, [HEAD]: BASE_FILES }, again, request()))
    expect(second?.profile.filter((entry) => entry.from !== "by-hand" && entry.from !== "instructions" || entry.command === "bun test" || entry.command === "bun run typecheck").map((entry) => [entry.command, entry.kept, entry.reason])).toEqual([
      ["bun run typecheck", true, "passed on the base before, with this lockfile"],
      ["bun test", false, "on the base it exited with 1 (known from an earlier review)"],
      ["bun run test", true, "passed on the base before, with this lockfile"],
    ])
    expect(again.asked.map((each) => [each.side, each.command])).toEqual([["head", RESTORE_SNAPSHOT], ["head", "bun run typecheck"], ["head", "bun run test"]])

    // Main moved, the lockfile did not: a failure is asked again (it may have been a flake); this time it times out.
    const MOVED = CommitSha.make("d".repeat(40))
    const moved = sandboxesOf((side, command) => command === "bun test" ? { ...ran(0), ended: { _tag: "TimedOut", afterMs: 60_000 } } : ran(0))
    await validated(cache, { [MOVED]: BASE_FILES, [HEAD]: BASE_FILES }, moved, request({ base: MOVED }))
    expect(moved.asked.filter((each) => each.side === "base").map((each) => each.command)).toEqual([RESTORE_SNAPSHOT, "bun test"])
    // A timeout holds for every base with the lockfile.
    const LATER = CommitSha.make("e".repeat(40))
    const later = sandboxesOf(() => ran(0))
    const fourth = ranOf(await validated(cache, { [LATER]: BASE_FILES, [HEAD]: BASE_FILES }, later, request({ base: LATER })))
    expect(later.asked.filter((each) => each.side === "base")).toEqual([])
    expect(fourth?.profile.find((entry) => entry.command === "bun test")?.reason).toBe("on the base it timed out after 60000 ms (known from an earlier review)")
    expect(readdirSync(join(cache, "owner", "project", "node-modules")).length).toBe(1)
  })

  test("a head that changes the registry's config installs with a package cache of its own, thrown away after", async () => {
    const cache = join(root, "config")
    const headFiles = { ...BASE_FILES, ".npmrc": "registry=https://example.com\n" }
    const sandboxes = sandboxesOf(() => ran(0))
    await validated(cache, { [BASE]: BASE_FILES, [HEAD]: headFiles }, sandboxes, request({ profile: false, run: ["bun test"], changedPaths: [".npmrc"] }))
    const install = sandboxes.asked.find((each) => each.side === "head" && each.command === INSTALL)
    const scratch = install?.plan.binds[0]?.host ?? ""
    expect([install?.plan.network, scratch.startsWith(join(cache, "owner", "project", "scratch")), existsSync(scratch)]).toEqual([true, true, false])
  })

  test("a head that does not install runs nothing; a budget spent leaves the rest unrun", async () => {
    const cache = join(root, "fails")
    const broken = sandboxesOf((side, command) => side === "head" && command === INSTALL ? ran(1) : ran(0))
    const failed = ranOf(await validated(cache, { [BASE]: BASE_FILES, [HEAD]: { ...BASE_FILES, "bun.lock": "{ changed }" } }, broken, request({ profile: false, run: ["bun test", "bun run build"] })))
    expect([failed?.digests, failed?.unrun]).toEqual([[], [{ command: "bun test", reason: "the head did not install" }, { command: "bun run build", reason: "the head did not install" }]])

    const slow = sandboxesOf(() => ran(0), 700)
    const spent = ranOf(await validated(join(root, "slow"), { [BASE]: BASE_FILES, [HEAD]: BASE_FILES }, slow, request({ profile: false, run: ["bun test", "bun run build"], budgetMs: 2_200 })))
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
    const needs: [Checkout | Sandboxes | ReviewLogs | ReviewCache] extends [ValidationNeeds] ? true : false = true
    const noShellNeeded: [Shell] extends [ValidationNeeds] ? false : true = true
    type Plain = Gives<ReturnType<typeof reviewLayers>>
    type Asked = Gives<ReturnType<typeof validationLayers>>
    const plain: [Validations] extends [Plain] ? false : true = true
    const asked: [Validations] extends [Asked] ? true : false = true
    const noShell: [Shell] extends [Plain | Asked] ? false : true = true
    expect([needs, noShellNeeded, plain, asked, noShell]).toEqual([true, true, true, true, true])
  })
})
