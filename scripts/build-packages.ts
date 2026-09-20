import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative } from "node:path"
import solidPlugin from "@opentui/solid/bun-plugin"

// Build an isolated publish tree; development keeps source exports and workspace links.
const root = join(import.meta.dir, "..")
const output = join(root, ".artifacts/packages")
const version = "0.2.0-next.0"
const names = ["core", "runtime", "sdk", "evals", "foundry", "smith", "tui", "cli",
  "plugin-agent-loop", "plugin-context", "plugin-memory", "plugin-models", "plugin-tools-local",
  "plugin-policy-workspace", "plugin-session-sqlite", "plugin-telemetry", "plugin-mcp", "ui-agent", "surface"]
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const declarations = join(root, ".artifacts/types")
await rm(declarations, { recursive: true, force: true })
const types = Bun.spawn(["bun", "x", "tsc", "--project", "tsconfig.json", "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--outDir", declarations, "--rootDir", "packages"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (await types.exited !== 0) process.exit(1)
const require = createRequire(import.meta.url)
const transpiler = new Bun.Transpiler({ target: "bun", loader: "ts" })
await Promise.all(names.map(async (name) => {
  const source = join(root, "packages", name)
  const target = join(output, name)
  const original = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
  const files = Array.from(new Bun.Glob("src/**/*").scanSync({ cwd: source, onlyFiles: true })).filter((file) => !/\.(test|bench)\.[^.]+$/.test(file) && !file.endsWith("testing.ts"))
  await Promise.all(files.map(async (file) => {
    const destination = join(target, file.replace(/^src\//, "dist/").replace(/\.tsx?$/, ".js"))
    await mkdir(join(destination, ".."), { recursive: true })
    if (file.endsWith(".tsx")) {
      const result = await Bun.build({ entrypoints: [join(source, file)], target: "bun", external: ["*"], plugins: [solidPlugin] })
      if (!result.success) { console.error(result.logs); process.exit(1) }
      await writeFile(destination, await result.outputs[0]!.text())
    } else if (file.endsWith(".ts")) await writeFile(destination, await transpiler.transform(await readFile(join(source, file), "utf8")))
    else await cp(join(source, file), destination)
  }))
  if (name === "tui") {
    await rm(join(target, "dist"), { recursive: true, force: true })
    const bundle = await Bun.build({
      entrypoints: [join(source, "src/index.ts")],
      outdir: join(target, "dist"), target: "bun", splitting: true,
      external: ["effect", "@xandreed/*", "@opentui/core", "@opentui/core/*", "bun", "node:*"],
      plugins: [{ name: "solid-client-runtime", setup(builder) {
        builder.onResolve({ filter: /^solid-js$/ }, () => ({ path: require.resolve("solid-js/dist/solid.js") }))
        builder.onResolve({ filter: /^solid-js\/store$/ }, () => ({ path: require.resolve("solid-js/store/dist/store.js") }))
        builder.onResolve({ filter: /^solid-js\/web$/ }, () => ({ path: require.resolve("solid-js/web/dist/web.js") }))
      } }, solidPlugin],
    })
    if (!bundle.success) { console.error(bundle.logs); process.exit(1) }
    await writeFile(join(target, "dist/approval.js"), await transpiler.transform(await readFile(join(source, "src/approval.ts"), "utf8")))
  }
  await cp(join(declarations, name, "src"), join(target, "dist"), { recursive: true })
  await Promise.all(["skills", "profiles"].map(async (asset) => {
    if (await Bun.file(join(source, asset)).exists() || Array.from(new Bun.Glob(`${asset}/**/*`).scanSync({ cwd: source })).length > 0) await cp(join(source, asset), join(target, asset), { recursive: true })
  }))
  const exportTarget = (path: string) => path.endsWith(".json") ? { default: path } : ({ types: path.replace("./src/", "./dist/").replace(/\.tsx?$/, ".d.ts"), default: path.replace("./src/", "./dist/").replace(/\.tsx?$/, ".js") })
  const exports = Object.fromEntries(Object.entries(original.exports ?? { ".": "./src/index.ts" }).filter(([key]) => key !== "./tui-testing").map(([key, path]) => [key, exportTarget(String(path))]))
  if (exports["./*"]) exports["./*.js"] = exports["./*"]
  const dependencies = Object.fromEntries(Object.entries(original.dependencies ?? {}).map(([key, value]) => [key, String(value).startsWith("workspace:") ? version : value]))
  const manifest = { ...original, version, private: false, main: "./dist/index.js", types: "./dist/index.d.ts", exports, dependencies,
    files: ["dist", "skills", "profiles", "README.md", "LICENSE"], engines: { bun: ">=1.3.0" }, license: "MIT",
    ...(name === "cli" ? { bin: { efferent: "./dist/main.js" }, main: "./dist/main.js" } : {}),
  }
  delete manifest.devDependencies
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(target, "README.md"), `# ${original.name}\n\nEfferent composable agent framework, ${version}. Bun on Linux.\n\nDocumentation: https://github.com/xandreeddev/efferent\n`)
  await cp(join(root, "LICENSE"), join(target, "LICENSE"))
  console.log(`Built ${relative(root, target)}`)
}))
