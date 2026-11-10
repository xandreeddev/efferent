#!/usr/bin/env bun
/**
 * Publish a release in one command, from a clean checkout of its merge commit, in an interactive
 * terminal (npm asks for the second factor there).
 *
 *   bun run release:publish            install, build, publish dry run, publish, tag
 *   bun run release:publish --verify   also bun run verify:packages after the build (CI already ran it on the merge commit)
 *   bun run release:publish --dry-run  stop after the publish dry run: nothing is uploaded or tagged
 *   bun scripts/release-publish.ts --ci --root <clean-release-checkout> --verify
 * CI requires this repository's GitHub Actions context plus npm token or OIDC request credentials.
 * Build and verification run in the source checkout; publication uses this pipeline's publisher.
 *
 * In order, each attached to this terminal, the first failure stopping the run:
 * `bun install --frozen-lockfile --ignore-scripts`, `bun run build:packages`,
 * `bun run publish:packages` (its dry run) and `bun run publish:packages --publish`. Then it asks
 * the registry for every package the build stamp (`build.json`) records, for up to about three minutes
 * each, and only when the registry has them all creates the lightweight `v<version>` tag on HEAD
 * and pushes it to origin, which deploys the documentation site.
 *
 * It refuses, before running anything, when HEAD cannot be read, when the working tree has
 * changes (untracked files included), or, unless it is a dry run, when stdin is not a terminal.
 * Before any commands, it refuses an existing core version whose npm gitHead differs from HEAD
 * or is missing, and a conflicting local or origin release tag. It repeats the tag check after
 * publishing. It refuses to tag when the build is not of HEAD, or when `v<version>` already names another
 * commit here or on origin: a release tag is never moved. A run that stopped part-way can be
 * repeated from the same commit: the install and build repeat, versions already on npm are
 * skipped, and a tag already on HEAD is kept.
 *
 * The steps and the tag decision are pure functions in publish-plan.ts.
 */
import { appendFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Result, Schema } from "effect"
import { checkRegistryProvenance, confirmOnRegistry } from "./npm-registry.js"
import { BuildStamp, ciAuthentication, Manifest, notCleanTree, notOfHead, releaseSteps, tagConfirmSchedule, tagPlan } from "./publish-plan.js"
import type { Ran } from "./publish-plan.js"

const args = process.argv.slice(2)
const rootIndex = args.indexOf("--root")
const sourceRoot = rootIndex < 0 ? undefined : args[rootIndex + 1]
const unknown = args.filter((arg, index) => !["--verify", "--dry-run", "--ci", "--root"].includes(arg) && !(rootIndex >= 0 && index === rootIndex + 1))
if (unknown.length > 0 || (rootIndex >= 0 && (sourceRoot === undefined || sourceRoot.startsWith("--") || args.filter((arg) => arg === "--root").length !== 1))) {
  console.error(`Invalid arguments. Usage: bun run release:publish [--verify] [--dry-run] [--ci] [--root <clean-checkout>]`)
  process.exit(2)
}
const verify = args.includes("--verify")
const dryRun = args.includes("--dry-run")
const ci = args.includes("--ci")
const root = sourceRoot === undefined ? join(import.meta.dir, "..") : resolve(sourceRoot)
const stampPath = join(root, ".artifacts/packages/build.json")
const authentication = ci ? ciAuthentication(process.env) : Result.succeed("token" as const)
if (Result.isFailure(authentication)) {
  console.error(authentication.failure)
  process.exit(1)
}

function refuse(what: string, reasons: ReadonlyArray<string>): never {
  console.error(`Refusing to ${what}:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`)
  return process.exit(1)
}

const run = (command: ReadonlyArray<string>): Ran => {
  if (Bun.which(command[0] ?? "") === null) return { success: false, stdout: "", stderr: `${command[0]} is not on PATH` }
  const result = Bun.spawnSync([...command], { cwd: root, stdout: "pipe", stderr: "pipe" })
  return { success: result.success, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() }
}

