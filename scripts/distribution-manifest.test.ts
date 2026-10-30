import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { distributionDependencies, installedCopies, PEERS } from "./distribution-manifest.js"

const versions = new Map([["@xandreed/core", "0.14.0"], ["@xandreed/runtime", "0.14.0"]])

describe("distributionDependencies", () => {
  test("workspace packages are caret ranges of their version, and core and effect caret-range peers", () => {
    expect(distributionDependencies({
      dependencies: { "@xandreed/core": "workspace:*", "@xandreed/runtime": "workspace:*", effect: "4.0.7", undici: "^7.30.1", "@effect/ai-openai": "4.0.7" },
    }, versions)).toEqual({
      dependencies: { "@xandreed/runtime": "^0.14.0", undici: "^7.30.1", "@effect/ai-openai": "4.0.7" },
      peerDependencies: { "@xandreed/core": "^0.14.0", effect: "^4.0.7" },
    })
  })

  test("a range and a declared peer are kept", () => {
    expect(distributionDependencies({ dependencies: { effect: "^4.0.7" }, peerDependencies: { typescript: "^5.9.3" } }, versions))
      .toEqual({ dependencies: {}, peerDependencies: { typescript: "^5.9.3", effect: "^4.0.7" } })
  })

  test("no published package pins core, another first-party package or effect to one version, or depends on core but as a peer", async () => {
    const root = join(import.meta.dir, "..")
    const names = Array.from(new Bun.Glob("packages/*/package.json").scanSync({ cwd: root }))
    const manifests = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8")) as { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string> }))
    const all = new Map(manifests.map((manifest) => [manifest.name, manifest.version]))
    const built = manifests.map((manifest) => ({ name: manifest.name, ...distributionDependencies(manifest, all) }))
    const pinned = built.flatMap(({ name, dependencies, peerDependencies }) => Object.entries({ ...dependencies, ...peerDependencies })
      .filter(([dependency, range]) => (dependency === "effect" || dependency.startsWith("@xandreed/")) && /^\d/.test(range))
      .map(([dependency, range]) => `${name} -> ${dependency}@${range}`))
    expect(pinned).toEqual([])
    expect(built.filter(({ dependencies }) => PEERS.some((peer) => peer in dependencies)).map(({ name }) => name)).toEqual([])
    expect(built.filter(({ peerDependencies }) => "@xandreed/core" in peerDependencies).length).toBeGreaterThan(10)
  })
})

describe("installedCopies", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "efferent-copies-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const install = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
  }

  test("counts a copy nested under another package once, beside the hoisted one", () => {
    const modules = join(root, "hoisted/node_modules")
    install(join(modules, "effect"), "effect")
    install(join(modules, "@xandreed/core"), "@xandreed/core")
    install(join(modules, "@xandreed/sdk"), "@xandreed/sdk")
    install(join(modules, "@xandreed/sdk/node_modules/effect"), "effect")
    install(join(modules, ".cache/effect"), "effect")
    expect(installedCopies(modules, PEERS)).toEqual(new Map([
      ["@xandreed/core", [join(modules, "@xandreed/core")]],
      ["effect", [join(modules, "@xandreed/sdk/node_modules/effect"), join(modules, "effect")]],
    ]))
  })

  test("counts the store's copy of an isolated install once, however many links reach it", () => {
    const modules = join(root, "isolated/node_modules")
    const store = join(modules, ".bun")
    install(join(store, "effect@4.0.7/node_modules/effect"), "effect")
    install(join(store, "@xandreed+core@0.14.0/node_modules/@xandreed/core"), "@xandreed/core")
    install(join(store, "@xandreed+sdk@0.14.0/node_modules/@xandreed/sdk"), "@xandreed/sdk")
    mkdirSync(join(store, "@xandreed+core@0.14.0/node_modules/effect", ".."), { recursive: true })
    symlinkSync(join(store, "effect@4.0.7/node_modules/effect"), join(store, "@xandreed+core@0.14.0/node_modules/effect"))
    symlinkSync(join(store, "effect@4.0.7/node_modules/effect"), join(store, "@xandreed+sdk@0.14.0/node_modules/effect"))
    symlinkSync(join(store, "@xandreed+core@0.14.0/node_modules/@xandreed/core"), join(store, "@xandreed+sdk@0.14.0/node_modules/@xandreed/core"))
    symlinkSync(join(store, "effect@4.0.7/node_modules/effect"), join(modules, "effect"))
    mkdirSync(join(modules, "@xandreed"), { recursive: true })
    symlinkSync(join(store, "@xandreed+core@0.14.0/node_modules/@xandreed/core"), join(modules, "@xandreed/core"))
    expect(installedCopies(modules, PEERS)).toEqual(new Map([
      ["@xandreed/core", [join(store, "@xandreed+core@0.14.0/node_modules/@xandreed/core")]],
      ["effect", [join(store, "effect@4.0.7/node_modules/effect")]],
    ]))
  })
})
