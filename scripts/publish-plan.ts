/**
 * The checks and the order behind `bun run publish:packages` (scripts/publish-packages.ts) and
 * `bun run release:publish` (scripts/release-publish.ts), as pure functions over what those
 * scripts read: the build stamp, the built and source manifests, the registry's answers, and the
 * output of `git` and `npm whoami`. publish-plan.test.ts covers them without a registry, a git
 * checkout or a terminal.
 */
import { Result, Schema } from "effect"

const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
/** The fields of a package.json the publish script reads. */
export const Manifest = Schema.Struct({
  name: Schema.String, version: Schema.String,
  dependencies: Dependencies, peerDependencies: Dependencies, optionalDependencies: Dependencies,
})
export type Manifest = typeof Manifest.Type
/** `.artifacts/packages/build.json`, written by scripts/build-packages.ts. */
export const BuildStamp = Schema.Struct({
  commit: Schema.NullOr(Schema.String), dirty: Schema.Boolean, version: Schema.NullOr(Schema.String),
  packages: Schema.Array(Schema.Struct({ dir: Schema.String, name: Schema.String, version: Schema.String })),
})
export type BuildStamp = typeof BuildStamp.Type
/** A built package: its folder under `.artifacts/packages`, the manifest built there, and the source manifest now in `packages/<dir>`. */
export interface Built { readonly dir: string; readonly manifest: Manifest; readonly source: Manifest }
/** A command the script ran: whether it exited 0, and its trimmed stdout and stderr. */
export interface Ran { readonly success: boolean; readonly stdout: string; readonly stderr: string }
/** What the script read before deciding. */
export interface PublishState {
  readonly stamp: BuildStamp
  readonly builds: ReadonlyArray<Built>
  /** `git rev-parse HEAD` */
  readonly head: Ran
  /** `git status --porcelain` */
  readonly status: Ran
  /** `npm whoami` against the registry the script publishes to */
  readonly whoami: Ran
  /** The one npm account the packages are published from. */
  readonly publisher: string
}
/** Every reason to refuse (empty when publishing may go ahead), the shared version, and the packages in publish order. */
export interface PublishPlan { readonly reasons: ReadonlyArray<string>; readonly version: string; readonly order: ReadonlyArray<Built> }

/** The registry every step uses: the already-published check, `npm whoami` and `npm publish`. */
export const registry = "https://registry.npmjs.org"

/** A `name@version` the registry is asked about. */
export interface Versioned { readonly name: string; readonly version: string }

export const label = ({ name, version }: Versioned) => `${name}@${version}`
const short = (commit: string) => commit.slice(0, 11)
const output = "./.artifacts/packages"
const folder = (dir: string) => `${output}/${dir}`

/** The `@xandreed/*` packages of this build that `manifest` depends on. */
export const internal = (manifest: Manifest, names: ReadonlySet<string>): ReadonlyArray<string> =>
  Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })
    .filter((name) => name.startsWith("@xandreed/") && name !== manifest.name && names.has(name))

/** Dependencies first: each round places, by name, every package whose dependencies are placed; what is never ready is a cycle. */
export const topological = (pending: ReadonlyArray<Built>, placed: ReadonlyArray<Built>, names: ReadonlySet<string>): { readonly ordered: ReadonlyArray<Built>, readonly stuck: ReadonlyArray<Built> } => {
  const done = new Set(placed.map(({ manifest }) => manifest.name))
  const ready = pending.filter(({ manifest }) => internal(manifest, names).every((name) => done.has(name)))
  return ready.length === 0
    ? { ordered: placed, stuck: pending }
    : topological(pending.filter((built) => !ready.includes(built)), [...placed, ...[...ready].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))], names)
}

/** Why the build is not of `HEAD` (`head` is `git rev-parse HEAD`): none when it is. */
export const notOfHead = (stamp: BuildStamp, head: Ran): ReadonlyArray<string> =>
  !head.success ? ["git cannot read HEAD; run this from a git checkout"]
    : stamp.commit === null ? ["the build was not made in a git checkout; rebuild"]
    : stamp.commit !== head.stdout ? [`the build is from ${short(stamp.commit)}, but HEAD is ${short(head.stdout)}; rebuild`]
    : []

/** Why the build is not of a clean tree: none when it is. */
export const notClean = (stamp: BuildStamp): ReadonlyArray<string> =>
  stamp.dirty ? ["the build was made from a working tree with changes (or ignored files in a package's published folders); rebuild from a clean checkout"] : []

