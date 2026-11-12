import { expect, test } from "bun:test"
import { builtinModules } from "node:module"
import { Array as Arr, Order } from "effect"

/*
 * The kernel runs in a browser without shims. The bundler is asked to build
 * its entry for a browser, and every module specifier it resolves on the
 * way is recorded: none may name a runtime module, whether it is written
 * `node:fs`, `bun:sqlite` or bare (`fs`, `path`). The bundle's text is not
 * searched, since a bundler rewrites what it cannot resolve. The AI library
 * arrives through its barrel, so this covers what that pulls in.
 */

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
/** Whether a specifier names a module only a runtime has. */
const isRuntimeModule = (specifier: string) =>
  specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun" || builtins.has(specifier) || builtins.has(specifier.split("/")[0] ?? specifier)

/** Build an entry for a browser; what failed, how much came out, and the runtime modules its graph asked for, with who asked. */
const bundle = async (entry: string) => {
  const asked: Array<string> = []
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    throw: false,
    plugins: [{
      name: "record-specifiers",
      setup: (build) => {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (isRuntimeModule(args.path)) asked.push(`${args.path} <- ${args.importer.split("/").slice(-3).join("/")}`)
          return undefined
        })
      },
    }],
  })
  const sizes = await Promise.all(built.outputs.map((output) => output.text().then((text) => text.length)))
  return { built: built.success, size: sizes.reduce((sum, size) => sum + size, 0), asked: Arr.sort(Arr.dedupe(asked), Order.String) }
}

test("a browser bundle of @xandreed/sdk/kernel resolves no runtime module: none by a node: or bun: name, none by a bare builtin name", async () => {
  const kernel = await bundle(`${import.meta.dir}/index.ts`)
  expect(kernel.asked).toEqual([])
  expect(kernel.built).toBe(true)
  expect(kernel.size).toBeGreaterThan(1000)
}, 60_000)

test("the same check catches an entry that imports one: the kernel's entry beside node:path", async () => {
  const control = await bundle(`${import.meta.dir}/../../fixtures/kernel-node-import.ts`)
  expect(control.asked).toEqual(["node:path <- sdk/fixtures/kernel-node-import.ts"])
}, 60_000)

test("a runtime module is told by any of its names", () => {
  expect(["node:fs", "fs", "fs/promises", "node:fs/promises", "path", "bun:sqlite", "bun", "child_process"].map(isRuntimeModule)).toEqual([true, true, true, true, true, true, true, true])
  expect(["effect", "effect/ai", "./index.js", "@xandreed/core/kernel", "pathe", "buffer-like"].map(isRuntimeModule)).toEqual([false, false, false, false, false, false])
})
