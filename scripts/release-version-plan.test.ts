import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Result } from "effect"
import { isTestCode } from "./build-check.js"
import {
  changelogVersionText, isReleaseVersion, lockVersionText, pluginVersionText, publishedVersionText,
  releaseDirectories, releaseNames, releaseVersionPlan, sharedReleaseVersion, validateReleaseConfiguration, versionOutputs,
} from "./release-version-plan.js"

const previous = "0.16.0"
const next = "0.17.0"
const plan = {
  changesets: [{ id: "remember-a-source", summary: "Preserve source evidence.", releases: [{ name: "@xandreed/core", type: "minor" }] }],
  releases: releaseNames.map((name) => ({ name, type: "minor", oldVersion: previous, newVersion: next })),
}
const success = <A>(value: Result.Result<A, string>) => Result.match(value, { onSuccess: (result) => result, onFailure: (message) => { throw new Error(message) } })

describe("shared release version plans", () => {
  test("the Changesets fixed group equals the actual distribution builder", async () => {
    const config = await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8")
    const builder = await readFile(new URL("./build-packages.ts", import.meta.url), "utf8")
    expect(Result.isSuccess(validateReleaseConfiguration(config, builder))).toBe(true)
    expect(Result.isFailure(validateReleaseConfiguration(config.replace('"version": true', '"version": false'), builder))).toBe(true)
    expect(Result.isFailure(validateReleaseConfiguration(config, builder.replace('"core",', '"unexpected",')))).toBe(true)
  })
  test("requires every private source package to share a stable release version", () => {
    const manifests = releaseNames.map((name) => ({ name, version: previous, private: true }))
    expect(success(sharedReleaseVersion(manifests))).toBe(previous)
    expect(Result.isFailure(sharedReleaseVersion(manifests.slice(1)))).toBe(true)
    expect(Result.isFailure(sharedReleaseVersion(manifests.map((entry, index) => index ? entry : { ...entry, version: "0.16.1" })))).toBe(true)
    expect(["0.16.0", "1.0.0"].every(isReleaseVersion)).toBe(true)
    expect(["01.16.0", "0.16.0\nversion=oops", "0.16.0-beta.1", "0.16", "9007199254740992.0.0"].some(isReleaseVersion)).toBe(false)
  })
  test("accepts the captured complete CLI plan and refuses partial, unchanged or foreign releases", () => {
    expect(success(releaseVersionPlan(JSON.stringify(plan), previous))).toEqual({ hasChanges: true, version: next, summaries: ["Preserve source evidence."] })
    expect(Result.isFailure(releaseVersionPlan(JSON.stringify({ ...plan, releases: plan.releases.slice(1) }), previous))).toBe(true)
    expect(Result.isFailure(releaseVersionPlan(JSON.stringify({ ...plan, releases: plan.releases.map((release) => ({ ...release, newVersion: previous })) }), previous))).toBe(true)
    expect(Result.isFailure(releaseVersionPlan(JSON.stringify({ ...plan, preState: {} }), previous))).toBe(true)
    expect(Result.isFailure(releaseVersionPlan(JSON.stringify({ ...plan, changesets: [{ ...plan.changesets[0], releases: [{ name: "@xandreed/foundry", type: "patch" }] }] }), previous))).toBe(true)
    expect(success(releaseVersionPlan('{"changesets":[],"releases":[]}', previous))).toEqual({ hasChanges: false, version: previous, summaries: [] })
  })
  test("plugin updates leave prompt, protocol and unrelated literal versions untouched", () => {
    const source = 'const prompt = {version: "1"}; const example = "0.16.0"; const one = definePlugin({id: "one", version: "0.16.0"}); const two = definePlugin({version: "0.16.0"});'
    const updated = success(pluginVersionText(source, previous, next))
    expect(updated).toContain('prompt = {version: "1"}')
    expect(updated).toContain('example = "0.16.0"')
    expect(updated.match(/version: "0.17.0"/g)).toHaveLength(2)
    expect(Result.isFailure(pluginVersionText('definePlugin({version: "0.1.0"})', previous, next))).toBe(true)
    expect(Result.isFailure(pluginVersionText("definePlugin({version: selected})", previous, next))).toBe(true)
    expect(success(pluginVersionText('definePlugin({id:"@xandreed/sdk/host-contributions",version:"1"})', previous, next))).toContain('version:"1"')
    expect(Result.isFailure(pluginVersionText('definePlugin({id:"@xandreed/plugin-example",version:"1"})', previous, next))).toBe(true)
  })
  test("all current production plugin definitions can be synchronized without editing their files", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const current = JSON.parse(await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8")).version
    const changed: string[] = []
    for (const directory of releaseDirectories) {
      const cwd = `${root}packages/${directory}`
      for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd, onlyFiles: true })) {
        if (isTestCode(file)) continue
        const original = await readFile(`${cwd}/${file}`, "utf8")
        const result = pluginVersionText(original, current, "999.0.0")
        expect(Result.isSuccess(result)).toBe(true)
        if (Result.isSuccess(result) && result.success !== original) changed.push(file)
      }
    }
    expect(changed.length).toBeGreaterThan(10)
  })
  test("lock updates preserve JSONC, external resolutions, and non-distribution workspaces", () => {
    const workspaces = releaseDirectories.map((directory) => `"packages/${directory}": {"name":"@xandreed/${directory}","version":"${previous}"},`).join("\n")
    const source = `{ "lockfileVersion": 1, "workspaces": { ${workspaces} "packages/foundry": {"name":"@xandreed/foundry","version":"0.0.0"}, }, "packages": {"external": ["external@0.16.0", "sha"]}, }`
    const updated = success(lockVersionText(source, previous, next))
    expect(updated.match(/"version":"0.17.0"/g)).toHaveLength(24)
    expect(updated).toContain('"version":"0.0.0"')
    expect(updated).toContain('"external@0.16.0"')
    expect(updated).toEndWith("}, }")
    expect(Result.isFailure(lockVersionText(source.replace('"@xandreed/core"', '"wrong"'), previous, next))).toBe(true)
  })
  test("moves Unreleased notes while preserving prior history and deduplicating summaries", () => {
    const history = "## 0.16.0 — 2026-11-03\n\nOld release.\n"
    const source = `# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Preserve source evidence.\n\n${history}`
    const updated = success(changelogVersionText(source, next, "2026-11-04", ["Preserve source evidence.", "Record observed routines."]))
    expect(updated).toContain("## Unreleased\n\n## 0.17.0 — 2026-11-04")
    expect(updated.match(/Preserve source evidence\./g)).toHaveLength(1)
    expect(updated).toContain("- Record observed routines.")
    expect(updated).toEndWith(history)
    expect(Result.isFailure(changelogVersionText(source, previous, "2026-11-04", []))).toBe(true)
  })
  test("updates exact published version markers and refuses missing or duplicate markers", () => {
    expect(success(publishedVersionText("README.md", "Workspace packages share version `0.16.0`", previous, next))).toBe("Workspace packages share version `0.17.0`")
    expect(Result.isFailure(publishedVersionText("README.md", "No marker", previous, next))).toBe(true)
    expect(versionOutputs({ hasChanges: false, version: previous })).toBe("has_changes=false\nversion=0.16.0\n")
    expect(() => versionOutputs({ hasChanges: true, version: "0.17.0\nforged=true" })).toThrow()
  })
  test("updates current release examples in contributor, roadmap and package instructions", () => {
    const examples = {
      "CONTRIBUTING.md": 'The shared version (`0.16.0`); tag v0.16.0. Earlier 0.3.0 stays frozen.',
      "docs/roadmap.md": 'Workspace manifests share version `0.16.0`.',
      ".agents/skills/add-plugin/SKILL.md": 'definePlugin({ version: "0.16.0" }); protocol version: "1".',
    }
    for (const [name, source] of Object.entries(examples)) {
      const result = success(publishedVersionText(name, source, previous, next))
      expect(result).toBe(source.replaceAll(previous, next))
      expect(success(publishedVersionText(name, "Use <version>; 10.16.0 and 0.16.00 are unrelated.", previous, next))).toBe("Use <version>; 10.16.0 and 0.16.00 are unrelated.")
    }
  })
})
