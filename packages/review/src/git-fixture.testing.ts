import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"

/**
 * A repository to review, made in a temporary folder: a "remote" with a base on `main`, a pull request's head on a
 * branch and as `refs/pull/1/head`, and one more commit on `main` after the head left it. Git runs with a generic
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
  readonly cleanup: () => void
}

/** A file name a shell would read as more than a name. */
export const AWKWARD_NAME = "src/a file's $(echo no).ts"

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
  git("init", "--quiet", "-b", "main")
  write("AGENTS.md", "Root rules.\n")
  symlinkSync("AGENTS.md", join(remote, "CLAUDE.md"))
  write("src/AGENTS.md", "Source rules at the base.\n")
  write(".gitattributes", "gen/** linguist-generated\n")
  write("src/sum.ts", ["export const sum = (values: ReadonlyArray<number>) => {", "  let total = 0", "  for (const value of values) {", "    total += value", "  }", "  return total", "}", ""].join("\n"))
  write("docs/old.md", "one\ntwo\nthree\n")
  git("add", "-A")
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
  git("add", "-A")
  git("commit", "--quiet", "-m", "fix the sum")
  const head = git("rev-parse", "HEAD")
  git("update-ref", "refs/pull/1/head", head)
  git("switch", "--quiet", "main")
  write("README.md", "Later on main.\n")
  git("add", "-A")
  git("commit", "--quiet", "-m", "later")
  const left = git("rev-parse", "HEAD")
  return { root, remote, cacheRoot: join(root, "cache"), env, base, head, left, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
