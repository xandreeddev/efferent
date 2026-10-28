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
 * The checks and the order are pure functions in publish-plan.ts.
 */
import { dirname, join, relative } from "node:path"
import { Result, Schema } from "effect"
import { BuildStamp, Manifest, label, planPublish, publishCommand, registry, registryAnswer } from "./publish-plan.js"
import type { Built, Ran } from "./publish-plan.js"

const root = join(import.meta.dir, "..")
const output = join(root, ".artifacts/packages")
/** The npm account the packages are published from; any other logged-in account is refused. */
const publisher = "xandreed"
const shown = (path: string) => `./${relative(root, path)}`

const args = process.argv.slice(2)
const unknown = args.filter((arg) => arg !== "--publish")
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}\nUsage: bun run publish:packages [--publish]`)
  process.exit(2)
}
const live = args.includes("--publish")

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

/** Cache-busted, because the registry's CDN can keep serving a 404 for a version that was just published. */
const onRegistry = (manifest: Manifest): Promise<Result.Result<boolean, string>> =>
  fetch(`${registry}/${manifest.name.replace("/", "%2f")}/${manifest.version}?cb=${Date.now()}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }).then(
    (response) => registryAnswer(manifest, response.status),
    (error: unknown) => Result.fail(`the registry could not be reached for ${label(manifest)}: ${String(error)}`),
  )

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
const whoami = run(["npm", "whoami", "--registry", registry])
const plan = planPublish({ stamp, builds, head, status: run(["git", "status", "--porcelain"]), whoami, publisher })
if (plan.reasons.length > 0) refuse(plan.reasons)

// The registry decides what is left to publish.
const states = await Promise.all(plan.order.map(async (built) => ({ built, published: await onRegistry(built.manifest) })))
const unknownState = states.flatMap(({ published }) => Result.isFailure(published) ? [published.failure] : [])
if (unknownState.length > 0) refuse(unknownState)
const queue = states.flatMap(({ built, published }) => Result.isSuccess(published) && !published.success ? [built] : [])
states.filter(({ built }) => !queue.includes(built)).forEach(({ built }) => console.log(`skip ${label(built.manifest)} (already on npm)`))
if (queue.length === 0) {
  console.log(`Every package at ${plan.version} is already on npm; nothing to publish.`)
  process.exit(0)
}
console.log(`${live ? "Publishing" : "Dry run of publishing"} ${queue.length} package(s) at ${plan.version} from ${head.stdout.slice(0, 11)} as ${whoami.stdout} to ${registry}: ${queue.map(({ manifest }) => manifest.name).join(", ")}`)

/** One at a time, in order; the first failure stops the run. */
const publish = async (pending: ReadonlyArray<Built>, done: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const [next, ...rest] = pending
  if (next === undefined) return done
  const command = publishCommand(next.dir, live)
  console.log(`\n$ ${command.join(" ")}`)
  const child = Bun.spawn([...command], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) {
    console.error(`\nnpm publish failed for ${label(next.manifest)}.${done.length > 0 ? ` ${live ? "Published" : "Dry-ran"} before it: ${done.join(", ")}.` : ""} Fix the cause and run the script again; versions already on npm are skipped.`)
    return process.exit(1)
  }
  return publish(rest, [...done, label(next.manifest)])
}
const done = await publish(queue, [])
console.log(live
  ? `\nPublished ${done.length} package(s) at ${plan.version} under the latest tag.`
  : `\nDry run passed for ${done.length} package(s) at ${plan.version}. Publish with: bun run publish:packages --publish`)
