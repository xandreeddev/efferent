/**
 * The checks and the order behind `bun run publish:packages` (scripts/publish-packages.ts), as
 * pure functions over what that script reads: the build stamp, the built and source manifests,
 * and the output of `git` and `npm whoami`. publish-plan.test.ts covers them without a registry,
 * a git checkout or a terminal.
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

export const label = ({ name, version }: { readonly name: string, readonly version: string }) => `${name}@${version}`
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
  const commit = !head.success ? ["git cannot read HEAD; publish from a git checkout"]
    : stamp.commit === null ? ["the build was not made in a git checkout; rebuild"]
    : stamp.commit !== head.stdout ? [`the build is from ${stamp.commit.slice(0, 11)}, but HEAD is ${head.stdout.slice(0, 11)}; rebuild`]
    : []
  const builtDirty = stamp.dirty ? ["the build was made from a working tree with changes (or ignored files in a package's published folders); rebuild from a clean checkout"] : []
  const changes = status.stdout.split("\n").filter((line) => line.trim().length > 0)
  const dirty = !status.success ? ["git cannot read the working tree status"]
    : changes.length > 0 ? [`the working tree has changes; commit, stash or remove them: ${changes.slice(0, 10).map((line) => line.trim()).join(", ")}${changes.length > 10 ? `, and ${changes.length - 10} more` : ""}`]
    : []
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
export const registryAnswer = (manifest: Manifest, status: number): Result.Result<boolean, string> =>
  status === 200 ? Result.succeed(true)
    : status === 404 ? Result.succeed(false)
    : Result.fail(`the registry answered ${status} for ${label(manifest)}`)

/** `npm publish` for one built package, pinned to `registry` (the scoped registry setting too, which npm would otherwise prefer). */
export const publishCommand = (dir: string, live: boolean): ReadonlyArray<string> =>
  ["npm", "publish", folder(dir), "--access", "public", "--tag", "latest", "--registry", registry, `--@xandreed:registry=${registry}`, ...(live ? [] : ["--dry-run"])]
