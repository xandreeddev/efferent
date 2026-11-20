import { Schema } from "effect"
import { DigestLimits, LogDigest } from "./log-digest.entity.js"
import { CommitSha, RepoName } from "./pull-request.entity.js"
import { Candidate, Manager } from "./repo-profile.entity.js"

const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * What a review asks to run: the repository and the two ends; the commands given by hand (`--run`) and whether the
 * repository's profile runs too (`--validate`); the changed paths a digest puts first, its limits and the folder name
 * its logs are kept under; how long each command may run, and how long each clone's whole run (its install and its
 * commands) may take.
 */
export const ValidationRequest = Schema.Struct({
  repo: RepoName,
  base: CommitSha,
  head: CommitSha,
  run: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  profile: Schema.Boolean,
  changedPaths: Schema.Array(Schema.String),
  limits: DigestLimits,
  logFolder: Schema.String,
  commandTimeoutMs: Positive,
  budgetMs: Positive,
})
export type ValidationRequest = typeof ValidationRequest.Type

/** The defaults: five minutes a command, fifteen for each clone's whole run. */
export const VALIDATION_TIMES = { commandTimeoutMs: 300_000, budgetMs: 900_000 } as const

/**
 * A command of the profile after the base was asked: kept, with how it was known to pass (`reason`), or dropped with
 * why.
 */
export const ProfileEntry = Candidate
export type ProfileEntry = typeof ProfileEntry.Type

/** A command that was to run on the head and did not, with why. */
export const Unrun = Schema.Struct({ command: Schema.String, reason: Schema.String })
export type Unrun = typeof Unrun.Type

/**
 * The commands were not run at all, and why (no lockfile, a manager the host lacks, a repository's own yarn that the
 * pull request changes).
 */
export const ValidationRefused = Schema.TaggedStruct("Refused", { reason: Schema.String })

/**
 * The commands ran on the head: its manager; the profile, each command kept or dropped; the head's install, digested;
 * a digest of each command that ran; and those that did not, with why.
 */
export const ValidationRan = Schema.TaggedStruct("Ran", {
  manager: Manager,
  profile: Schema.Array(ProfileEntry),
  install: Schema.OptionFromNullOr(LogDigest),
  digests: Schema.Array(LogDigest),
  unrun: Schema.Array(Unrun),
})

/** What `Validations.run` answers. */
export const ValidationRun = Schema.Union([ValidationRefused, ValidationRan])
export type ValidationRun = typeof ValidationRun.Type

/** The words for why a command did not run, or was dropped after the base was asked. */
export const UNRUN_BECAUSE = {
  budget: "the clone's time budget ran out before it ran",
  noSnapshot: "the base's install could not be restored on the head",
  depsChanged: "dependencies changed: not validated locally (CI covers it)",
  baseInstall: "the base did not install",
  passedBefore: "passed on this base before",
  knownBefore: "(known from an earlier review)",
  passed: "passed on the base",
  byHand: "asked for by hand",
} as const
