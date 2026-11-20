import { Option, Schema } from "effect"
import { CHECK_SCRIPTS, LOCKFILES, NOT_ALLOWED } from "./repo-profile.entity.js"
import { TOOL_BIN } from "./sandbox.entity.js"
import type { Candidate, CommandFrom, Manager, ManagerChoice } from "./repo-profile.entity.js"

/** What a profile reads of `package.json`: its scripts and the manager it names. */
const PackageJson = Schema.Struct({
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  packageManager: Schema.optionalKey(Schema.String),
})

const packageJsonOf = (text: Option.Option<string>) => Option.flatMap(text, Schema.decodeUnknownOption(Schema.fromJsonString(PackageJson)))

/** The names of the scripts a `package.json` holds; none when there is none or it is not JSON of that shape. */
export const scriptsOf = (packageJson: Option.Option<string>): ReadonlyArray<string> =>
  Option.match(packageJsonOf(packageJson), { onNone: () => [], onSome: (decoded) => Object.keys(decoded.scripts ?? {}) })

/** The `yarnPath` a `.yarnrc.yml` names, if any. */
export const yarnPathOf = (yarnrc: string): Option.Option<string> =>
  Option.fromNullishOr(/^yarnPath:\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(yarnrc)?.[1])

/** What `managerOf` reads at the base: the lockfiles there are, `package.json` and `.yarnrc.yml`. */
export interface BaseFiles {
  readonly lockfiles: ReadonlyArray<string>
  readonly packageJson: Option.Option<string>
  readonly yarnrc: Option.Option<string>
}

/**
 * The variables npm and pnpm read before a project's `.npmrc`: no script, the system's git (a project's `git` key
 * names a program to run), and no user config (the sandbox's home has none, and it never comes from the repository).
 */
const NPM_ENV = "npm_config_ignore_scripts=true npm_config_git=/usr/bin/git npm_config_userconfig=/dev/null"

/** Each manager's install, every program by its absolute path in the sandbox (`/opt/tool/bin`), never by `PATH`. */
const INSTALL: Readonly<Record<Manager, string>> = {
  bun: `BUN_INSTALL_CACHE_DIR=/cache ${TOOL_BIN}/bun install --frozen-lockfile --ignore-scripts --backend=copyfile`,
  npm: `${NPM_ENV} ${TOOL_BIN}/npm ci --ignore-scripts --no-audit --no-fund --cache /cache`,
  pnpm: `${NPM_ENV} ${TOOL_BIN}/pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /cache --package-import-method copy`,
  // YARN_IGNORE_PATH: yarn classic would otherwise run the program a repository's `.yarnrc` names (`yarn-path`).
  yarn: `YARN_IGNORE_PATH=1 ${TOOL_BIN}/yarn install --frozen-lockfile --ignore-scripts --non-interactive --cache-folder /cache`,
}

/** The program a manager needs on the host: npm comes with node. */
const PROGRAM: Readonly<Record<Manager, string>> = { bun: "bun", npm: "node", pnpm: "pnpm", yarn: "yarn" }

/** A path a `.yarnrc.yml` may name to be run: letters, digits, `.`, `_`, `/` and `-` only. */
const PLAIN_PATH = /^[A-Za-z0-9._/-]+$/

/**
 * A repository path as git names it: no `.` part, no empty part, a `..` part taken back; none when it leads out of
 * the repository.
 */
export const normalPath = (path: string): Option.Option<string> => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return Option.none()
      parts.pop()
    } else parts.push(part)
  }
  return Option.some(parts.join("/"))
}

/**
 * Every value of a `.yarnrc.yml` that names a file (a `/` in it, or a script's extension), after a key or as a list's
 * item (`plugins:` then `  - ./x.cjs`): what yarn may load as it installs.
 */
export const yarnrcPathsOf = (yarnrc: string): ReadonlyArray<string> =>
  [...yarnrc.matchAll(/(?::|^\s*-)\s*["']?([^"'\s#]+)["']?\s*$/gm)].flatMap((match) => {
    const value = match[1] ?? ""
    return value.includes("/") || /\.(c|m)?js$/.test(value) ? Option.toArray(normalPath(value)) : []
  })

/**
 * The manager a repository installs with, from the base's lockfile (the one `packageManager` names when it is there,
 * else the first of `LOCKFILES`), and the command that installs with it. Refused: no lockfile; the manager not on the
 * host; a yarn berry repository (a `.yarnrc.yml`) with no `yarnPath` (corepack is never run); or one whose `yarnPath`,
 * `.yarnrc.yml`, plugins or releases (`.yarn/plugins/`, `.yarn/releases/`) the pull request changes: the
 * repository's own yarn and the plugins it loads as it installs run only as the base has them.
 */
