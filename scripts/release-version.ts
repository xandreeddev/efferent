#!/usr/bin/env bun
/** Prepare a shared release through Changesets; never publish, tag, commit, or overwrite a release fixture. */
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { Result } from "effect"
import { isTestCode } from "./build-check.js"
import {
  changelogVersionText, lockVersionText, pluginVersionText, publishedVersionText, readSourceManifest,
  releaseDirectories, releaseVersionPlan, sharedReleaseVersion, validateReleaseConfiguration, versionOutputs,
} from "./release-version-plan.js"
import type { ReleaseVersionPlan } from "./release-version-plan.js"

const require = createRequire(import.meta.url)
const defaultRoot = join(import.meta.dir, "..")
const valueOf = <A>(value: Result.Result<A, string>): A => Result.match(value, {
  onFailure: (message) => { throw new Error(message) }, onSuccess: (result) => result,
})
const execute = async (root: string, command: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  console.log(`$ ${command.join(" ")}`)
  const result = await Bun.spawn([...command], { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited
  if (result !== 0) throw new Error(`Release versioning stopped: ${command.join(" ")} exited ${result}`)
}
const manifestsAt = async (root: string) => Promise.all(releaseDirectories.map(async (directory) => valueOf(readSourceManifest(await readFile(join(root, "packages", directory, "package.json"), "utf8")))))

/** The optional root/date make the complete CLI orchestration testable in an isolated repository. */
export const runReleaseVersion = async (root = defaultRoot, day = new Date().toISOString().slice(0, 10), env: NodeJS.ProcessEnv = process.env): Promise<ReleaseVersionPlan> => {
  valueOf(validateReleaseConfiguration(await readFile(join(root, ".changeset/config.json"), "utf8"), await readFile(join(root, "scripts/build-packages.ts"), "utf8")))
  const previous = valueOf(sharedReleaseVersion(await manifestsAt(root)))
  if (existsSync(join(root, ".changeset/pre.json"))) throw new Error("Exit Changesets prerelease mode before preparing a stable release")
  const notes = (await readdir(join(root, ".changeset"), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
  if (notes.length === 0) return { hasChanges: false, version: previous, summaries: [] }
  const cli = require.resolve("@changesets/cli/bin.js")
  const status = join(root, ".artifacts/release-version/status.json")
  await mkdir(dirname(status), { recursive: true })
  await execute(root, ["node", cli, "status", "--output", status], env)
  const plan = valueOf(releaseVersionPlan(await readFile(status, "utf8"), previous))
  if (!plan.hasChanges) return plan

  // Check every deterministic edit and fixture collision before Changesets consumes the notes.
  const edits: Array<{ readonly path: string; readonly text: string }> = []
  for (const directory of releaseDirectories) {
    const cwd = join(root, "packages", directory)
    for (const relative of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd, onlyFiles: true })) {
      if (isTestCode(relative)) continue
      const path = join(cwd, relative)
      const original = await readFile(path, "utf8")
      const text = valueOf(pluginVersionText(original, previous, plan.version))
      if (text !== original) edits.push({ path, text })
    }
  }
  for (const relative of ["README.md", "packages/website/src/content/docs/getting-started.md", "packages/website/src/pages/index.astro", "CONTRIBUTING.md", "docs/roadmap.md", ".agents/skills/add-plugin/SKILL.md"]) {
    edits.push({ path: join(root, relative), text: valueOf(publishedVersionText(relative, await readFile(join(root, relative), "utf8"), previous, plan.version)) })
  }
  edits.push({ path: join(root, "CHANGELOG.md"), text: valueOf(changelogVersionText(await readFile(join(root, "CHANGELOG.md"), "utf8"), plan.version, day, plan.summaries)) })
  const lock = valueOf(lockVersionText(await readFile(join(root, "bun.lock"), "utf8"), previous, plan.version))
  for (const relative of [`packages/sdk/fixtures/journal-${plan.version}.json`, `packages/evals/fixtures/run-${plan.version}.json`]) {
    if (existsSync(join(root, relative))) throw new Error(`${relative} already exists; release fixtures cannot be overwritten`)
  }

  await execute(root, ["node", cli, "version"], env)
  const actual = valueOf(sharedReleaseVersion(await manifestsAt(root)))
  if (actual !== plan.version) throw new Error(`Changesets produced ${actual}, but its captured plan required ${plan.version}`)
  for (const edit of edits) await writeFile(edit.path, edit.text)
  await execute(root, ["bun", "scripts/record-journal-fixture.ts"], env)
  await execute(root, ["bun", "scripts/record-run-fixture.ts"], env)
  await execute(root, ["bun", "run", "docs:generate"], env)
  // Bun 1.3.0 otherwise retains stale workspace versions on a version-only manifest change.
  await writeFile(join(root, "bun.lock"), lock)
  await execute(root, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], env)
  return plan
}

if (import.meta.main) {
  if (process.argv.length > 2) { console.error("Usage: bun run release:version"); process.exit(2) }
  try {
    const plan = await runReleaseVersion()
    const output = versionOutputs(plan)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output)
    console.log(plan.hasChanges ? `Prepared release ${plan.version}; review and commit the generated files.` : `No pending release changes; keeping ${plan.version}.`)
    console.log(output.trim())
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release version preparation failed")
    process.exit(1)
  }
}
