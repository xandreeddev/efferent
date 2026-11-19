import { Schema } from "effect"
import { CommitSha } from "./pull-request.entity.js"

/** The instruction files a review reads, in the order it reads them in a folder. */
export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "REVIEW.md"] as const

/**
 * An instruction file of the repository, read at the base commit (`from`), so a pull request cannot rewrite the rules
 * it is reviewed by: its path from the root and its text.
 */
export const RepoRules = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  from: CommitSha,
})
export type RepoRules = typeof RepoRules.Type
