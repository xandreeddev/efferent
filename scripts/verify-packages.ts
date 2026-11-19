import { createHash } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { apiBuildOf, apiDifferences, apiSnapshot, committedApi } from "./api-snapshot.js"
import { isTestCode, verifyRefusals } from "./build-check.js"
import { declarationImportProblems } from "./declaration-imports.js"
import type { DeclaringManifest } from "./declaration-imports.js"
import { installedCopies, PEERS } from "./distribution-manifest.js"
import { BuildStamp } from "./publish-plan.js"
const root = join(import.meta.dir, "..")
/** The consumer installs the Effect the packages were built against, and the repo's TypeScript. */
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly dependencies: { readonly effect: string }, readonly devDependencies: { readonly typescript: string } }
const packages = join(root, ".artifacts/packages")
/**
 * Only the build of HEAD is checked, so a build left over from other sources cannot pass:
 * `build.json` must record HEAD and a clean tree, and the packages must hold no test code.
 * `--allow-dirty` accepts a build of uncommitted changes, to check them before committing.
 */
const args = process.argv.slice(2)
const unknownArgs = args.filter((arg) => arg !== "--allow-dirty" && arg !== "--keep-consumer")
if (unknownArgs.length > 0) {
  console.error(`Unknown argument: ${unknownArgs.join(" ")}\nUsage: bun run verify:packages [--allow-dirty] [--keep-consumer]`)
  process.exit(2)
}
const stampFile = Bun.file(join(packages, "build.json"))
const stamp = Schema.decodeUnknownResult(Schema.fromJsonString(BuildStamp))(await stampFile.exists() ? await stampFile.text() : "")
if (Result.isFailure(stamp)) {
  console.error(`Refusing to verify: .artifacts/packages/build.json is missing or not valid; run bun run build:packages first`)
  process.exit(1)
}
const headRun = Bun.which("git") === null ? undefined : Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" })
const refusals = verifyRefusals({
  stamp: stamp.success,
  head: { success: headRun?.success ?? false, stdout: headRun?.stdout.toString().trim() ?? "", stderr: headRun?.stderr.toString().trim() ?? "" },
  testCode: Array.from(new Bun.Glob("*/dist/**/*").scanSync({ cwd: packages, onlyFiles: true })).filter((file) => isTestCode(file.split("/").slice(2).join("/"))).sort(),
  allowDirty: args.includes("--allow-dirty"),
})
if (refusals.length > 0) {
  console.error(`Refusing to verify:\n${refusals.map((reason) => `  - ${reason}`).join("\n")}`)
  process.exit(1)
}
/** What each published entry exports, read from the build's declarations, is what api/ records (scripts/api-snapshot.ts). */
const api = apiSnapshot(apiBuildOf(root, stamp.success.packages.map((entry) => entry.dir)))
const apiProblems = [...api.problems, ...(api.problems.length > 0 ? [] : apiDifferences(committedApi(join(root, "api")), api.files))]
if (apiProblems.length > 0) {
  console.error(`The public API of the build is not the one api/ records:\n${apiProblems.map((problem) => `  - ${problem}`).join("\n")}\nRun bun run api:update and commit api/ with the change.`)
  process.exit(1)
}
console.log(`The public API of the build matches api/ (${api.files.size} entries)`)
/** A built package's declarations name only itself, what its manifest declares and the runtime's modules (scripts/declaration-imports.ts). */
const declarationProblems = (await Promise.all(stamp.success.packages.map(async ({ dir }) => {
  const manifest = JSON.parse(await readFile(join(packages, dir, "package.json"), "utf8")) as DeclaringManifest
  const files = Array.from(new Bun.Glob("dist/**/*.d.ts").scanSync({ cwd: join(packages, dir) })).sort()
  return declarationImportProblems(manifest, await Promise.all(files.map(async (file) => ({ path: `${dir}/${file}`, text: await readFile(join(packages, dir, file), "utf8") }))))
}))).flat()
if (declarationProblems.length > 0) {
  console.error(`The built declarations import packages their manifests do not declare:\n${declarationProblems.map((problem) => `  - ${problem}`).join("\n")}\nName the type through the package's own module (an import in the source file that emits it).`)
  process.exit(1)
}
console.log(`The built declarations of ${stamp.success.packages.length} packages import only what their manifests declare`)
const tarballs = join(root, ".artifacts/tarballs")
await mkdir(tarballs, { recursive: true })
const manifests = Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: packages }))
const artifacts = await Promise.all(manifests.map(async (file) => {
  const path = join(packages, file)
  const manifest = JSON.parse(await readFile(path, "utf8"))
  const child = Bun.spawn(["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", tarballs], { cwd: join(path, ".."), stdout: "pipe", stderr: "inherit", env: { ...process.env, npm_config_cache: join(root, ".artifacts/npm-cache") } })
  const filename = (await new Response(child.stdout).text()).trim()
  if (await child.exited !== 0) process.exit(1)
  const tarballPath = join(tarballs, filename)
  const shasum = createHash("sha1").update(await readFile(tarballPath)).digest("hex")
  return { manifest, file: tarballPath, shasum }
}))
const consumer = await mkdtemp(join(tmpdir(), "efferent-consumer-"))
if (!args.includes("--keep-consumer")) process.once("exit", () => rmSync(consumer, { recursive: true, force: true }))
/** Each fixture owns its scenario assertions; the launcher owns its process and deadline. */
interface PackedFixture {
  readonly file: string
  readonly marker: string
  readonly required: ReadonlyArray<string>
  readonly timeoutMs?: number
}
const runPackedFixture = async (fixture: PackedFixture) => {
  const file = fixture.file.replace(".fixture.mjs", ".mjs")
  await writeFile(join(consumer, file), await readFile(join(root, "scripts", fixture.file), "utf8"))
  for (const [binary, runtime] of [["node", "Node"], ["bun", "Bun"]] as const) {
    const child = Bun.spawn([binary, file], { cwd: consumer, stdout: "pipe", stderr: "inherit", timeout: fixture.timeoutMs ?? 120_000 })
    const [report, code] = await Promise.all([new Response(child.stdout).text(), child.exited]).finally(() => child.kill())
    if (code !== 0 || !report.includes(`${fixture.marker} {"runtime":"${runtime}`) || fixture.required.some((name) => !report.includes(`"${name}":true`))) {
      console.error(`the packed ${runtime} ${fixture.marker} fixture failed its required evidence`)
      process.exit(1)
    }
    console.log(report.trim())
  }
}
const registry: Bun.Server<undefined> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  const path = decodeURIComponent(new URL(request.url).pathname).slice(1)
  const artifact = artifacts.find((entry) => entry.manifest.name === path || `${entry.manifest.name}/artifact.tgz` === path)
  if (artifact === undefined) return new Response("Unknown local package", { status: 404 })
  if (path.endsWith("artifact.tgz")) return new Response(Bun.file(artifact.file))
  const { manifest } = artifact
  return Response.json({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { shasum: artifact.shasum, tarball: `http://127.0.0.1:${registry.port}/${manifest.name}/artifact.tgz` } } } })
} })
await writeFile(join(consumer, "bunfig.toml"), `[install.scopes]\n"@xandreed" = { url = "http://127.0.0.1:${registry.port}" }\n`)
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { ...Object.fromEntries(artifacts.map(({manifest}) => [manifest.name,manifest.version])), effect: rootManifest.dependencies.effect, typescript: rootManifest.devDependencies.typescript, "@types/bun": "1.3.14" } }))
console.log(`Installing from temporary local registry into ${consumer}`)
const install = Bun.spawn(["bun", "install", "--ignore-scripts", "--no-cache", "--cache-dir", join(consumer, ".install-cache")], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await install.exited !== 0) process.exit(1)
/** The consumer holds one copy of each package the framework shares with its host: two would split their classes and services. */
const copies = Array.from(installedCopies(join(consumer, "node_modules"), PEERS)).filter(([, found]) => found.length !== 1)
if (copies.length > 0) {
  console.error(`The consumer did not install one copy of each shared package:\n${copies.map(([name, found]) => `  - ${name}: ${found.length === 0 ? "none" : found.map((dir) => relative(consumer, dir)).join(", ")}`).join("\n")}`)
  process.exit(1)
}
console.log(`The consumer installed one copy each of ${PEERS.join(" and ")}`)
registry.stop(true)
/**
 * The documentation's imports must exist in the packed packages: every
 * `@xandreed/*` import in a TypeScript or JavaScript code block of the
 * README, the guides and the website docs becomes one import in
 * `doc-imports.ts`, which the consumer typecheck compiles. A renamed or
 * removed export, or a subpath a package does not export, fails here.
 */
