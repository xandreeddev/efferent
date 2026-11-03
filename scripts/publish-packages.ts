#!/usr/bin/env bun
/**
 * Publish the packages `bun run build:packages` wrote to `.artifacts/packages`.
 *
 *   bun run publish:packages            dry run: every check, then `npm publish --dry-run`
 *   bun run publish:packages --publish  publish to npm under the `latest` tag
 *
 * It refuses, before publishing anything, when the build stamp (`build.json`)
 * is missing or does not describe the built packages; when the packages do not
 * share one version, or a built version differs from its source manifest; when
 * the build is not from the current HEAD or was made from a tree with changes;
 * when the working tree has changes (untracked files included); when the
 * `@xandreed/*` dependencies form a cycle; when `npm whoami` fails or names an
 * account other than the project's; or when the registry cannot say whether a
 * version is already published.
 *
 * Every step uses registry.npmjs.org: the already-published check, `npm whoami`
 * and `npm publish` (which is passed the registry, overriding npm's own
 * settings). Packages publish one at a time, each after the `@xandreed/*`
 * packages it depends on. A `name@version` the registry already has is skipped,
 * so a run that stopped part-way can be repeated. npm runs attached to this
 * terminal, so its browser or one-time-password 2FA prompt works.
 *
 * When `npm publish` fails in a live run, the registry is asked for that version
 * for about three minutes before the run stops: npm can retry a request that went
 * through and then fail its own upload (E409 "Cannot publish over previously
 * staged version"), and the registry's CDN can answer 404 for a while after a
 * publish. A version the registry has is counted as published.
 *
 * The checks, the order and when to stop asking are pure functions in
 * publish-plan.ts; the registry reads are in npm-registry.ts.
 */
import { dirname, join, relative, resolve } from "node:path"
import { Result, Schema } from "effect"
import { checkRegistryProvenance, confirmOnRegistry, onRegistry } from "./npm-registry.js"
import { BuildStamp, ciAuthentication, Manifest, label, planPublish, publishCommand, registry, repositoryMetadata } from "./publish-plan.js"
import type { Built, Ran } from "./publish-plan.js"

/** The npm account the packages are published from; any other logged-in account is refused. */
const publisher = "xandreed"
const args = process.argv.slice(2)
const rootIndex = args.indexOf("--root")
const sourceRoot = rootIndex < 0 ? undefined : args[rootIndex + 1]
const unknown = args.filter((arg, index) => !["--publish", "--ci", "--root"].includes(arg) && !(rootIndex >= 0 && index === rootIndex + 1))
if (unknown.length > 0 || (rootIndex >= 0 && (sourceRoot === undefined || sourceRoot.startsWith("--") || args.filter((arg) => arg === "--root").length !== 1))) {
  console.error(`Invalid arguments. Usage: bun run publish:packages [--publish] [--ci] [--root <clean-checkout>]`)
  process.exit(2)
}
const live = args.includes("--publish")
const ci = args.includes("--ci")
const root = sourceRoot === undefined ? join(import.meta.dir, "..") : resolve(sourceRoot)
const output = join(root, ".artifacts/packages")
const shown = (path: string) => `./${relative(root, path)}`
const authentication = ci ? ciAuthentication(process.env) : Result.succeed("token" as const)
if (Result.isFailure(authentication)) {
  console.error(authentication.failure)
  process.exit(1)
}

function refuse(reasons: ReadonlyArray<string>): never {
  console.error(`Refusing to publish:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`)
  return process.exit(1)
}

/** A JSON file decoded by `decode`, or why it cannot be read. */
const readJson = async <A>(path: string, decode: (input: unknown) => Result.Result<A, Schema.SchemaError>): Promise<Result.Result<A, string>> =>
  await Bun.file(path).exists()
    ? Result.mapError(decode(await Bun.file(path).text()), (error) => `${shown(path)} is not valid: ${error.message}`)
    : Result.fail(`${shown(path)} does not exist`)
const decodeManifest = Schema.decodeUnknownResult(Schema.fromJsonString(Manifest))

const run = (command: ReadonlyArray<string>): Ran => {
  if (Bun.which(command[0] ?? "") === null) return { success: false, stdout: "", stderr: `${command[0]} is not on PATH` }
  const result = Bun.spawnSync([...command], { cwd: root, stdout: "pipe", stderr: "pipe" })
  return { success: result.success, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() }
}

// The stamp and the manifests: what was built, from which commit, at which version.
const stampRead = await readJson(join(output, "build.json"), Schema.decodeUnknownResult(Schema.fromJsonString(BuildStamp)))
if (Result.isFailure(stampRead)) refuse([`${stampRead.failure}; run bun run build:packages first`])
const stamp = stampRead.success
const dirs = Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: output }), (file) => dirname(file)).sort()
const reads = await Promise.all(dirs.map(async (dir) => ({
  dir,
  manifest: await readJson(join(output, dir, "package.json"), decodeManifest),
  source: await readJson(join(root, "packages", dir, "package.json"), decodeManifest),
})))
const unreadable = reads.flatMap(({ manifest, source }) => [manifest, source].flatMap((read) => Result.isFailure(read) ? [read.failure] : []))
if (unreadable.length > 0) refuse(unreadable)
const builds: ReadonlyArray<Built> = reads.flatMap(({ dir, manifest, source }) =>
  Result.isSuccess(manifest) && Result.isSuccess(source) ? [{ dir, manifest: manifest.success, source: source.success }] : [])