export const managerOf = (base: BaseFiles, changedPaths: ReadonlyArray<string>, hostTools: ReadonlyArray<string>): ManagerChoice => {
  const named = Option.flatMap(packageJsonOf(base.packageJson), (decoded) => Option.fromNullishOr(decoded.packageManager?.split("@")[0]))
  const present = LOCKFILES.filter(([file]) => base.lockfiles.includes(file))
  const lock = present.find(([, manager]) => Option.contains(named, manager)) ?? present[0]
  if (lock === undefined) return { _tag: "Refused", reason: "the base has no lockfile (bun.lock, pnpm-lock.yaml, yarn.lock or package-lock.json), so nothing is installed" }
  const [lockfile, manager] = lock
  if (manager === "yarn" && Option.isSome(base.yarnrc)) {
    const yarnrc = base.yarnrc.value
    const named = yarnrcPathsOf(yarnrc)
    const changed = changedPaths.flatMap((path) => Option.toArray(normalPath(path)))
    return Option.match(Option.flatMap(yarnPathOf(yarnrc), normalPath), {
      onNone: () => ({ _tag: "Refused", reason: "the repository uses yarn berry with no yarnPath in the repository, which needs corepack, and corepack is not run" }),
      onSome: (yarnPath): ManagerChoice => !PLAIN_PATH.test(yarnPath)
        ? { _tag: "Refused", reason: "the repository's yarnPath holds characters other than letters, digits, ., _, / and -, so it is not run" }
        : changed.some((path) => path === yarnPath || path === ".yarnrc.yml" || named.includes(path) || path.startsWith(".yarn/plugins/") || path.startsWith(".yarn/releases/"))
          ? { _tag: "Refused", reason: `the pull request changes the repository's own yarn (${yarnPath}, .yarnrc.yml or a file it names), so it is not run` }
          : !hostTools.includes("node")
            ? { _tag: "Refused", reason: "the repository's own yarn needs node, which the host does not have" }
            : {
              _tag: "Chosen",
              manager,
              lockfile,
              install: `YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_GLOBAL_CACHE=0 YARN_CACHE_FOLDER=/cache ${TOOL_BIN}/node ${yarnPath} install --immutable --mode=skip-build`,
              run: `node ${yarnPath} run`,
              version: `${TOOL_BIN}/node --version`,
            },
    })
  }
  if (!hostTools.includes(PROGRAM[manager])) return { _tag: "Refused", reason: `the repository installs with ${manager}, which the host does not have` }
  return { _tag: "Chosen", manager, lockfile, install: INSTALL[manager], run: `${manager} run`, version: `${TOOL_BIN}/${manager} --version` }
}

/**
 * The names an install reads: every lockfile, every workspace's `package.json`, and the managers' config (registries,
 * workspaces, hooks).
 */
export const DEPENDENCY_NAMES: ReadonlyArray<string> = [
  ...LOCKFILES.map(([file]) => file), "package.json", "bunfig.toml", ".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml", ".pnpmfile.cjs",
]

/** Whether an install reads a path: one of `DEPENDENCY_NAMES`, or a file in a `patches` folder (patched dependencies). */
export const isDependencyPath = (path: string): boolean =>
  DEPENDENCY_NAMES.includes(path.slice(path.lastIndexOf("/") + 1)) || path.split("/").slice(0, -1).includes("patches")

/** The paths of a tree's dependency files, anywhere in it (`isDependencyPath`), in code-unit order. */
export const dependencyPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter(isDependencyPath).toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0)

/** Whether two trees' dependency files are the same paths with the same bytes. */
export const sameFiles = (one: ReadonlyArray<{ readonly path: string; readonly text: string }>, other: ReadonlyArray<{ readonly path: string; readonly text: string }>): boolean =>
  one.length === other.length && one.every((file, at) => file.path === other[at]?.path && file.text === other[at]?.text)

/**
 * The commands an instruction file gives under a heading that says "definition of done", up to the next heading of
 * its level or above: each line of the fenced code blocks there, but blank lines and comments.
 */