/** Why the working tree is not clean (`status` is `git status --porcelain`, untracked files included): none when it is. */
export const notCleanTree = (status: Ran): ReadonlyArray<string> => {
  const changes = status.stdout.split("\n").filter((line) => line.trim().length > 0)
  return !status.success ? ["git cannot read the working tree status"]
    : changes.length > 0 ? [`the working tree has changes; commit, stash or remove them: ${changes.slice(0, 10).map((line) => line.trim()).join(", ")}${changes.length > 10 ? `, and ${changes.length - 10} more` : ""}`]
    : []
}

/** Every check that needs no network, reported together, and the publish order. */
export const planPublish = ({ stamp, builds, head, status, whoami, publisher }: PublishState): PublishPlan => {
  const none = builds.length === 0 ? [`${output} holds no built packages; run bun run build:packages first`] : []
  const stamped = new Map(stamp.packages.map((entry) => [entry.dir, entry]))
  const unstamped = builds.filter(({ dir, manifest }) => stamped.get(dir)?.name !== manifest.name || stamped.get(dir)?.version !== manifest.version)
    .map(({ dir, manifest }) => `${folder(dir)} holds ${label(manifest)}, which build.json does not record; rebuild`)
  const unbuilt = stamp.packages.filter(({ dir }) => !builds.some((built) => built.dir === dir))
    .map((entry) => `build.json records ${label(entry)}, but ${folder(entry.dir)} is missing; rebuild`)
  const versions = new Set(builds.map(({ manifest }) => manifest.version))
  const version = Array.from(versions)[0] ?? ""
  const unequal = versions.size > 1
    ? [`the packages do not share one version: ${builds.map(({ manifest }) => label(manifest)).join(", ")}`]
    : versions.size === 1 && stamp.version !== version ? [`build.json records version ${stamp.version ?? "(mixed)"}, but the packages are at ${version}; rebuild`] : []
  const stale = builds.filter(({ manifest, source }) => manifest.name !== source.name || manifest.version !== source.version)
    .map(({ dir, manifest, source }) => `${label(manifest)} was built, but packages/${dir}/package.json is now ${label(source)}; rebuild`)
  const commit = notOfHead(stamp, head)
  const builtDirty = notClean(stamp)
  const dirty = notCleanTree(status)
  const order = topological(builds, [], new Set(builds.map(({ manifest }) => manifest.name)))
  const cycle = order.stuck.length > 0 ? [`the @xandreed/* dependencies of ${order.stuck.map(({ manifest }) => manifest.name).join(", ")} form a cycle`] : []
  const account = !whoami.success
    ? [`npm whoami failed on ${registry}; log in with npm login${whoami.stderr.length > 0 ? `:\n      ${whoami.stderr.split("\n").join("\n      ")}` : ""}`]
    : whoami.stdout !== publisher ? [`npm is logged in as ${whoami.stdout}, but the packages are published only as ${publisher}; npm logout, then npm login as ${publisher}`]
    : []
  return {
    reasons: [...none, ...unstamped, ...unbuilt, ...unequal, ...stale, ...commit, ...builtDirty, ...dirty, ...cycle, ...account],
    version,
    order: order.ordered,
  }
}

/** The registry's answer for one `name@version`: 200 is published, 404 is not, anything else is a refusal. */
export const registryAnswer = (item: Versioned, status: number): Result.Result<boolean, string> =>
  status === 200 ? Result.succeed(true)
    : status === 404 ? Result.succeed(false)
    : Result.fail(`the registry answered ${status} for ${label(item)}`)

const PublishedVersion = Schema.Struct({ name: Schema.String, version: Schema.String, gitHead: Schema.optionalKey(Schema.String) })
/** An existing release can be resumed only from the commit npm recorded, never from a later same-version checkout. */
export const registryProvenance = (item: Versioned, head: string, status: number, body: string): Result.Result<void, string> => {
  const found = registryAnswer(item, status)
  if (Result.isFailure(found)) return Result.fail(found.failure)
  if (!found.success) return Result.succeed(undefined)
  const metadata = Schema.decodeUnknownResult(Schema.fromJsonString(PublishedVersion))(body)
  if (Result.isFailure(metadata)) return Result.fail(`the registry returned invalid release metadata for ${label(item)}`)
  if (metadata.success.name !== item.name || metadata.success.version !== item.version) return Result.fail(`the registry returned metadata for a different package or version than ${label(item)}`)
  const origin = metadata.success.gitHead
  if (origin === undefined || origin.length === 0) return Result.fail(`${label(item)} already exists, but npm records no gitHead; its release commit cannot be verified, so publishing or tagging from this checkout is refused`)
  return origin === head ? Result.succeed(undefined)
    : Result.fail(`${label(item)} was published from ${short(origin)}, not HEAD ${short(head)}; resume from its original commit or prepare a new shared version`)
}

