import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Order, Schema } from "effect"
import { decodeLandingJson, landingArguments, landingCommand, landingManifest, landingReadme, packNpmLanding } from "./npm-landing.js"
import type { LandingCommand } from "./npm-landing.js"
import { publishNpmLanding } from "./publish-npm-landing.js"

const sha = "9b898c1bb0740d8ba71cd8429cc5b408c46755cb"
const workflowSha = "15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const version = "0.16.0"
const ci = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "xandreeddev/efferent", GITHUB_SHA: workflowSha, NODE_AUTH_TOKEN: "", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/request", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc" }
const fixture = async (use: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "efferent-landing-"))
  try {
    await mkdir(join(root, "packages/core"), { recursive: true })
    await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ name: "@xandreed/core", version }))
    await writeFile(join(root, "README.md"), "# Efferent\n\n[Guide](docs/framework.md#tools)\n")
    await writeFile(join(root, "LICENSE"), "MIT fixture license\n")
    await use(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const reply = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr })
const git: LandingCommand = async (command) => command[1] === "rev-parse" ? reply(sha) : reply("")

test("the landing manifest has documentation metadata and no executable or dependency surface", () => {
  const manifest = landingManifest({ root: "unused", sha, version })
  expect(manifest).toEqual({ name: "efferent", version, description: "Reserved Efferent framework name and documentation. Install the maintained @xandreed/* packages.", license: "MIT", gitHead: sha, repository: { type: "git", url: "git+https://github.com/xandreeddev/efferent.git" }, homepage: "https://xandreeddev.github.io/efferent/", files: ["README.md", "LICENSE"] })
  expect(["dependencies", "peerDependencies", "bin", "scripts", "main", "exports"].some((key) => Object.hasOwn(manifest, key))).toBe(false)
})

test("the reserved-name notice precedes the current README and links use the immutable source", () => {
  const prose = '[Guide with `code`](./docs/framework.md#tools) [Anchor](#install) [Web](https://example.test/doc) [Mail](mailto:a@example.test)\n`[inline](docs/leave.md)`\n``[other](docs/leave.md)``\n```md\n[fenced](docs/leave.md)\n```\n~~~md\n[tilde](docs/leave.md)\n~~~\n'
  const readme = landingReadme(prose, sha, version)
  expect(readme.startsWith("**The `efferent` npm name is reserved")).toBe(true)
  expect(readme).toContain("npm install effect @xandreed/core @xandreed/sdk")
  expect(readme).toContain("[current project README](https://github.com/xandreeddev/efferent/blob/main/README.md)")
  expect(readme).toContain(`[Guide with \`code\`](https://github.com/xandreeddev/efferent/blob/${sha}/docs/framework.md#tools)`)
  for (const untouched of ["[Anchor](#install)", "[Web](https://example.test/doc)", "[Mail](mailto:a@example.test)", "`[inline](docs/leave.md)`", "``[other](docs/leave.md)``", "[fenced](docs/leave.md)", "[tilde](docs/leave.md)"]) expect(readme).toContain(untouched)
  expect(() => landingReadme(prose, "main", version)).toThrow()
})

test("actual npm pack is deterministic and contains exactly the documentation files", () => fixture(async (root) => {
  await writeFile(join(root, "user.npmrc"), "")
  await writeFile(join(root, "global.npmrc"), "")
  const run: LandingCommand = (command, cwd, env) => command[0] === "git" ? git(command, cwd, env) : landingCommand(command, cwd, { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key))), NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"), NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_CACHE: join(root, ".artifacts/npm-cache") })
  const first = await packNpmLanding(root, run)
  const bytes = await readFile(first.tarball)
  const second = await packNpmLanding(root, run)
  expect((await readdir(first.directory)).sort(Order.String)).toEqual(["LICENSE", "README.md", "package.json"])
  expect(second.integrity).toBe(first.integrity)
  expect(await readFile(second.tarball)).toEqual(bytes)
  expect(await readFile(join(first.directory, "README.md"), "utf8")).toContain(`/blob/${sha}/docs/framework.md#tools`)
}), 20000)