// Checks that need no network; every failing one is reported together.
const head = run(["git", "rev-parse", "HEAD"])
const whoami = authentication.success === "oidc" ? { success: true, stdout: "GitHub OIDC", stderr: "" } : run(["npm", "whoami", "--registry", registry])
const plan = planPublish({ stamp, builds, head, status: run(["git", "status", "--porcelain"]), whoami, publisher, authentication: authentication.success })
if (plan.reasons.length > 0) refuse(plan.reasons)
if (ci) {
  const core = builds.find(({ manifest }) => manifest.name === "@xandreed/core")
  if (core === undefined) refuse(["the CI release build does not include @xandreed/core"])
  const provenance = await checkRegistryProvenance(core.manifest, head.stdout)
  if (Result.isFailure(provenance)) refuse([provenance.failure])
  const wrong = builds.filter(({ manifest }) => manifest.gitHead !== undefined && manifest.gitHead !== head.stdout)
  if (wrong.length > 0) refuse(wrong.map(({ manifest }) => `${label(manifest)} has a gitHead different from the source checkout`))
  await Promise.all(builds.map(async ({ dir }) => {
    const file = Bun.file(join(output, dir, "package.json"))
    const raw = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.JsonObject))(await file.text())
    if (Result.isFailure(raw)) refuse([`the built manifest for ${dir} is invalid`])
    await Bun.write(file, `${JSON.stringify({ ...raw.success, gitHead: head.stdout, repository: repositoryMetadata(dir) }, null, 2)}\n`)
  }))
}

// The registry decides what is left to publish.
const states = await Promise.all(plan.order.map(async (built) => {
  const published = await onRegistry(built.manifest)
  const provenance = Result.isSuccess(published) && published.success
    ? await checkRegistryProvenance(built.manifest, head.stdout, true) : Result.succeed(undefined)
  return { built, published, provenance }
}))
const unknownState = states.flatMap(({ published, provenance }) => [
  ...(Result.isFailure(published) ? [published.failure] : []),
  ...(Result.isFailure(provenance) ? [provenance.failure] : []),
])
if (unknownState.length > 0) refuse(unknownState)
const queue = states.flatMap(({ built, published }) => Result.isSuccess(published) && !published.success ? [built] : [])
states.filter(({ built }) => !queue.includes(built)).forEach(({ built }) => console.log(`skip ${label(built.manifest)} (already on npm)`))
if (queue.length === 0) {
  console.log(`Every package at ${plan.version} is already on npm; nothing to publish.`)
  process.exit(0)
}
console.log(`${live ? "Publishing" : "Dry run of publishing"} ${queue.length} package(s) at ${plan.version} from ${head.stdout.slice(0, 11)} as ${whoami.stdout} to ${registry}: ${queue.map(({ manifest }) => manifest.name).join(", ")}`)

/** Stop the run on the first real failure, naming what went out before it. */
const stop = (failed: Built, done: ReadonlyArray<string>, why: string): never => {
  console.error(`\nnpm publish failed for ${label(failed.manifest)}${why}.${done.length > 0 ? ` ${live ? "Published" : "Dry-ran"} before it: ${done.join(", ")}.` : ""} Fix the cause and run the script again; versions already on npm are skipped.`)
  return process.exit(1)
}

/**
 * One at a time, in order; the first failure stops the run. In a live run a failed upload the
 * registry then has (npm's E409 "previously staged" after a retried request that went through)
 * is counted as published.
 */
const publish = async (pending: ReadonlyArray<Built>, done: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const [next, ...rest] = pending
  if (next === undefined) return done
  const command = publishCommand(next.dir, live, ci)
  console.log(`\n$ ${command.join(" ")}`)
  // npm provenance must match GitHub's signed workflow identity. The independently
  // verified artifact source remains recorded in the built manifest's gitHead.
  const child = Bun.spawn([...command], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) {
    if (!live) return stop(next, done, "")
    console.error(`\nnpm publish exited non-zero for ${label(next.manifest)}; asking the registry whether the upload went through (up to about three minutes).`)
    const verdict = await confirmOnRegistry(next.manifest)
    if (verdict._tag === "Missing") return stop(next, done, `: ${verdict.reason}`)
    console.log(`npm reported a failure for ${label(next.manifest)}, but the registry has it: the upload went through. Counted as published.`)
  }
  return publish(rest, [...done, label(next.manifest)])
}
const done = await publish(queue, [])
console.log(live
  ? `\nPublished ${done.length} package(s) at ${plan.version} under the latest tag.`
  : `\nDry run passed for ${done.length} package(s) at ${plan.version}. Publish with: bun run publish:packages --publish`)
