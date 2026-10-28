import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { planPublish, publishCommand, registry, registryAnswer } from "./publish-plan.js"
import type { BuildStamp, Built, Manifest, PublishState } from "./publish-plan.js"

const commit = "9b898c1bb0740d8ba71cd8429cc5b408c46755cb"
const manifest = (dir: string, version: string, dependencies: ReadonlyArray<string> = []): Manifest => ({
  name: `@xandreed/${dir}`,
  version,
  dependencies: Object.fromEntries([...dependencies.map((name) => [`@xandreed/${name}`, version]), ["effect", "4.0.7"]]),
})
const built = (dir: string, dependencies: ReadonlyArray<string> = [], version = "0.14.0"): Built =>
  ({ dir, manifest: manifest(dir, version, dependencies), source: manifest(dir, version, dependencies) })
const stampOf = (builds: ReadonlyArray<Built>, overrides: Partial<BuildStamp> = {}): BuildStamp => ({
  commit,
  dirty: false,
  version: "0.14.0",
  packages: builds.map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version })),
  ...overrides,
})
/** The repository's shape: core at the bottom, plugins and runtime on core, sdk on runtime, the evals line apart. */
const repository = [
  built("sdk", ["runtime", "core", "plugin-sessions"]),
  built("evals-cli", ["evals"]),
  built("plugin-sessions", ["core"]),
  built("runtime", ["core"]),
  built("core"),
  built("evals"),
]
const ran = (stdout: string): PublishState["head"] => ({ success: true, stdout, stderr: "" })
const state = (overrides: Partial<PublishState> = {}): PublishState => ({
  stamp: stampOf(repository),
  builds: repository,
  head: ran(commit),
  status: ran(""),
  whoami: ran("xandreed"),
  publisher: "xandreed",
  ...overrides,
})

describe("planPublish", () => {
  test("a clean build of HEAD publishes dependencies first", () => {
    const plan = planPublish(state())
    expect(plan.reasons).toEqual([])
    expect(plan.version).toBe("0.14.0")
    expect(plan.order.map(({ dir }) => dir)).toEqual(["core", "evals", "evals-cli", "plugin-sessions", "runtime", "sdk"])
  })

  test("refuses packages that do not share one version", () => {
    const builds = [built("core"), built("runtime", ["core"], "0.13.0")]
    const plan = planPublish(state({ builds, stamp: stampOf(builds, { version: null }) }))
    expect(plan.reasons).toEqual(["the packages do not share one version: @xandreed/core@0.14.0, @xandreed/runtime@0.13.0"])
  })

  test("refuses a build whose source manifest has moved on", () => {
    const core = built("core")
    const builds = [{ ...core, source: manifest("core", "0.15.0") }]
    expect(planPublish(state({ builds, stamp: stampOf(builds) })).reasons)
      .toEqual(["@xandreed/core@0.14.0 was built, but packages/core/package.json is now @xandreed/core@0.15.0; rebuild"])
  })

  test("refuses a build from a commit other than HEAD", () => {
    expect(planPublish(state({ head: ran("15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") })).reasons)
      .toEqual(["the build is from 9b898c1bb07, but HEAD is 15d6dc518d5; rebuild"])
  })

  test("refuses a build stamped dirty, and one made outside git", () => {
    expect(planPublish(state({ stamp: stampOf(repository, { dirty: true }) })).reasons)
      .toEqual(["the build was made from a working tree with changes (or ignored files in a package's published folders); rebuild from a clean checkout"])
    expect(planPublish(state({ stamp: stampOf(repository, { commit: null, dirty: true }) })).reasons).toHaveLength(2)
  })

  test("refuses a working tree with changes", () => {
    expect(planPublish(state({ status: ran("?? notes.md") })).reasons)
      .toEqual(["the working tree has changes; commit, stash or remove them: ?? notes.md"])
  })

  test("refuses packages the stamp does not record, and stamped packages that are missing", () => {
    expect(planPublish(state({ stamp: stampOf([...repository, built("plugin-tasks", ["core"])]) })).reasons)
      .toEqual(["build.json records @xandreed/plugin-tasks@0.14.0, but ./.artifacts/packages/plugin-tasks is missing; rebuild"])
    expect(planPublish(state({ stamp: stampOf(repository.slice(1)) })).reasons)
      .toEqual(["./.artifacts/packages/sdk holds @xandreed/sdk@0.14.0, which build.json does not record; rebuild"])
  })

  test("refuses a dependency cycle and places nothing from it", () => {
    const builds = [built("core"), built("runtime", ["core", "sdk"]), built("sdk", ["runtime"])]
    const plan = planPublish(state({ builds, stamp: stampOf(builds) }))
    expect(plan.reasons).toEqual(["the @xandreed/* dependencies of @xandreed/runtime, @xandreed/sdk form a cycle"])
    expect(plan.order.map(({ dir }) => dir)).toEqual(["core"])
  })

  test("refuses when npm is not logged in, or is logged in as another account", () => {
    expect(planPublish(state({ whoami: { success: false, stdout: "", stderr: "npm error code ENEEDAUTH" } })).reasons)
      .toEqual([`npm whoami failed on ${registry}; log in with npm login:\n      npm error code ENEEDAUTH`])
    expect(planPublish(state({ whoami: ran("someone-else") })).reasons)
      .toEqual(["npm is logged in as someone-else, but the packages are published only as xandreed; npm logout, then npm login as xandreed"])
  })

  test("refuses an empty build", () => {
    expect(planPublish(state({ builds: [], stamp: stampOf([]) })).reasons)
      .toEqual(["./.artifacts/packages holds no built packages; run bun run build:packages first"])
  })
})

describe("registry", () => {
  test("200 is published, 404 is not, anything else refuses", () => {
    const core = manifest("core", "0.14.0")
    expect(registryAnswer(core, 200)).toEqual(Result.succeed(true))
    expect(registryAnswer(core, 404)).toEqual(Result.succeed(false))
    expect(registryAnswer(core, 503)).toEqual(Result.fail("the registry answered 503 for @xandreed/core@0.14.0"))
  })

  test("npm publish is pinned to the registry the check reads, and dry-runs unless live", () => {
    expect(publishCommand("core", false)).toEqual(["npm", "publish", "./.artifacts/packages/core", "--access", "public", "--tag", "latest",
      "--registry", registry, `--@xandreed:registry=${registry}`, "--dry-run"])
    expect(publishCommand("core", true)).not.toContain("--dry-run")
  })
})
