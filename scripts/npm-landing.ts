#!/usr/bin/env bun
/** Build and pack the reserved, documentation-only npm name independently of framework packages. */
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Order, Result, Schema } from "effect"

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const landingVersion = (version: string) => versionPattern.test(version) && version.split(".").every((part) => Number.isSafeInteger(Number(part)))
export const decodeLandingJson = <A, I>(schema: Schema.Codec<A, I>, text: string): A => Result.match(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text), {
  onSuccess: (value) => value, onFailure: () => { throw new Error("Invalid npm landing metadata") },
})
export interface LandingCommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type LandingCommand = (command: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv) => Promise<LandingCommandResult>
export const landingCommand: LandingCommand = async (command, cwd, env) => {
  // Bun 1.3.0 can lose both asynchronous pipe streams after a fast child exits.
  const child = Bun.spawnSync([...command], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000 })
  return { code: child.success ? 0 : child.exitCode || 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}
export interface LandingSource { readonly root: string; readonly sha: string; readonly version: string }
export const landingSource = async (root: string, run: LandingCommand = landingCommand, env: NodeJS.ProcessEnv = process.env): Promise<LandingSource> => {
  const source = resolve(root)
  const head = await run(["git", "rev-parse", "HEAD"], source, env)
  if (head.code !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw new Error("The landing source must have an exact git HEAD")
  const status = await run(["git", "status", "--porcelain", "--untracked-files=all"], source, env)
  if (status.code !== 0 || status.stdout.trim()) throw new Error("The landing source must be a clean checkout")
  const core = decodeLandingJson(Schema.Struct({ name: Schema.Literal("@xandreed/core"), version: Schema.String }), await readFile(join(source, "packages/core/package.json"), "utf8"))
  if (!landingVersion(core.version)) throw new Error("The landing source needs a stable framework version")
  return { root: source, sha: head.stdout.trim(), version: core.version }
}

/** Like the guide synchronizer, rewrite prose links while preserving fenced and inline code. */
export const landingReadme = (readme: string, sha: string, version: string): string => {
  if (!/^[a-f0-9]{40}$/.test(sha) || !landingVersion(version)) throw new Error("Invalid landing source identity")
  const target = (href: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href) ? href : `https://github.com/xandreeddev/efferent/blob/${sha}/${href.replace(/^\.\//, "").replace(/^\//, "")}`
  const rewrite = (text: string) => text.replace(/(`+)([\s\S]*?)\1|(?<!!)\[((?:[^\]`]|`[^`\n]*`)*)\]\(([^)\s]+)\)/g,
    (whole: string, code: string | undefined, _body: string, label: string, href: string) => code === undefined ? `[${label}](${target(href)})` : whole)
  const lines = readme.split(/(?<=\n)/)
  const pieces: string[] = []
  const prose: string[] = []
  let fence: { readonly character: string; readonly length: number } | undefined
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line)
    if (fence) {
      pieces.push(line)
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
    } else if (marker) {
      pieces.push(rewrite(prose.join("")), line)
      prose.length = 0
      fence = { character: marker[1]![0]!, length: marker[1]!.length }
    } else prose.push(line)
  }
  pieces.push(rewrite(prose.join("")))
  return `**The \`efferent\` npm name is reserved for the Efferent framework.**\n\nThis package contains documentation only. Install the maintained framework through its scoped packages:\n\n\`\`\`sh\nnpm install effect @xandreed/core @xandreed/sdk\n\`\`\`\n\nThe historical \`efferent\` CLI is no longer shipped by this package. The framework README below comes from version ${version}, source [${sha.slice(0, 11)}](https://github.com/xandreeddev/efferent/tree/${sha}). See the [current project README](https://github.com/xandreeddev/efferent/blob/main/README.md) for ongoing changes.\n\n---\n\n${pieces.join("")}`
}
export const landingManifest = ({ sha, version }: LandingSource) => ({
  name: "efferent", version,
  description: "Reserved Efferent framework name and documentation. Install the maintained @xandreed/* packages.",
  license: "MIT", gitHead: sha,
  repository: { type: "git", url: "git+https://github.com/xandreeddev/efferent.git" },
  homepage: "https://xandreeddev.github.io/efferent/", files: ["README.md", "LICENSE"],
})
const Packed = Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String, filename: Schema.String, integrity: Schema.String, files: Schema.Array(Schema.Struct({ path: Schema.String })) }))
export interface LandingPack extends LandingSource { readonly directory: string; readonly tarball: string; readonly integrity: string }
export const packNpmLanding = async (root: string, run: LandingCommand = landingCommand, env: NodeJS.ProcessEnv = process.env): Promise<LandingPack> => {
  const source = await landingSource(root, run, env)
  const directory = join(source.root, ".artifacts/npm-landing")
  const archives = join(source.root, ".artifacts/npm-landing-pack")
  const readme = landingReadme(await readFile(join(source.root, "README.md"), "utf8"), source.sha, source.version)
  const license = await readFile(join(source.root, "LICENSE"), "utf8")
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await mkdir(archives, { recursive: true })
  await writeFile(join(directory, "package.json"), `${JSON.stringify(landingManifest(source), null, 2)}\n`, { mode: 0o644 })
  await writeFile(join(directory, "README.md"), readme, { mode: 0o644 })
  await writeFile(join(directory, "LICENSE"), license, { mode: 0o644 })
  const result = await run(["npm", "pack", directory, "--json", "--ignore-scripts", "--pack-destination", archives], source.root, env)
  if (result.code !== 0) throw new Error(`npm pack failed for the documentation landing package: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 8000)}`)
  const records = decodeLandingJson(Packed, result.stdout)
  const packed = records[0]
  const paths = packed?.files.map((file) => file.path).sort(Order.String) ?? []
  if (records.length !== 1 || !packed || packed.name !== "efferent" || packed.version !== source.version || basename(packed.filename) !== packed.filename || packed.filename !== `efferent-${source.version}.tgz` || JSON.stringify(paths) !== JSON.stringify(["LICENSE", "README.md", "package.json"])) throw new Error("The landing archive must contain exactly package.json, README.md and LICENSE")
  const tarball = join(archives, packed.filename)
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`
  if (packed.integrity !== integrity) throw new Error("The npm pack integrity does not match the landing tarball")
  return { ...source, directory, tarball, integrity }
}
export const landingArguments = (args: ReadonlyArray<string>, publisher: boolean) => {
  let root = resolve(import.meta.dir, "..")
  let selected = false
  let live = false
  let ci = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--root" && !selected && args[index + 1] && !args[index + 1]!.startsWith("--")) { root = resolve(args[++index]!); selected = true }
    else if (publisher && arg === "--publish" && !live) live = true
    else if (publisher && arg === "--ci" && !ci) ci = true
    else throw new Error("Usage: npm landing [--root <source-checkout>] [--ci --publish]")
  }
  return { root, live, ci }
}
if (import.meta.main) {
  try { const { root } = landingArguments(process.argv.slice(2), false); console.log(JSON.stringify(await packNpmLanding(root), null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : "Landing packaging failed"); process.exit(1) }
}