/** Run `commands` in order, attached to this terminal; the first that exits non-zero stops the release. */
const attached = async (commands: ReadonlyArray<ReadonlyArray<string>>): Promise<void> => {
  const [next, ...rest] = commands
  if (next === undefined) return
  console.log(`\n$ ${next.join(" ")}`)
  const code = await Bun.spawn([...next], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
  if (code !== 0) {
    console.error(`\nrelease:publish stopped: \`${next.join(" ")}\` exited ${code}. Fix the cause and run bun run release:publish again from this commit: the install and build repeat, versions already on npm are skipped, and a tag already on HEAD is kept.`)
    return process.exit(1)
  }
  return attached(rest)
}

// A clean checkout of a commit, and a terminal for npm's second factor.
const head = run(["git", "rev-parse", "HEAD"])
const before = [
  ...(head.success ? [] : ["git cannot read HEAD; run this from a git checkout"]),
  ...notCleanTree(run(["git", "status", "--porcelain"])),
  ...(ci || dryRun || process.stdin.isTTY ? [] : ["stdin is not a terminal; run this from an interactive terminal, where npm asks for the second factor"]),
]
if (before.length > 0) refuse("release", before)
if (ci && authentication.success === "token") {
  const account = run(["npm", "whoami", "--registry", "https://registry.npmjs.org"])
  if (!account.success || account.stdout !== "xandreed") refuse("release", ["the CI npm token must authenticate as xandreed before building the release"])
}

// Publishing a new package under an old shared version would bind it to an older core.
// Missing npm gitHead cannot establish a safe resume, even if the version already exists.
const corePath = join(root, "packages/core/package.json")
if (!await Bun.file(corePath).exists()) refuse("release", ["packages/core/package.json does not exist"])
const coreRead = Schema.decodeUnknownResult(Schema.fromJsonString(Manifest))(await Bun.file(corePath).text())
if (Result.isFailure(coreRead)) refuse("release", [`packages/core/package.json is not valid: ${coreRead.failure.message}`])
const core = coreRead.success
if (core.name !== "@xandreed/core") refuse("release", ["packages/core/package.json does not name @xandreed/core"])
const preflightTag = `v${core.version}`
const preflightLocal = run(["git", "rev-parse", "-q", "--verify", `refs/tags/${preflightTag}^{commit}`])
const preflight = tagPlan({ tag: preflightTag, head: head.stdout, local: preflightLocal.success ? preflightLocal.stdout : null, remote: run(["git", "ls-remote", "origin", `refs/tags/${preflightTag}`, `refs/tags/${preflightTag}^{}`]) })
if (preflight.reasons.length > 0) refuse("release", preflight.reasons)
const provenance = await checkRegistryProvenance(core, head.stdout)
if (Result.isFailure(provenance)) refuse("release", [provenance.failure])

await attached(releaseSteps({ verify, dryRun, ci, root, publisher: join(import.meta.dir, "publish-packages.ts") }))
if (dryRun) {
  console.log("\nDry run passed; nothing was uploaded or tagged. Release with: bun run release:publish")
  process.exit(0)
}

// Tag only when the registry has every package the build records.
if (!await Bun.file(stampPath).exists()) refuse("tag", ["./.artifacts/packages/build.json does not exist; run bun run build:packages first"])
const stampRead = Schema.decodeUnknownResult(Schema.fromJsonString(BuildStamp))(await Bun.file(stampPath).text())
if (Result.isFailure(stampRead)) refuse("tag", [`./.artifacts/packages/build.json is not valid: ${stampRead.failure.message}`])
const stamp = stampRead.success
const version = stamp.version
if (version === null) refuse("tag", ["build.json records no shared version; rebuild"])
console.log(`\nAsking the registry for the ${stamp.packages.length} package(s) at ${version} before tagging.`)
const settled = await Promise.all(stamp.packages.map((entry) => confirmOnRegistry(entry, head.stdout, tagConfirmSchedule)))
const missing = settled.flatMap((verdict) => verdict._tag === "Missing" ? [verdict.reason] : [])
if (missing.length > 0) refuse("tag", missing)

const tag = `v${version}`
const now = run(["git", "rev-parse", "HEAD"])
const local = run(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`])
const plan = tagPlan({ tag, head: now.stdout, local: local.success ? local.stdout : null, remote: run(["git", "ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]) })
const reasons = [...notOfHead(stamp, now), ...plan.reasons]
if (reasons.length > 0) refuse("tag", reasons)
if (plan.commands.length === 0) console.log(`${tag} already names HEAD here and on origin.`)
await attached(plan.commands)
if (ci && process.env.GITHUB_OUTPUT !== undefined) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nsha=${now.stdout}\n`)
console.log(`\nReleased ${version}: the registry has all ${stamp.packages.length} package(s), and origin has ${tag} at ${now.stdout.slice(0, 11)}.${ci ? " CI must explicitly dispatch the documentation workflow for this tag." : " The tag deploys the documentation site (.github/workflows/docs.yml)."}`)
