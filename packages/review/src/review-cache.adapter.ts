import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { CacheUnavailable, Verdict } from "./review-cache.entity.js"
import type { SnapshotKey, VerdictKey } from "./review-cache.entity.js"
import { ReviewCache } from "./review-cache.port.js"
import type { RepoName } from "./pull-request.entity.js"

/** A key's name on disk: the SHA-256 of its parts, each ended by a NUL, so no two keys share a name. */
const nameOf = (parts: ReadonlyArray<string>): string => {
  const hash = createHash("sha256")
  parts.forEach((part) => hash.update(part).update("\0"))
  return hash.digest("hex")
}

const unavailable = (what: string) => (cause: unknown) => new CacheUnavailable({ message: `the review cache could not ${what}`, cause })

const there = (path: string) => Effect.tryPromise(() => access(path)).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))

/**
 * The review cache in folders under `<root>/<owner>/<repo>/`: `verdicts/<hash>.json`, a verdict each (one that cannot
 * be read is none); `packages/<manager>/`,
 * the bot's package caches; `scratch/<uuid>/`; `node-modules/<hash>/`, snapshots, each saved into `node-modules/.saving-<uuid>/`
 * and renamed into place whole.
 */
export const directoryCache = (root: string): Layer.Layer<ReviewCache> => Layer.succeed(ReviewCache, ReviewCache.of((() => {
  const repoDir = (repo: RepoName) => join(root, ...repo.split("/"))
  const verdictPath = (key: VerdictKey) => join(repoDir(key.repo), "verdicts", `${nameOf([key.lockfile, key.command, key.base])}.json`)
  const snapshotPath = (key: SnapshotKey) => join(repoDir(key.repo), "node-modules", nameOf([key.manager, ...key.files.flatMap((file) => [file.path, file.text])]))
  const made = (path: string) => Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: unavailable(`make ${path}`) }).pipe(Effect.as(path))
  const removing = (path: string) => Effect.addFinalizer(() => Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore({ log: "Warn", message: "a folder of the review cache could not be deleted" })))
  return {
    verdict: Effect.fn("review_cache.verdict")(function* (key: VerdictKey) {
      return yield* Effect.tryPromise(() => readFile(verdictPath(key), "utf8")).pipe(
        Effect.option,
        Effect.map((text) => Option.flatMap(text, Schema.decodeUnknownOption(Schema.fromJsonString(Verdict)))),
      )
    }),
    remember: Effect.fn("review_cache.remember")(function* (key: VerdictKey, verdict: Verdict) {
      const path = verdictPath(key)
      yield* made(join(path, ".."))
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(Verdict))(verdict).pipe(Effect.orDie)
      yield* Effect.tryPromise({ try: () => writeFile(path, text), catch: unavailable("keep a verdict") })
    }),
    packages: Effect.fn("review_cache.packages")(function* (repo: RepoName, manager: string) {
      return yield* made(join(repoDir(repo), "packages", manager))
    }),
    scratch: Effect.fn("review_cache.scratch")(function* (repo: RepoName) {
      const path = join(repoDir(repo), "scratch", randomUUID())
      yield* removing(path)
      return yield* made(path)
    }),
    snapshot: Effect.fn("review_cache.snapshot")(function* (key: SnapshotKey) {
      const path = snapshotPath(key)
      return (yield* there(path)) ? Option.some(path) : Option.none<string>()
    }),
    saving: Effect.fn("review_cache.saving")(function* (key: SnapshotKey) {
      const final = snapshotPath(key)
      const dir = join(repoDir(key.repo), "node-modules", `.saving-${randomUUID()}`)
      yield* removing(dir)
      yield* made(dir)
      const commit = Effect.tryPromise({ try: () => rename(dir, final), catch: unavailable("publish a snapshot") }).pipe(
        Effect.catchTag("CacheUnavailable", (failed) => Effect.flatMap(there(final), (done) => done ? Effect.void : Effect.fail(failed))),
      )
      return { dir, commit }
    }),
  }
})()))
