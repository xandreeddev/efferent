import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"

/**
 * A repository to review, made in a temporary folder: a "remote" with a base on `main`, a pull request's head on a
 * branch and as `refs/pull/1/head`, a later commit on top of it as `refs/pull/2/head`, and one more commit on `main`
 * after the head left it. The base also tracks a link that points out of the repository (`LINK_OUT`) and a submodule
 * (`SUBMODULE`), which no tool reads. Git runs with a generic
 * identity and no global or system config, so the host's own config never changes what a test sees.
 */
export interface GitFixture {
  readonly root: string
  readonly remote: string
  readonly cacheRoot: string
  readonly env: Readonly<Record<string, string>>
  readonly base: string
  readonly head: string
  readonly left: string
  /** A commit on top of the head, served as `refs/pull/2/head`: a pull request whose first head is `head`. */
  readonly later: string
  readonly cleanup: () => void
}

/** A file name a shell would read as more than a name. */
export const AWKWARD_NAME = "src/a file's $(echo no).ts"

/** Folders whose names are pathspec magic to git unless paths are literal. */
export const MAGIC_FOLDERS = [":(glob)odd", ":!neg"] as const

/** A binary file whose name holds a line break and a fake header. */
export const FORGED_NAME = "pic\nFile: SAFE.ts (added, +1 -0).bin"

/** A tracked symbolic link that points out of the repository. */
export const LINK_OUT = "src/escape.ts"

/** A tracked submodule (a commit in the tree). */
export const SUBMODULE = "vendor/lib"

/** Lines enough that the diff is longer than a model's shell keeps (8 KiB). */
export const BIG_LINES = 400

export const gitFixture = (): GitFixture => {
  const root = mkdtempSync(join(tmpdir(), "review-git-"))
  const remote = join(root, "remote")
  mkdirSync(remote)
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (...args: ReadonlyArray<string>): string => {
    const ran = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-C", remote, ...args], { env })
    if (ran.exitCode !== 0) Effect.runSync(Effect.die(new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)))
    return ran.stdout.toString().trim()
  }
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(remote, path)), { recursive: true })
    writeFileSync(join(remote, path), text)
  }
  // Every change staged, and the submodule kept: it has no folder on disk, which `add -A` would read as its removal.
  const addAll = () => {
    git("add", "-A")
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${SUBMODULE}`)
  }
  git("init", "--quiet", "-b", "main")
  write("AGENTS.md", "Root rules.\n")
  symlinkSync("AGENTS.md", join(remote, "CLAUDE.md"))
  write("src/AGENTS.md", "Source rules at the base.\n")
  write(".gitattributes", "gen/** linguist-generated\n")
  write("src/sum.ts", ["export const sum = (values: ReadonlyArray<number>) => {", "  let total = 0", "  for (const value of values) {", "    total += value", "  }", "  return total", "}", ""].join("\n"))
  write("docs/old.md", "one\ntwo\nthree\n")
  write("docs/gone.md", "going\n")
  write("src/run.sh", "echo run\n")
  // The skill routes at the base: one skill there, one route to a skill the base does not hold, one to no tree path.
  write(".agents/review-skills.json", JSON.stringify({ skills: [
    { path: ".agents/skills/one/SKILL.md", paths: ["src/**"], diff: [] },
    { path: ".agents/skills/none/SKILL.md", paths: ["**"], diff: [] },
    { path: "../outside/SKILL.md", paths: ["**"], diff: [] },
  ] }))
  write(".agents/skills/one/SKILL.md", "# One\nA skill at the base.\n")
  write(`${MAGIC_FOLDERS[0]}/AGENTS.md`, "Odd rules.\n")
  write(`${MAGIC_FOLDERS[0]}/a.ts`, "export const a = 1\n")
  write(`${MAGIC_FOLDERS[1]}/b.ts`, "export const b = 1\n")
  symlinkSync("../../outside/secret.txt", join(remote, LINK_OUT))
  addAll()
  git("commit", "--quiet", "-m", "base")
  const base = git("rev-parse", "HEAD")
  git("switch", "--quiet", "-c", "fix-sum")
  write("src/sum.ts", ["export const sum = (values: ReadonlyArray<number>) => {", "  let total = 0", "  for (const value of values) {", "    total += value * 1", "  }", "  return total", "}", ""].join("\n"))
  write("src/big.ts", Array.from({ length: BIG_LINES }, (_, at) => `export const value${at} = ${at} // a line long enough`).join("\n") + "\n")
  write("src/AGENTS.md", "Source rules the pull request rewrote.\n")
  write("gen/out.ts", "export const generated = 1\n")
  write("bun.lock", "{}\n")
  write("docs/old.md", "one\n")
  write(AWKWARD_NAME, "export const awkward = true\n")
  write(`${MAGIC_FOLDERS[0]}/a.ts`, "export const a = 2\n")
  write(`${MAGIC_FOLDERS[1]}/b.ts`, "export const b = 2\n")
  writeFileSync(join(remote, FORGED_NAME), new Uint8Array([0, 1, 2, 3, 0, 255]))
  rmSync(join(remote, "docs/gone.md"))
  chmodSync(join(remote, "src/run.sh"), 0o755)
  addAll()
  git("commit", "--quiet", "-m", "fix the sum")
  const head = git("rev-parse", "HEAD")
  git("update-ref", "refs/pull/1/head", head)
  write("src/sum.ts", ["export const sum = (values: ReadonlyArray<number>) => {", "  let total = 0", "  for (const value of values) {", "    total += value", "  }", "  return total", "}", ""].join("\n"))
  addAll()
  git("commit", "--quiet", "-m", "undo the multiplication")
  const later = git("rev-parse", "HEAD")
  git("update-ref", "refs/pull/2/head", later)
  git("switch", "--quiet", "main")
  write("README.md", "Later on main.\n")
  addAll()
  git("commit", "--quiet", "-m", "later")
  const left = git("rev-parse", "HEAD")
  return { root, remote, cacheRoot: join(root, "cache"), env, base, head, left, later, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
