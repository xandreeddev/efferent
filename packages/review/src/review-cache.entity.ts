import { Schema } from "effect"
import { Manager } from "./repo-profile.entity.js"
import { CommitSha, RepoName } from "./pull-request.entity.js"

/** A folder of the review cache could not be read, made or written. */
export class CacheUnavailable extends Schema.TaggedError<CacheUnavailable>()("CacheUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What a command's verdict on the base is known by: the repository, the base's commit and the command. */
export const VerdictKey = Schema.Struct({ repo: RepoName, base: CommitSha, command: Schema.String })
export type VerdictKey = typeof VerdictKey.Type

/** A command's verdict on the base: kept or dropped, and why. */
export const Verdict = Schema.Struct({ kept: Schema.Boolean, reason: Schema.String })
export type Verdict = typeof Verdict.Type

/**
 * What an installed `node_modules` is known by: the repository, the base's commit it was installed at, the manager
 * and its version, and the texts of the dependency files (every lockfile and every `package.json`), each with its path.
 */
export const SnapshotKey = Schema.Struct({
  repo: RepoName,
  base: CommitSha,
  manager: Manager,
  version: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
})
export type SnapshotKey = typeof SnapshotKey.Type
