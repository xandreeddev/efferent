import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { ciAuthentication, confirmSchedule, confirmation, tagConfirmSchedule, notCleanTree, planPublish, publishCommand, registry, registryAnswer, registryProvenance, releaseSteps, remoteTagCommit, tagPlan } from "./publish-plan.js"
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

  test("an absent version starts a new release, and an existing one resumes only at its exact commit", () => {
    const core = manifest("core", "0.16.0")
    expect(registryProvenance(core, commit, 404, "")).toEqual(Result.succeed(undefined))
    expect(registryProvenance(core, commit, 200, JSON.stringify({ name: core.name, version: core.version, gitHead: commit }))).toEqual(Result.succeed(undefined))
    const different = registryProvenance(core, commit, 200, JSON.stringify({ name: core.name, version: core.version, gitHead: "15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))
    expect(different).toEqual(Result.fail("@xandreed/core@0.16.0 was published from 15d6dc518d5, not HEAD 9b898c1bb07; resume from its original commit or prepare a new shared version"))
  })

  test("missing provenance, malformed metadata, mismatched identity and registry refusals fail closed", () => {
    const core = manifest("core", "0.16.0")
    expect(Result.isFailure(registryProvenance(core, commit, 200, JSON.stringify({ name: core.name, version: core.version })))).toBe(true)
    expect(Result.isFailure(registryProvenance(core, commit, 200, JSON.stringify({ name: core.name, version: core.version, gitHead: "" })))).toBe(true)
    expect(registryProvenance(core, commit, 200, "not json")).toEqual(Result.fail("the registry returned invalid release metadata for @xandreed/core@0.16.0"))
    expect(Result.isFailure(registryProvenance(core, commit, 200, JSON.stringify({ name: core.name, version: "0.15.1", gitHead: commit })))).toBe(true)
    expect(registryProvenance(core, commit, 503, "")).toEqual(Result.fail("the registry answered 503 for @xandreed/core@0.16.0"))
  })
})

describe("confirmation", () => {
  const core = manifest("core", "0.14.0")
  const found = Result.succeed(true)
  const absent = Result.succeed(false)
  const { attempts } = confirmSchedule

  test("tagging waits about fifteen minutes for packages the registry's CDN still hides", () => {
    expect(tagConfirmSchedule.attempts * tagConfirmSchedule.intervalMillis).toBe(900_000)
    expect(confirmation(core, [...Array.from({ length: 60 }, () => absent), found], tagConfirmSchedule.attempts)).toEqual({ _tag: "Published" })
    expect(confirmation(core, Array.from({ length: tagConfirmSchedule.attempts }, () => absent), tagConfirmSchedule.attempts)._tag).toBe("Missing")
  })

  test("permits registry propagation beyond a minute within a three-minute bound", () => {
    expect(attempts * confirmSchedule.intervalMillis).toBe(180_000)
    expect(confirmation(core, [...Array.from({ length: 15 }, () => absent), found], attempts)).toEqual({ _tag: "Published" })
  })

  test("a failed upload the registry has is published: on the first answer, after the CDN's 404s, and when a 404 follows", () => {
    expect(confirmation(core, [found], attempts)).toEqual({ _tag: "Published" })
    expect(confirmation(core, [absent, absent, found], attempts)).toEqual({ _tag: "Published" })
    expect(confirmation(core, [found, absent], attempts)).toEqual({ _tag: "Published" })
  })

  test("asks again until it has every answer, then the version is missing", () => {
    expect(confirmation(core, [], attempts)).toEqual({ _tag: "Pending" })
    expect(confirmation(core, Array.from({ length: attempts - 1 }, () => absent), attempts)).toEqual({ _tag: "Pending" })
    expect(confirmation(core, Array.from({ length: attempts }, () => absent), attempts))
      .toEqual({ _tag: "Missing", reason: `the registry does not have @xandreed/core@0.14.0 after ${attempts} checks` })
  })

  test("a missing version names the registry's last refusal", () => {
    const answers = [registryAnswer(core, 503), absent, registryAnswer(core, 500)]
    expect(confirmation(core, answers, 3))
      .toEqual({ _tag: "Missing", reason: "the registry does not have @xandreed/core@0.14.0 after 3 checks (the last refusal: the registry answered 500 for @xandreed/core@0.14.0)" })
  })
})

describe("release:publish", () => {
  test("installs without lifecycle scripts, builds, dry-runs, then publishes", () => {
    expect(releaseSteps({ verify: false, dryRun: false })).toEqual([
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["bun", "run", "build:packages"],
      ["bun", "run", "publish:packages"],
      ["bun", "run", "publish:packages", "--publish"],
    ])
  })

  test("verifies the build only when asked, and a dry run stops before the upload", () => {
    expect(releaseSteps({ verify: true, dryRun: false })[2]).toEqual(["bun", "run", "verify:packages"])
    expect(releaseSteps({ verify: false, dryRun: true }).at(-1)).toEqual(["bun", "run", "publish:packages"])
    expect(releaseSteps({ verify: true, dryRun: true }).flat()).not.toContain("--publish")
  })

  test("refuses a checkout with changes, as publish:packages does", () => {
    expect(notCleanTree(ran(""))).toEqual([])
    expect(notCleanTree(ran(" M package.json\n?? notes.md")))
      .toEqual(["the working tree has changes; commit, stash or remove them: M package.json, ?? notes.md"])
    expect(notCleanTree({ success: false, stdout: "", stderr: "fatal: not a git repository" })).toEqual(["git cannot read the working tree status"])
  })
})

describe("tagPlan", () => {
  const other = "15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const listing = (sha: string, ref = "refs/tags/v0.14.0") => ran(`${sha}\t${ref}`)
  const none = ran("")
  const tag = "v0.14.0"

  test("reads the commit origin's tag names, an annotated tag's peeled line first, and no other tag", () => {
    expect(remoteTagCommit(`${commit}\trefs/tags/v0.14.0`, tag)).toBe(commit)
    expect(remoteTagCommit(`${other}\trefs/tags/v0.14.0\n${commit}\trefs/tags/v0.14.0^{}`, tag)).toBe(commit)
    expect(remoteTagCommit(`${commit}\trefs/tags/v0.14.01`, tag)).toBeNull()
    expect(remoteTagCommit("", tag)).toBeNull()
  })

  test("creates and pushes a new tag, and keeps what already names HEAD", () => {
    expect(tagPlan({ tag, head: commit, local: null, remote: none }))
      .toEqual({ reasons: [], commands: [["git", "tag", tag], ["git", "push", "origin", "refs/tags/v0.14.0:refs/tags/v0.14.0"]] })
    expect(tagPlan({ tag, head: commit, local: commit, remote: none }).commands).toEqual([["git", "push", "origin", "refs/tags/v0.14.0:refs/tags/v0.14.0"]])
    expect(tagPlan({ tag, head: commit, local: commit, remote: listing(commit) })).toEqual({ reasons: [], commands: [] })
  })

  test("never moves a tag that names another commit, here or on origin", () => {
    expect(tagPlan({ tag, head: commit, local: other, remote: none }))
      .toEqual({ reasons: ["the tag v0.14.0 names 15d6dc518d5, not HEAD 9b898c1bb07; a release tag is never moved"], commands: [] })
    expect(tagPlan({ tag, head: commit, local: null, remote: listing(other) }))
      .toEqual({ reasons: ["origin's tag v0.14.0 names 15d6dc518d5, not HEAD 9b898c1bb07; a release tag is never moved"], commands: [] })
  })

  test("refuses when origin's tags cannot be read", () => {
    expect(tagPlan({ tag, head: commit, local: null, remote: { success: false, stdout: "", stderr: "fatal: could not read from remote repository" } }))
      .toEqual({ reasons: ["git cannot read the tags on origin: fatal: could not read from remote repository"], commands: [] })
  })
})

describe("CI authentication", () => {
  const github = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "xandreeddev/efferent" }
  const oidc = { ...github, ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.invalid/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture" }
  test("requires this repository's Actions context and credentials, preferring an explicit npm token", () => {
    expect(Result.isFailure(ciAuthentication({}))).toBe(true)
    expect(Result.isFailure(ciAuthentication({ ...oidc, GITHUB_REPOSITORY: "somewhere/else" }))).toBe(true)
    expect(Result.isFailure(ciAuthentication(github))).toBe(true)
    expect(Result.isFailure(ciAuthentication({ ...oidc, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }))).toBe(true)
    expect(ciAuthentication(oidc)).toEqual(Result.succeed("oidc"))
    expect(ciAuthentication({ ...oidc, NODE_AUTH_TOKEN: "fixture-token" })).toEqual(Result.succeed("token"))
  })
  test("OIDC skips only account lookup and retains all build guards", () => {
    const unavailable = { success: false, stdout: "", stderr: "not a token session" }
    expect(planPublish(state({ authentication: "oidc", whoami: unavailable })).reasons).toEqual([])
    expect(planPublish(state({ authentication: "oidc", whoami: unavailable, stamp: stampOf(repository, { dirty: true }) })).reasons).toHaveLength(1)
    expect(planPublish(state({ authentication: "token", whoami: unavailable })).reasons).toHaveLength(1)
    expect(publishCommand("core", false, true)).toContain("--provenance")
  })
})
