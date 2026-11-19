import { Schema } from "effect"
import { Manager } from "./repo-profile.entity.js"
import { RepoName } from "./pull-request.entity.js"

/** A folder of the review cache could not be read, made or written. */
export class CacheUnavailable extends Schema.TaggedError<CacheUnavailable>()("CacheUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What a command's pass on the base is known by: the repository, the base's lockfile as text, and the command. */
export const PassKey = Schema.Struct({ repo: RepoName, lockfile: Schema.String, command: Schema.String })
export type PassKey = typeof PassKey.Type

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
