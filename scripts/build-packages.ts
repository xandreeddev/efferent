import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

// Build an isolated publish tree; development keeps source exports and workspace links.
const root = join(import.meta.dir, "..")
const output = join(root, ".artifacts/packages")
const names = ["core", "runtime", "sdk", "evals", "evals-cli", "evals-langfuse", "evals-langsmith",
  "plugin-agent-loop", "plugin-memory-window", "plugin-memory-summary", "plugin-memory-digest", "plugin-tool-discovery", "plugin-models",
  "plugin-session-sqlite", "plugin-sessions", "plugin-tasks", "plugin-render", "plugin-workspace", "plugin-telemetry"]
const manifests = new Map(await Promise.all(names.map(async (name) =>
  [name, JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"))] as const,
)))
/** Each package declares the runtimes it supports; the published manifest keeps that declaration. */
const undeclared = names.filter((name) => manifests.get(name)?.engines === undefined)
if (undeclared.length > 0) { console.error(`Declare "engines" in the package.json of: ${undeclared.join(", ")}`); process.exit(1) }
/** The runtimes a packed README names, from the declared `engines` (`>=24.5` reads as Node 24.5). */
const runtimeNote = (engines: { readonly node?: string, readonly bun?: string }) => {
  const node = engines.node === undefined ? undefined : `Node ${engines.node.replace(/^>=\s*/, "")}`
  return node !== undefined && engines.bun !== undefined ? `${node} or Bun.` : node !== undefined ? `${node}.` : "Bun only."
}
const versions = new Map(Array.from(manifests.values(), (manifest) => [manifest.name, manifest.version]))
/**
 * The build stamp the publish script checks: the commit the sources came from, whether the
 * working tree had changes, and the one version every package shares. Changes are tracked and
 * untracked files anywhere, plus gitignored files in the folders a package publishes from
 * (`src`, `skills`, `profiles`), since the build copies those too. Read before building, so it
 * describes the sources the build read. Without git the build is stamped dirty with no commit,
 * which publish refuses.
 */
const git = (args: ReadonlyArray<string>) => {
  if (Bun.which("git") === null) return { success: false, text: "" }
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" })
  return { success: result.success, text: result.stdout.toString().trim() }
}
const head = git(["rev-parse", "HEAD"])
const status = git(["status", "--porcelain"])
const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--",
  ...names.flatMap((name) => ["src", "skills", "profiles"].map((folder) => `packages/${name}/${folder}`))])
if (ignored.text.length > 0) console.warn(`Ignored files in published folders mark this build dirty:\n${ignored.text}`)
const shared = new Set(versions.values())
if (shared.size !== 1) console.warn(`Packages do not share one version (${Array.from(versions, ([name, version]) => `${name}@${version}`).join(", ")}); publish will refuse this build.`)
const stamp = {
  commit: head.success ? head.text : null,
  dirty: !status.success || status.text.length > 0 || !ignored.success || ignored.text.length > 0,
  version: shared.size === 1 ? Array.from(shared)[0] : null,
  packages: names.map((dir) => ({ dir, name: manifests.get(dir)!.name, version: manifests.get(dir)!.version })),
}
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const declarations = join(root, ".artifacts/types")
await rm(declarations, { recursive: true, force: true })
const types = Bun.spawn(["bun", "x", "tsc", "--project", "tsconfig.json", "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--outDir", declarations, "--rootDir", "packages"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (await types.exited !== 0) process.exit(1)
const transpiler = new Bun.Transpiler({ target: "bun", loader: "ts" })
await Promise.all(names.map(async (name) => {
  const source = join(root, "packages", name)
  const target = join(output, name)
  const original = manifests.get(name)!
  const version = original.version
  const files = Array.from(new Bun.Glob("src/**/*").scanSync({ cwd: source, onlyFiles: true })).filter((file) => !/\.(test|bench)\.[^.]+$/.test(file) && !file.endsWith("testing.ts"))
  await Promise.all(files.map(async (file) => {
    const destination = join(target, file.replace(/^src\//, "dist/").replace(/\.tsx?$/, ".js"))
    await mkdir(join(destination, ".."), { recursive: true })
    // The transpiler drops a leading `#!` line, which a `bin` entry (efferent-eval) needs to run as a command.
    const code = file.endsWith(".ts") ? await readFile(join(source, file), "utf8") : ""
    const shebang = code.startsWith("#!") ? `${code.split("\n", 1)[0]}\n` : ""
    if (file.endsWith(".ts")) await writeFile(destination, shebang + await transpiler.transform(code))
    else await cp(join(source, file), destination)
  }))
  await cp(join(declarations, name, "src"), join(target, "dist"), { recursive: true })
  await Promise.all(["skills", "profiles"].map(async (asset) => {
    if (await Bun.file(join(source, asset)).exists() || Array.from(new Bun.Glob(`${asset}/**/*`).scanSync({ cwd: source })).length > 0) await cp(join(source, asset), join(target, asset), { recursive: true })
  }))
  const exportTarget = (path: string) => path.endsWith(".json") ? { default: path } : ({ types: path.replace("./src/", "./dist/").replace(/\.tsx?$/, ".d.ts"), default: path.replace("./src/", "./dist/").replace(/\.tsx?$/, ".js") })
  const exports = Object.fromEntries(Object.entries(original.exports ?? { ".": "./src/index.ts" }).filter(([key]) => key !== "./tui-testing").map(([key, path]) => [key, exportTarget(String(path))]))
  if (exports["./*"]) exports["./*.js"] = exports["./*"]
  const missing = Object.entries(original.dependencies ?? {}).filter(([key, value]) => String(value).startsWith("workspace:") && !versions.has(key))
  if (missing.length > 0) { console.error(`Missing distribution dependencies for ${original.name}: ${missing.map(([key]) => key).join(", ")}`); process.exit(1) }
  const dependencies = Object.fromEntries(Object.entries(original.dependencies ?? {}).map(([key, value]) => [key, String(value).startsWith("workspace:") ? versions.get(key) : value]))
  const manifest = { ...original, version, private: false, main: "./dist/index.js", types: "./dist/index.d.ts", exports, dependencies,
    files: ["dist", "skills", "profiles", "README.md", "LICENSE"], license: "MIT",
    ...(name === "evals-cli" ? { bin: { "efferent-eval": "dist/main.js" } } : {}),
  }
  delete manifest.devDependencies
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(target, "README.md"), `# ${original.name}\n\nEfferent composable agent framework, ${version}. ${runtimeNote(original.engines)}\n\nDocumentation: https://github.com/xandreeddev/efferent\n`)
  await cp(join(root, "LICENSE"), join(target, "LICENSE"))
  console.log(`Built ${relative(root, target)}`)
}))
// Written last: a failed build leaves no stamp, so it cannot be published.
await writeFile(join(output, "build.json"), `${JSON.stringify(stamp, null, 2)}\n`)
console.log(`Stamped ${relative(root, join(output, "build.json"))}: ${stamp.version ?? "mixed versions"} at ${stamp.commit ?? "no commit"}${stamp.dirty ? " (dirty tree)" : ""}`)