interface Scenario {
  readonly token?: string
  readonly account?: string
  readonly dirty?: boolean
  readonly coreSha?: string
  readonly existing?: "exact" | "wrong-sha" | "wrong-integrity"
  readonly latest?: string
  readonly uploadCode?: number
  readonly confirmed?: "exact" | "wrong-sha" | "wrong-integrity" | "missing"
  readonly extraFile?: boolean
}
const scenario = (root: string, options: Scenario = {}) => {
  const calls: Array<{ command: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = []
  const bytes = Buffer.from("deterministic mocked documentation tarball")
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  let uploaded = false
  const run: LandingCommand = async (command, cwd, env) => {
    calls.push({ command, env })
    if (command[0] === "git") return command[1] === "rev-parse" ? reply(sha) : reply(options.dirty ? " M README.md" : "")
    if (command[1] === "whoami") return reply(options.account ?? "xandreed")
    if (command[1] === "pack") {
      const archive = join(root, ".artifacts/npm-landing-pack", `efferent-${version}.tgz`)
      await writeFile(archive, bytes)
      return reply(JSON.stringify([{ name: "efferent", version, filename: `efferent-${version}.tgz`, integrity, files: ["LICENSE", "README.md", "package.json", ...(options.extraFile ? ["index.js"] : [])].map((path) => ({ path })) }]))
    }
    if (command[1] === "publish") {
      // Model npm's certificate check: a forged provenance commit is rejected before the upload is accepted.
      if (env.GITHUB_SHA !== workflowSha) return reply("", 1, "npm E422: gitCommit does not match signed SourceRepositoryDigest")
      uploaded = true
      return reply("", options.uploadCode ?? 0, "npm fixture: trust owner or workflow was refused")
    }
    throw new Error(`Unexpected fixture command: ${command.join(" ")}`)
  }
  const metadata = (kind: "exact" | "wrong-sha" | "wrong-integrity") => ({ name: "efferent", version, gitHead: kind === "wrong-sha" ? workflowSha : sha, dist: { integrity: kind === "wrong-integrity" ? "sha512-other" : integrity } })
  const fetcher = async (url: string) => {
    if (url.includes("%2fcore/")) return Response.json({ name: "@xandreed/core", version, gitHead: options.coreSha ?? sha })
    if (url.includes("/efferent/latest")) return Response.json({ name: "efferent", version: options.latest ?? "0.6.1" })
    if (!uploaded) return options.existing ? Response.json(metadata(options.existing)) : new Response("", { status: 404 })
    return options.confirmed === "missing" ? new Response("", { status: 404 }) : Response.json(metadata(options.confirmed ?? "exact"))
  }
  const env = { ...ci, ...(options.token === undefined ? {} : { NODE_AUTH_TOKEN: options.token }) }
  return { calls, run, env, fetch: fetcher, sleep: async () => {}, confirmation: { attempts: 2, intervalMs: 0 } }
}

test("the default path packs without registry calls or upload", () => fixture(async (root) => {
  const setup = scenario(root)
  const result = await publishNpmLanding({ root, live: false, ci: false }, { ...setup, fetch: async () => { throw new Error("must not query npm") } })
  expect(result.published).toBe(false)
  expect(setup.calls.some(({ command }) => command[1] === "publish")).toBe(false)
}))

test("live publication rejects local use, bad authentication, wrong account and dirty source before upload", () => fixture(async (root) => {
  await expect(publishNpmLanding({ root, live: true, ci: false }, scenario(root))).rejects.toThrow("local live publication")
  await expect(publishNpmLanding({ root, live: true, ci: true }, { ...scenario(root), env: {} })).rejects.toThrow("GitHub Actions")
  for (const options of [{ token: "fixture-token", account: "other" }, { dirty: true }]) {
    const setup = scenario(root, options)
    await expect(publishNpmLanding({ root, live: true, ci: true }, setup)).rejects.toThrow()
    expect(setup.calls.some(({ command }) => command[1] === "publish")).toBe(false)
  }
}))

test("wrong core provenance, extra packed files and backwards latest tags refuse upload", () => fixture(async (root) => {
  for (const options of [{ coreSha: workflowSha }, { extraFile: true }, { latest: "0.17.0" }]) {
    const setup = scenario(root, options)
    await expect(publishNpmLanding({ root, live: true, ci: true }, setup)).rejects.toThrow()
    expect(setup.calls.some(({ command }) => command[1] === "publish")).toBe(false)
  }
}))

test("existing versions skip only when source SHA and actual tarball integrity both match", () => fixture(async (root) => {
  const setup = scenario(root, { existing: "exact" })
  expect((await publishNpmLanding({ root, live: true, ci: true }, setup)).skipped).toBe(true)
  expect(setup.calls.some(({ command }) => command[1] === "publish")).toBe(false)
  for (const existing of ["wrong-sha", "wrong-integrity"] as const) await expect(publishNpmLanding({ root, live: true, ci: true }, scenario(root, { existing }))).rejects.toThrow("different provenance or tarball integrity")
}))

test("upload preserves the signing workflow SHA and source gitHead while confirming an ambiguous failure", () => fixture(async (root) => {
  const setup = scenario(root, { uploadCode: 1, confirmed: "exact" })
  const result = await publishNpmLanding({ root, live: true, ci: true }, setup)
  expect(result.published).toBe(true)
  const upload = setup.calls.find(({ command }) => command[1] === "publish")!
  expect(upload.command).toEqual(["npm", "publish", result.tarball, "--provenance", "--access", "public", "--tag", "latest", "--registry", "https://registry.npmjs.org", "--ignore-scripts"])
  expect(upload.env.GITHUB_SHA).toBe(workflowSha)
  expect(setup.env.GITHUB_SHA).toBe(workflowSha)
  const artifact = decodeLandingJson(Schema.Struct({ gitHead: Schema.String }), await readFile(join(result.directory, "package.json"), "utf8"))
  expect(artifact.gitHead).toBe(sha)
}))

test("a 200 response with another SHA or integrity is never treated as a successful upload", () => fixture(async (root) => {
  for (const confirmed of ["wrong-sha", "wrong-integrity", "missing"] as const) await expect(publishNpmLanding({ root, live: true, ci: true }, scenario(root, { confirmed }))).rejects.toThrow()
}))

test("argument parsing is explicit and rejects duplicate or unknown live options", () => {
  expect(landingArguments(["--root", "/tmp/source", "--ci", "--publish"], true)).toEqual({ root: "/tmp/source", live: true, ci: true })
  expect(() => landingArguments(["--publish"], false)).toThrow()
  expect(() => landingArguments(["--root", "--ci"], true)).toThrow()
  expect(() => landingArguments(["--ci", "--ci"], true)).toThrow()
})
