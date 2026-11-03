import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Order } from "effect"
import { createPatchReleaseIntent, nextPatchVersion } from "./release-patch.js"
import { releaseDirectories } from "./release-version-plan.js"

const fixture = async (use: (root: string) => Promise<void>, version = "0.16.0") => {
  const root = await mkdtemp(join(tmpdir(), "efferent-patch-intent-"))
  try {
    await mkdir(join(root, ".changeset"))
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "patch-fixture", private: true, workspaces: ["packages/*"] }))
    await writeFile(join(root, ".changeset/config.json"), await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"))
    await writeFile(join(root, ".changeset/README.md"), "Notes for contributors.\n")
    await writeFile(join(root, "scripts/build-packages.ts"), `const names = ${JSON.stringify(releaseDirectories)};`)
    await writeFile(join(root, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages: {} }))
    for (const directory of [...releaseDirectories, "foundry", "website"]) {
      await mkdir(join(root, "packages", directory), { recursive: true })
      await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify({ name: `@xandreed/${directory}`, version: directory === "foundry" || directory === "website" ? "0.0.0" : version, ...(directory === "core" || directory === "foundry" || directory === "website" ? { private: true } : {}) }))
    }
    await use(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("manual patch creates one core intent without changing package versions", () => fixture(async (root) => {
  const result = await createPatchReleaseIntent(root)
  expect(result.currentVersion).toBe("0.16.0")
  expect(result.nextVersion).toBe("0.16.1")
  expect((await readdir(join(root, ".changeset"))).sort(Order.String)).toEqual(["README.md", "config.json", "trusted-publishing-patch.md"])
  const note = await readFile(result.path, "utf8")
  expect(note).toStartWith('---\n"@xandreed/core": patch\n---\n')
  expect(note).toContain("npm trusted publishing")
  for (const directory of releaseDirectories) expect((await Bun.file(join(root, "packages", directory, "package.json")).json()).version).toBe("0.16.0")
  const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js")
  const versioned = Bun.spawnSync(["node", cli, "version"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect({ success: versioned.success, stderr: versioned.stderr.toString(), stdout: versioned.stdout.toString() }).toMatchObject({ success: true })
  for (const directory of releaseDirectories) expect((await Bun.file(join(root, "packages", directory, "package.json")).json()).version).toBe("0.16.1")
}), 10000)

test("existing major, minor, patch or empty notes refuse without replacing release intent", async () => {
  for (const bump of ["major", "minor", "patch", "empty"]) await fixture(async (root) => {
    const body = bump === "empty" ? "---\n---\n\nExisting note.\n" : `---\n"@xandreed/core": ${bump}\n---\n\nExisting note.\n`
    const original = join(root, ".changeset/existing.md")
    await writeFile(original, body)
    await expect(createPatchReleaseIntent(root)).rejects.toThrow("no pending release notes")
    expect(await readFile(original, "utf8")).toBe(body)
    expect((await readdir(join(root, ".changeset"))).sort(Order.String)).toEqual(["README.md", "config.json", "existing.md"])
  })
})

test("a repeated or concurrent request preserves the first exclusive patch note", () => fixture(async (root) => {
  const attempts = await Promise.allSettled([createPatchReleaseIntent(root), createPatchReleaseIntent(root)])
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1)
  await expect(createPatchReleaseIntent(root)).rejects.toThrow("no pending release notes")
}))

test("invalid shared versions, prerelease mode and patch overflow refuse before writing a note", async () => {
  for (const version of ["0.16.0-beta.1", "0.16.9007199254740991"]) await fixture(async (root) => {
    await expect(createPatchReleaseIntent(root)).rejects.toThrow()
    expect((await readdir(join(root, ".changeset"))).sort(Order.String)).toEqual(["README.md", "config.json"])
  }, version)
  await fixture(async (root) => {
    await writeFile(join(root, ".changeset/pre.json"), "{}")
    await expect(createPatchReleaseIntent(root)).rejects.toThrow("prerelease mode")
  })
  expect(() => nextPatchVersion("0.16.0\ninput=bad")).toThrow()
})