export const doneCommandsOf = (text: string): ReadonlyArray<string> => {
  const commands: Array<string> = []
  let level = 0
  let fenced = false
  for (const line of text.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null && !fenced) {
      const depth = heading[1]?.length ?? 0
      if (/definition of done/i.test(heading[2] ?? "")) level = depth
      else if (level > 0 && depth <= level) level = 0
      continue
    }
    if (level === 0) continue
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    const command = line.trim()
    if (fenced && command.length > 0 && !command.startsWith("#")) commands.push(command)
  }
  return commands
}

const SHELL_SYNTAX = /[^A-Za-z0-9_\-./:@=,+ \t]/
const MANAGERS = ["bun", "npm", "pnpm", "yarn"]
const INSTALLS = ["install", "i", "ci", "add"]
/** Words of yarn and pnpm that are their own commands, never a script's name. */
const BUILTINS = ["install", "i", "add", "remove", "exec", "dlx", "run", "why", "list", "info", "config", "x", "publish", "init", "link", "unlink", "up", "upgrade", "update"]

/**
 * Whether a command may run, by its words: one with shell syntax never; the install never (its own phase); a
 * package manager's `run <script>` (and `yarn <script>`, `pnpm <script>`, `npm test`) only for a script of the root
 * `package.json`; a known tool (`tsc`, `npx tsc`, `bunx tsc`, `bun test`, `turbo run <task>`); nothing else. Answers
 * the reason it is dropped, none when it is kept. `run` is how the repository's manager runs a script, when it is not
 * one of those words.
 */
export const droppedBecause = (command: string, scripts: ReadonlyArray<string>, run = ""): Option.Option<string> => {
  if (SHELL_SYNTAX.test(command)) return Option.some(NOT_ALLOWED.syntax)
  const words = command.trim().split(/\s+/)
  const [first = "", second = "", third = ""] = words
  const script = (name: string) => name.startsWith("-") ? Option.some(NOT_ALLOWED.otherPackage) : scripts.includes(name) ? Option.none() : Option.some(NOT_ALLOWED.noScript)
  // The manager's own way to run a script (yarn berry's is `node <yarnPath> run`).
  if (run.length > 0 && command.trim().startsWith(`${run} `)) return script(command.trim().slice(run.length + 1).split(/\s+/)[0] ?? "")
  if (MANAGERS.includes(first) && (INSTALLS.includes(second) || (first === "yarn" && words.length === 1))) return Option.some(NOT_ALLOWED.install)
  if (MANAGERS.includes(first) && (second === "run" || second === "run-script")) return third.length === 0 ? Option.some(NOT_ALLOWED.noScript) : script(third)
  if (first === "npm" && (second === "test" || second === "t")) return script("test")
  if ((first === "yarn" || first === "pnpm") && second.length > 0 && !BUILTINS.includes(second)) return script(second)
  if (first === "tsc" || (first === "bun" && second === "test") || ((first === "npx" || first === "bunx") && second === "tsc")) return Option.none()
  if (first === "turbo" && second === "run" && third.length > 0 && !third.startsWith("-")) return Option.none()
  return Option.some(NOT_ALLOWED.unknown)
}

const candidateOf = (command: string, from: CommandFrom, scripts: ReadonlyArray<string>, run: string): Candidate => Option.match(droppedBecause(command, scripts, run), {
  onNone: () => ({ command, from, kept: true, reason: "" }),
  onSome: (reason) => ({ command, from, kept: false, reason }),
})

/**
 * The repository's profile, before any of it runs: the commands of the instruction files' definition of done, then
 * the check scripts (`CHECK_SCRIPTS`) of the base's `package.json` run with its manager (`run`), then the commands
 * given by hand; each once, at its first place, kept or dropped by `droppedBecause`.
 */
export const profileOf = (input: {
  readonly run: string
  readonly packageJson: Option.Option<string>
  readonly instructions: ReadonlyArray<string>
  readonly profile: boolean
  readonly byHand: ReadonlyArray<string>
}): ReadonlyArray<Candidate> => {
  const scripts = scriptsOf(input.packageJson)
  const asked: ReadonlyArray<readonly [string, CommandFrom]> = [
    ...(input.profile ? input.instructions.flatMap(doneCommandsOf).map((command) => [command, "instructions"] as const) : []),
    ...(input.profile ? CHECK_SCRIPTS.filter((name) => scripts.includes(name)).map((name) => [`${input.run} ${name}`, "script"] as const) : []),
    ...input.byHand.map((command) => [command.trim(), "by-hand"] as const),
  ]
  const seen = new Set<string>()
  return asked.flatMap(([command, from]) => {
    if (seen.has(command)) return []
    seen.add(command)
    return [candidateOf(command, from, scripts, input.run)]
  })
}