const websiteDocs = join(root, "packages/website/src/content/docs")
const documented = [
  ...["README.md", "docs/composable-evaluations.md", "docs/kernel.md"].map((file) => join(root, file)).filter((file) => existsSync(file)),
  ...(await readdir(websiteDocs, { recursive: true })).filter((file) => /\.mdx?$/.test(file)).sort().map((file) => join(websiteDocs, file)),
]
const docImports = (await Promise.all(documented.map(async (file) => {
  const text = await readFile(file, "utf8")
  const blocks = Array.from(text.matchAll(/^```(?:ts|typescript|tsx|mts|js|javascript|mjs)\b[^\n]*\n([\s\S]*?)^```/gm))
  const statement = /import\s+(type\s+)?((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']/g
  return blocks.flatMap((block) => Array.from((block[1] ?? "").matchAll(statement)).filter((found) => (found[3] ?? "").startsWith("@xandreed/")).map((found) => ({
    where: `${relative(root, file)}:${text.slice(0, (block.index ?? 0) + (block[0].indexOf(found[0]))).split("\n").length}`,
    typeOnly: found[1] !== undefined,
    clause: found[2] ?? "",
    from: found[3] ?? "",
  })))
}))).flat()
const aliased = docImports.flatMap((entry, index) => {
  const named = /\{([^}]*)\}/.exec(entry.clause)
  const namespace = /\*\s+as\s+[A-Za-z_$][\w$]*/.test(entry.clause)
  const defaulted = /^\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(entry.clause)
  const names = (named?.[1] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0).map((part) => {
    const typeOnly = part.startsWith("type ")
    return { typeOnly, name: (typeOnly ? part.slice(5) : part).split(/\s+as\s+/)[0]?.trim() ?? "" }
  })
  const keyword = entry.typeOnly ? "import type" : "import"
  return [
    `// ${entry.where}`,
    ...names.map((item, position) => `${keyword} { ${item.typeOnly ? "type " : ""}${item.name} as doc${index}_${position} } from ${JSON.stringify(entry.from)}`),
    ...(namespace ? [`${keyword} * as doc${index}_ns from ${JSON.stringify(entry.from)}`] : []),
    ...(defaulted ? [`${keyword} doc${index}_default from ${JSON.stringify(entry.from)}`] : []),
  ]
})
await writeFile(join(consumer, "doc-imports.ts"), `// Every @xandreed import of the documentation, as written there (scripts/verify-packages.ts).\n${aliased.join("\n")}\nexport {}\n`)
console.log(`Checking ${docImports.length} documented imports from ${documented.length} files`)
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: ["bun"] }, include: ["doc-imports.ts"] }))
const typecheck = Bun.spawn(["bun", "node_modules/typescript/bin/tsc", "--noEmit"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await typecheck.exited !== 0) process.exit(1)
// Every entry of every package loads on Bun, and on Node when the package declares Node: a Bun-only import fails
// here, not in a consumer's deploy. On Node a file no entry names stays out of reach: a deep import of a file core
// publishes is refused.
const entriesOf = (only: (manifest: { readonly engines?: { readonly node?: string } }) => boolean) => artifacts.filter(({ manifest }) => only(manifest)).flatMap(({ manifest }) =>
  Object.keys(manifest.exports ?? { ".": "" }).filter((key) => !key.includes("*")).map((key) => key === "." ? String(manifest.name) : `${manifest.name}/${key.slice(2)}`))
const entryImports = (entries: ReadonlyArray<string>, runtime: string) => entries.map((name) => `await import(${JSON.stringify(name)})`).join("\n") + `
console.log("${entries.length} published entries load on ${runtime}")
`
await writeFile(join(consumer, "bun-imports.mjs"), entryImports(entriesOf(() => true), "Bun"))
const bunImports = Bun.spawn(["bun", "bun-imports.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await bunImports.exited !== 0) process.exit(1)
if (Bun.which("node") !== null) {
  if (!existsSync(join(consumer, "node_modules/@xandreed/core/dist/kernel/ids.entity.js"))) { console.error("The packed core holds no dist/kernel/ids.entity.js to try a deep import of"); process.exit(1) }
  await writeFile(join(consumer, "node-imports.mjs"), entryImports(entriesOf((manifest) => manifest.engines?.node !== undefined), "Node") + `
const deepImport = await import("@xandreed/core/dist/kernel/ids.entity.js").then(() => "loaded", (error) => error.code)
if (deepImport !== "ERR_PACKAGE_PATH_NOT_EXPORTED") { console.error("A deep import of @xandreed/core was not refused: " + deepImport); process.exit(1) }
console.log("core refuses a deep import on Node")
`)
  const nodeImports = Bun.spawn(["node", "node-imports.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await nodeImports.exited !== 0) process.exit(1)
} else console.log("node not on PATH: skipped the Node import check")
const protocolFixtures: ReadonlyArray<PackedFixture> = [
  // The kernel's three entries: the three contracts' kits on the stock plugins (the memory kit on both memories), the files, search and shell kits over the Node entry's workspace ports (a folder of the disk and a process shell), one turn of a host's own over a stack of layers on the scripted model, two messages queued with the inbox running that turn, a host's turn with tools (Effect AI's Toolkit, each call stored with its result), the storage and sessions kits over the Node entry's two durable journals (SQLite over this runtime's driver), a process killed inside a turn on each, recovered by the next, a consumer's own contract composed as a layer, and a host's turn with a tool call exported over OTLP to a local collector.
  { file: "kernel-consumer.fixture.mjs", marker: "kernel", required: ["storageKit", "sessionsKit", "memoryKit", "hostTurn", "inboxQueued", "toolTurn", "storeOutlives", "durableKits", "crashRecovered", "layersComposed", "workspaceKits", "exportedTurn"] },
]
for (const fixture of protocolFixtures) await runPackedFixture(fixture)
// The evaluation packages through the packed public API on Node.
await writeFile(join(consumer, "evaluation-consumer.mjs"), await readFile(join(root, "scripts/evaluation-consumer.fixture.mjs"), "utf8"))
const evalNode = Bun.spawn(["node", "evaluation-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await evalNode.exited !== 0) process.exit(1)
// The installed bin runs as a command, which needs the shebang the build keeps.
const evalBin = Bun.spawn([join(consumer, "node_modules/.bin/efferent-eval"), "--help"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const evalHelp = await new Response(evalBin.stdout).text()
if (await evalBin.exited !== 0 || !evalHelp.startsWith("efferent-eval ")) { console.error("The efferent-eval bin did not run as a command"); process.exit(1) }
console.log("The efferent-eval bin runs as a command")
console.log(args.includes("--keep-consumer") ? `Packed consumer verified at ${consumer}` : "Packed consumer verified; temporary installation removed on exit")
