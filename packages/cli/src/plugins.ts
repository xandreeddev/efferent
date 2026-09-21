import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { HarnessError } from "@xandreed/core"
import type { HarnessConfig, Plugin } from "@xandreed/core"
import { decodeConfig, loadPlugins, mergeConfig, pluginSchema, redact, resolveGraph, writeConfig } from "@xandreed/runtime"

export const managePlugin = (args: ReadonlyArray<string>, options: { readonly workspace: string; readonly home: string; readonly config: HarnessConfig; readonly plugins: ReadonlyArray<Plugin>; readonly id?: string }) => Effect.gen(function* () {
  const [command, spec] = args
  if (command === "list") { console.log(options.config.plugins?.map((entry) => `${entry.id}\t${entry.use}\t${entry.enabled === false ? "disabled" : "enabled"}`).join("\n")); return }
  const target = options.config.plugins?.find((entry) => entry.id === spec)
  if (command === "inspect" && target !== undefined) {
    const plugin = options.plugins.find((plugin) => plugin.id === target.use)
    console.log(JSON.stringify(redact({ ...target, schema: plugin === undefined ? {} : pluginSchema(plugin), requires: plugin?.requires, provides: plugin?.provides }), null, 2)); return
  }
  if ((command !== "add" && command !== "remove") || spec === undefined) return yield* Effect.fail(new HarnessError({ code: "plugin.command", message: "Use plugin add <package-or-path>, remove <id>, list, or inspect <id>" }))
  const use = spec.startsWith(".") || spec.startsWith("/") ? spec : spec.slice(0, spec.lastIndexOf("@") > 0 ? spec.lastIndexOf("@") : spec.length)
  if (command === "add" && !spec.startsWith(".") && !spec.startsWith("/")) {
    yield* Effect.tryPromise({ try: async () => {
      const directory = join(options.home, ".efferent/plugins")
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n', { flag: "wx" }).then(() => undefined, (error) => { if (error.code !== "EEXIST") return Promise.reject(error) })
      const child = Bun.spawn(["bun", "add", "--exact", "--ignore-scripts", spec], { cwd: directory, stdout: "inherit", stderr: "inherit" })
      return await child.exited
    }, catch: (error) => new HarnessError({ code: "plugin.install", message: String(error) }) }).pipe(Effect.flatMap((code) => code === 0 ? Effect.void : Effect.fail(new HarnessError({ code: "plugin.install", message: `Package installation exited ${code}` }))))
  }
  const id = command === "remove" ? spec : options.id ?? use.split("/").at(-1)?.replace(/\.(ts|js)$/, "") ?? use
  if (command === "remove" && target === undefined) return yield* Effect.fail(new HarnessError({ code: "plugin.missing", message: `No plugin instance ${id}` }))
  const patch: HarnessConfig = { version: 1, plugins: [{ id, use: target?.use ?? use, enabled: command === "add" }] }
  const next = mergeConfig(options.config, patch)
  const plugins = yield* loadPlugins(next, options.plugins, options.workspace, options.home)
  yield* resolveGraph(next, plugins, ["efferent/SessionEnvironment"])
  const path = join(options.workspace, ".efferent/overrides.json")
  const previous = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (error) => error }).pipe(
    Effect.catchAll((error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? Effect.succeed('{"version":1}') : Effect.fail(new HarnessError({ code: "config.io", message: String(error) }))),
  )
  const old = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(previous).pipe(
    Effect.mapError((error) => new HarnessError({ code: "config.invalid", message: String(error) })),
    Effect.flatMap((value) => decodeConfig(value, path)),
  )
  yield* writeConfig(path, mergeConfig(old, patch))
  console.log(`${command === "add" ? "Added" : "Disabled"} ${id}. Restart to load the new composition.`)
})