/**
 * How long a `name@version` is asked for before it counts as missing: 12 answers 5 seconds
 * apart, about a minute. Asked after an `npm publish` that failed (npm can retry a request that
 * went through and then fail on its own upload with E409 "previously staged") and before a
 * release is tagged, since the registry's CDN can answer 404 for a while after a publish.
 */
export const confirmSchedule = { attempts: 12, intervalMillis: 5_000 } as const

/** What the registry's answers so far say about one `name@version`. */
export type Confirmation =
  | { readonly _tag: "Published" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Missing"; readonly reason: string }

/**
 * The registry's answers for `item`, oldest first: found once is published (a 404 after it is the
 * CDN's lag); `attempts` answers that never found it are missing, with the registry's last
 * refusal when it gave one; fewer are pending, so the caller asks again.
 */
export const confirmation = (item: Versioned, answers: ReadonlyArray<Result.Result<boolean, string>>, attempts: number): Confirmation => {
  const refusals = answers.flatMap((answer) => Result.isFailure(answer) ? [answer.failure] : [])
  return answers.some((answer) => Result.isSuccess(answer) && answer.success) ? { _tag: "Published" }
    : answers.length < attempts ? { _tag: "Pending" }
    : { _tag: "Missing", reason: `the registry does not have ${label(item)} after ${answers.length} checks${refusals.length > 0 ? ` (the last refusal: ${refusals[refusals.length - 1]})` : ""}` }
}

/** `npm publish` for one built package, pinned to `registry` (the scoped registry setting too, which npm would otherwise prefer). */
export const publishCommand = (dir: string, live: boolean): ReadonlyArray<string> =>
  ["npm", "publish", folder(dir), "--access", "public", "--tag", "latest", "--registry", registry, `--@xandreed:registry=${registry}`, ...(live ? [] : ["--dry-run"])]

/**
 * The commands `bun run release:publish` runs, in order, from the repository root. The install
 * skips lifecycle scripts: an optional dependency of the docs site (never published) runs a
 * native build that can fail and fail the install, and nothing published needs a script.
 * `verify:packages` is opt-in (CI runs it on every merge commit); a dry run stops after the
 * publish dry run.
 */
export const releaseSteps = ({ verify, dryRun }: { readonly verify: boolean; readonly dryRun: boolean }): ReadonlyArray<ReadonlyArray<string>> => [
  ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
  ["bun", "run", "build:packages"],
  ...(verify ? [["bun", "run", "verify:packages"]] : []),
  ["bun", "run", "publish:packages"],
  ...(dryRun ? [] : [["bun", "run", "publish:packages", "--publish"]]),
]

/** The commit `tag` names in `git ls-remote origin refs/tags/<tag> refs/tags/<tag>^{}` output (an annotated tag's peeled line first), or null when origin has no such tag. */
export const remoteTagCommit = (listing: string, tag: string): string | null => {
  const refs = new Map(listing.split("\n").flatMap((line): ReadonlyArray<readonly [string, string]> => {
    const [commit, ref] = line.trim().split(/\s+/)
    return commit !== undefined && ref !== undefined ? [[ref, commit]] : []
  }))
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
}

/** Where a release tag stands before `release:publish` tags HEAD: the commit it names here (null when absent) and `git ls-remote` of it on origin. */
export interface TagState { readonly tag: string; readonly head: string; readonly local: string | null; readonly remote: Ran }
/** Every reason not to tag (empty when tagging may go ahead), and the git commands still to run: none when the tag already names HEAD here and on origin. */
export interface TagPlan { readonly reasons: ReadonlyArray<string>; readonly commands: ReadonlyArray<ReadonlyArray<string>> }

/** A release tag goes on HEAD and is never moved: one that already names HEAD is kept, one that names another commit refuses. */
export const tagPlan = ({ tag, head, local, remote }: TagState): TagPlan => {
  const onOrigin = remote.success ? remoteTagCommit(remote.stdout, tag) : null
  const unreadable = remote.success ? [] : [`git cannot read the tags on origin${remote.stderr.length > 0 ? `: ${remote.stderr}` : ""}`]
  const movedHere = local !== null && local !== head ? [`the tag ${tag} names ${short(local)}, not HEAD ${short(head)}; a release tag is never moved`] : []
  const movedThere = onOrigin !== null && onOrigin !== head ? [`origin's tag ${tag} names ${short(onOrigin)}, not HEAD ${short(head)}; a release tag is never moved`] : []
  const reasons = [...unreadable, ...movedHere, ...movedThere]
  return {
    reasons,
    commands: reasons.length > 0 ? [] : [
      ...(local === null ? [["git", "tag", tag]] : []),
      ...(onOrigin === null ? [["git", "push", "origin", `refs/tags/${tag}`]] : []),
    ],
  }
}
