import { Schema } from "effect"

/** A package manager a repository installs with. */
export const Manager = Schema.Literals(["bun", "npm", "pnpm", "yarn"])
export type Manager = typeof Manager.Type

/** Each lockfile and its manager, in the order one is chosen when a repository holds several and names none. */
export const LOCKFILES: ReadonlyArray<readonly [string, Manager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
]

/**
 * The files that say where packages come from and how they are fetched: a head that changes one installs with a
 * package cache of its own, thrown away after, and they are part of a snapshot's key.
 */
export const REGISTRY_CONFIG = [".npmrc", "bunfig.toml", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "pnpm-workspace.yaml"] as const

/** The scripts of `package.json` taken as checks when they exist. */
export const CHECK_SCRIPTS = ["typecheck", "type-check", "lint", "test", "check"] as const

/** The instruction files whose "definition of done" names the commands a change must pass. */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const

/**
 * How a repository installs: its manager, its lockfile, and the command that installs from it with no script of the
 * repository's run (`--ignore-scripts`, or yarn berry's `--mode=skip-build`), the lockfile frozen, packages copied
 * (never hard-linked) from the bot's cache at `/cache`. `Refused` says why it is not installed at all.
 */
export const ManagerChoice = Schema.Union([
  Schema.TaggedStruct("Chosen", { manager: Manager, lockfile: Schema.String, install: Schema.String, run: Schema.String }),
  Schema.TaggedStruct("Refused", { reason: Schema.String }),
])
export type ManagerChoice = typeof ManagerChoice.Type

/** Where a command of the profile came from: a script of `package.json`, an instruction file, or the command line. */
export const CommandFrom = Schema.Literals(["script", "instructions", "by-hand"])
export type CommandFrom = typeof CommandFrom.Type

/** A command considered for a review, kept or dropped with the reason, in fixed words. */
export const Candidate = Schema.Struct({
  command: Schema.String,
  from: CommandFrom,
  kept: Schema.Boolean,
  reason: Schema.String,
})
export type Candidate = typeof Candidate.Type

/** The reasons a command is dropped before anything runs. */
export const NOT_ALLOWED = {
  syntax: "it holds shell syntax (quotes, pipes, ;, $, redirections), so it is not run",
  install: "the install is its own phase",
  noScript: "it names no script of the base's package.json",
  otherPackage: "only the root package's scripts are run",
  unknown: "it is neither a known tool (tsc, bun test, turbo run) nor a script of package.json",
} as const
