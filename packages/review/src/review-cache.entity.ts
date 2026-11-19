import { Schema } from "effect"
import { Manager } from "./repo-profile.entity.js"
import { RepoName } from "./pull-request.entity.js"

/** A folder of the review cache could not be read, made or written. */
export class CacheUnavailable extends Schema.TaggedError<CacheUnavailable>()("CacheUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * What a command's verdict on the base is known by: the repository, the base's lockfile as text, the command, and the
 * base's commit for a verdict that holds for that commit alone (`""` for one that holds for every base with the
 * lockfile: a pass, a timeout).
 */
export const VerdictKey = Schema.Struct({ repo: RepoName, lockfile: Schema.String, command: Schema.String, base: Schema.String })
export type VerdictKey = typeof VerdictKey.Type

/** A command's verdict on the base: kept or dropped, and why. */
export const Verdict = Schema.Struct({ kept: Schema.Boolean, reason: Schema.String })
export type Verdict = typeof Verdict.Type

/**
 * What an installed `node_modules` is known by: the repository, the manager, and the texts of the files an install
 * reads (the lockfile, `package.json`, the registry's config), each with its path.
 */
export const SnapshotKey = Schema.Struct({
  repo: RepoName,
  manager: Manager,
  files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
})
export type SnapshotKey = typeof SnapshotKey.Type
