#!/usr/bin/env bun
/** Create patch release intent only; the normal versioning and publication workflows do the rest. */
import { existsSync } from "node:fs"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Result } from "effect"
import { isReleaseVersion, readSourceManifest, releaseDirectories, sharedReleaseVersion, validateReleaseConfiguration } from "./release-version-plan.js"

const valueOf = <A>(value: Result.Result<A, string>): A => Result.match(value, {
  onSuccess: (result) => result, onFailure: (message) => { throw new Error(message) },
})
export const nextPatchVersion = (current: string): string => {
  if (!isReleaseVersion(current)) throw new Error("A patch release needs a stable shared version")
  const [major, minor, patch] = current.split(".")
  const next = `${major}.${minor}.${Number(patch) + 1}`
  if (!isReleaseVersion(next)) throw new Error("The next patch version exceeds the supported semantic version range")
  return next
}
export const createPatchReleaseIntent = async (root = join(import.meta.dir, "..")) => {
  valueOf(validateReleaseConfiguration(await readFile(join(root, ".changeset/config.json"), "utf8"), await readFile(join(root, "scripts/build-packages.ts"), "utf8")))
  const manifests = await Promise.all(releaseDirectories.map(async (directory) => valueOf(readSourceManifest(await readFile(join(root, "packages", directory, "package.json"), "utf8")))))
  const currentVersion = valueOf(sharedReleaseVersion(manifests))
  const nextVersion = nextPatchVersion(currentVersion)
  if (existsSync(join(root, ".changeset/pre.json"))) throw new Error("Exit Changesets prerelease mode before requesting a stable patch")
  const pending = (await readdir(join(root, ".changeset"), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
  if (pending.length > 0) throw new Error("A manual patch requires no pending release notes; review the existing changesets instead")
  const path = join(root, ".changeset/trusted-publishing-patch.md")
  await writeFile(path, '---\n"@xandreed/core": patch\n---\n\nPublish a coordinated framework patch and its documentation landing package through npm trusted publishing, preserving the verified release source and authentic workflow provenance.\n', { flag: "wx" })
  return { currentVersion, nextVersion, path }
}
if (import.meta.main) {
  if (process.argv.length > 2) { console.error("Usage: bun run release:patch"); process.exit(2) }
  try {
    const result = await createPatchReleaseIntent()
    console.log(`Created patch intent for ${result.nextVersion}; run the normal release versioning workflow to prepare its PR.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Creating patch release intent failed")
    process.exit(1)
  }
}
