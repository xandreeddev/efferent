import { Schema } from "effect"
import { FileChange } from "./diff.entity.js"

/**
 * Why a file is left out of the diff the model reads: a lockfile, a file `.gitattributes` at the base marks
 * `linguist-generated` or `linguist-vendored` (a folder's name alone never drops a file: the pull request chooses
 * it), a binary file, a deleted file, or one the token budget had no room for. A file that stays but only loses lines
 * is shown: a removed check is a change to review.
 */
export const DropReason = Schema.Literals(["lockfile", "generated", "vendored", "binary", "deleted", "over-budget"])
export type DropReason = typeof DropReason.Type

/** The words for each reason, as a summary and the model read them. */
export const DROPPED_BECAUSE: Readonly<Record<DropReason, string>> = {
  lockfile: "a lockfile",
  generated: "marked generated",
  vendored: "vendored code",
  binary: "a binary file",
  deleted: "deleted",
  "over-budget": "no room in the token budget",
}

/** A file kept in the diff, or dropped with its reason. */
export const FileVerdict = Schema.Union([
  Schema.TaggedStruct("Kept", { path: Schema.String }),
  Schema.TaggedStruct("Dropped", { path: Schema.String, reason: DropReason }),
])
export type FileVerdict = typeof FileVerdict.Type

/** What a verdict reads of a file besides its path: how it changed, the lines added and removed, and whether it is binary. */
export const FileStats = Schema.Struct({
  change: FileChange,
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
})
export type FileStats = typeof FileStats.Type

/**
 * A line of `.gitattributes` the verdict reads: its pattern and whether it sets `linguist-generated` or
 * `linguist-vendored` (`true` set, `false` unset with `-` or `=false`); an attribute it does not name is none.
 */
export const AttributeRule = Schema.Struct({
  pattern: Schema.String,
  generated: Schema.OptionFromNullOr(Schema.Boolean),
  vendored: Schema.OptionFromNullOr(Schema.Boolean),
})
export type AttributeRule = typeof AttributeRule.Type

/**
 * Lockfiles, by name, and the manifests whose change a lockfile's change should follow: a lockfile that changed with
 * none of them changed is worth a reader's eye.
 */
export const LOCKFILE_MANIFESTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "bun.lock": ["package.json"],
  "bun.lockb": ["package.json"],
  "yarn.lock": ["package.json"],
  "package-lock.json": ["package.json"],
  "npm-shrinkwrap.json": ["package.json"],
  "pnpm-lock.yaml": ["package.json", "pnpm-workspace.yaml"],
  "deno.lock": ["deno.json", "deno.jsonc", "package.json"],
  "Cargo.lock": ["Cargo.toml"],
  "go.sum": ["go.mod"],
  "poetry.lock": ["pyproject.toml"],
  "uv.lock": ["pyproject.toml"],
  "pdm.lock": ["pyproject.toml"],
  "Pipfile.lock": ["Pipfile"],
  "Gemfile.lock": ["Gemfile", "gems.rb"],
  "composer.lock": ["composer.json"],
  "mix.lock": ["mix.exs"],
  "pubspec.lock": ["pubspec.yaml"],
  "Podfile.lock": ["Podfile"],
  "flake.lock": ["flake.nix"],
  "gradle.lockfile": ["build.gradle", "build.gradle.kts"],
}
