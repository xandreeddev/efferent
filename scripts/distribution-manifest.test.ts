import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { distributionDependencies } from "./distribution-manifest.js"

const versions = new Map([["@xandreed/core", "0.14.0"], ["@xandreed/runtime", "0.14.0"]])

describe("distributionDependencies", () => {
  test("workspace packages are caret ranges of their version, and effect a caret-range peer", () => {
    expect(distributionDependencies({
      dependencies: { "@xandreed/core": "workspace:*", "@xandreed/runtime": "workspace:*", effect: "4.0.7", undici: "^7.30.1", "@effect/ai-openai": "4.0.7" },
    }, versions)).toEqual({
      dependencies: { "@xandreed/core": "^0.14.0", "@xandreed/runtime": "^0.14.0", undici: "^7.30.1", "@effect/ai-openai": "4.0.7" },
      peerDependencies: { effect: "^4.0.7" },
    })
  })

  test("a range and a declared peer are kept", () => {
    expect(distributionDependencies({ dependencies: { effect: "^4.0.7" }, peerDependencies: { typescript: "^5.9.3" } }, versions))
      .toEqual({ dependencies: {}, peerDependencies: { typescript: "^5.9.3", effect: "^4.0.7" } })
  })

  test("no published package pins core, another first-party package or effect to one version", async () => {
    const root = join(import.meta.dir, "..")
    const names = Array.from(new Bun.Glob("packages/*/package.json").scanSync({ cwd: root }))
    const manifests = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8")) as { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string> }))
    const all = new Map(manifests.map((manifest) => [manifest.name, manifest.version]))
    const pinned = manifests.flatMap((manifest) => {
      const built = distributionDependencies(manifest, all)
      return Object.entries({ ...built.dependencies, ...built.peerDependencies })
        .filter(([name, range]) => (name === "effect" || name.startsWith("@xandreed/")) && /^\d/.test(range))
        .map(([name, range]) => `${manifest.name} -> ${name}@${range}`)
    })
    expect(pinned).toEqual([])
  })
})
