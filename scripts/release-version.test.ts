import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { releaseDirectories, versionOutputs } from "./release-version-plan.js"
import { runReleaseVersion } from "./release-version.js"

const previous = "0.16.0"
const fixture = async (use: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "efferent-release-version-"))
  const put = async (name: string, text: string) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
  try {
    await put("package.json", JSON.stringify({ name: "release-fixture", private: true, workspaces: ["packages/*"], scripts: { "docs:generate": "bun scripts/docs.ts" } }))
    await put(".changeset/config.json", await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"))
    await put(".changeset/README.md", "Release fixture notes.")
    await put("scripts/build-packages.ts", `const names = ${JSON.stringify(releaseDirectories)};`)
    await put("README.md", `Workspace packages share version \`${previous}\`.\n`)
    await put("packages/website/src/content/docs/getting-started.md", `This guide follows version \`${previous}\`.\n`)
    await put("packages/website/src/pages/index.astro", `<p>${previous} on npm</p>\n`)
    await put("CONTRIBUTING.md", `Release version \`${previous}\`; tag v${previous}.\n`)
    await put("docs/roadmap.md", `Workspace manifests share version \`${previous}\`.\n`)
    await put(".agents/skills/add-plugin/SKILL.md", `definePlugin({version: "${previous}"}); protocol version: "1".\n`)
    await put("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Keep existing release prose.\n\n## 0.16.0 — 2026-11-03\n\nAn old release.\n")
    for (const directory of releaseDirectories) {
      await put(`packages/${directory}/package.json`, JSON.stringify({ name: `@xandreed/${directory}`, private: true, version: previous, ...(directory === "core" ? {} : { dependencies: { "@xandreed/core": "workspace:*" } }) }))
      await put(`packages/${directory}/src/plugin.adapter.ts`, `const protocol = { version: "1" }; export const plugin = definePlugin({ version: "${previous}" });\n`)
      await put(`packages/${directory}/src/plugin.adapter.test.ts`, `const historical = "${previous}";\n`)
    }
    for (const directory of ["foundry", "website"]) await put(`packages/${directory}/package.json`, JSON.stringify({ name: `@xandreed/${directory}`, private: true, version: "0.0.0" }))
    const workspaces = Object.fromEntries([["", { name: "release-fixture" }], ...releaseDirectories.map((directory) => [`packages/${directory}`, { name: `@xandreed/${directory}`, version: previous, ...(directory === "core" ? {} : { dependencies: { "@xandreed/core": "workspace:*" } }) }] as const), ...["foundry", "website"].map((directory) => [`packages/${directory}`, { name: `@xandreed/${directory}`, version: "0.0.0" }] as const)])
    await put("bun.lock", JSON.stringify({ lockfileVersion: 1, workspaces, packages: {} }, null, 2))
    await put("packages/sdk/fixtures/journal-0.16.0.json", "old journal bytes\n")
    await put("packages/evals/fixtures/run-0.16.0.json", "old run bytes\n")
    for (const [script, directory, prefix] of [["record-journal-fixture", "sdk", "journal"], ["record-run-fixture", "evals", "run"]]) {
      await put(`scripts/${script}.ts`, `import {writeFile} from "node:fs/promises"; const {version} = await Bun.file("packages/core/package.json").json(); await writeFile(\`packages/${directory}/fixtures/${prefix}-\${version}.json\`, JSON.stringify({version}), {flag:"wx"});`)
    }
    await put("scripts/docs.ts", 'import {mkdir,writeFile} from "node:fs/promises"; await mkdir("docs",{recursive:true}); const {version}=await Bun.file("packages/core/package.json").json(); await writeFile("docs/plugin-reference.json",JSON.stringify({version}));')
    // Git is read only: the real Changesets CLI sees a clean baseline without creating test commits.
    await put("bin/git", '#!/bin/sh\ncase "$1" in\n merge-base) printf "%s\\n" "0000000000000000000000000000000000000001" ;;\n rev-parse) if [ "$2" = "--show-toplevel" ]; then printf "%s\\n" "$RELEASE_VERSION_FIXTURE_ROOT"; else printf "%s\\n" "0000000000000000000000000000000000000001"; fi ;;\n diff) exit 0 ;;\n *) exit 1 ;;\nesac\n')
    await chmod(join(root, "bin/git"), 0o755)
    await use(root, { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, RELEASE_VERSION_FIXTURE_ROOT: root })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("no pending notes preserves the prepared 0.16.0 release without invoking Changesets", () => fixture(async (root, env) => {
  const before = await readFile(join(root, "bun.lock"), "utf8")
  const result = await runReleaseVersion(root, "2026-11-04", { ...env, PATH: join(root, "bin") })
  expect(result).toEqual({ hasChanges: false, version: previous, summaries: [] })
  expect(versionOutputs(result)).toBe("has_changes=false\nversion=0.16.0\n")
  expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(before)
  expect(await readdir(join(root, ".changeset"))).toEqual(["README.md", "config.json"])
}))

test("actual Changesets versions all private packages and the wrapper synchronizes release artifacts", () => fixture(async (root, env) => {
  await writeFile(join(root, ".changeset/ground-memory.md"), '---\n"@xandreed/core": minor\n---\n\nRetain source evidence.\n')
  const result = await runReleaseVersion(root, "2026-11-04", env)
  expect(result).toEqual({ hasChanges: true, version: "0.17.0", summaries: ["Retain source evidence."] })
  for (const directory of releaseDirectories) {
    expect((await Bun.file(join(root, `packages/${directory}/package.json`)).json()).version).toBe("0.17.0")
    if (directory !== "core") expect((await Bun.file(join(root, `packages/${directory}/package.json`)).json()).dependencies["@xandreed/core"]).toBe("workspace:*")
    expect(await readFile(join(root, `packages/${directory}/src/plugin.adapter.ts`), "utf8")).toContain('version: "0.17.0"')
    expect(await readFile(join(root, `packages/${directory}/src/plugin.adapter.ts`), "utf8")).toContain('protocol = { version: "1" }')
    expect(await readFile(join(root, `packages/${directory}/src/plugin.adapter.test.ts`), "utf8")).toContain(previous)
  }
  expect((await Bun.file(join(root, "packages/foundry/package.json")).json()).version).toBe("0.0.0")
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8")
  expect(changelog).toContain("## 0.17.0 — 2026-11-04")
  expect(changelog).toContain("Keep existing release prose.")
  expect(changelog).toContain("Retain source evidence.")
  expect(await readFile(join(root, "CONTRIBUTING.md"), "utf8")).toBe("Release version `0.17.0`; tag v0.17.0.\n")
  expect(await readFile(join(root, "docs/roadmap.md"), "utf8")).toBe("Workspace manifests share version `0.17.0`.\n")
  expect(await readFile(join(root, ".agents/skills/add-plugin/SKILL.md"), "utf8")).toBe('definePlugin({version: "0.17.0"}); protocol version: "1".\n')
  expect(await readFile(join(root, "packages/sdk/fixtures/journal-0.16.0.json"), "utf8")).toBe("old journal bytes\n")
  expect(await readFile(join(root, "packages/evals/fixtures/run-0.16.0.json"), "utf8")).toBe("old run bytes\n")
  expect((await Bun.file(join(root, "packages/sdk/fixtures/journal-0.17.0.json")).json()).version).toBe("0.17.0")
  expect((await Bun.file(join(root, "packages/evals/fixtures/run-0.17.0.json")).json()).version).toBe("0.17.0")
  expect((await Bun.file(join(root, "docs/plugin-reference.json")).json()).version).toBe("0.17.0")
  expect((await readFile(join(root, "bun.lock"), "utf8")).match(/"version": "0.17.0"/g)).toHaveLength(24)
  expect(await readdir(join(root, ".changeset"))).toEqual(["README.md", "config.json"])
  expect((await runReleaseVersion(root, "2026-11-04", env)).hasChanges).toBe(false)
}), 20000)

test("empty release notes are a no-op rather than an extra bootstrap version", () => fixture(async (root, env) => {
  await writeFile(join(root, ".changeset/no-package-change.md"), "---\n---\n\nDocumentation only.\n")
  expect((await runReleaseVersion(root, "2026-11-04", env))).toEqual({ hasChanges: false, version: previous, summaries: [] })
  expect((await Bun.file(join(root, "packages/core/package.json")).json()).version).toBe(previous)
}))

test("notes for unpublished tooling are rejected without consuming them", () => fixture(async (root, env) => {
  await writeFile(join(root, ".changeset/foundry-change.md"), '---\n"@xandreed/foundry": patch\n---\n\nTooling only.\n')
  await expect(runReleaseVersion(root, "2026-11-04", env)).rejects.toThrow("outside the distribution group")
  expect((await Bun.file(join(root, "packages/foundry/package.json")).json()).version).toBe("0.0.0")
  expect(await readFile(join(root, ".changeset/foundry-change.md"), "utf8")).toContain("Tooling only.")
}))

test("an existing target fixture refuses before consuming changesets or altering manifests", () => fixture(async (root, env) => {
  await writeFile(join(root, ".changeset/patch-core.md"), '---\n"@xandreed/core": patch\n---\n\nRetain source evidence.\n')
  await writeFile(join(root, "packages/sdk/fixtures/journal-0.16.1.json"), "do not replace\n")
  await expect(runReleaseVersion(root, "2026-11-04", env)).rejects.toThrow("release fixtures cannot be overwritten")
  expect((await Bun.file(join(root, "packages/core/package.json")).json()).version).toBe(previous)
  expect(await readFile(join(root, "packages/sdk/fixtures/journal-0.16.1.json"), "utf8")).toBe("do not replace\n")
  expect(await readFile(join(root, ".changeset/patch-core.md"), "utf8")).toContain("Retain source evidence.")
}))
