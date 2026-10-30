import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { apiDifferences, apiSnapshot } from "./api-snapshot.js"

/** A build of its own: built manifests and published files, emitted declarations, and a source tree with a package-local dependency. */
const root = mkdtempSync(join(tmpdir(), "efferent-api-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
const manifest = (dir: string, exports: Record<string, { readonly types?: string; readonly default?: string }>) =>
  write(`packages/${dir}/package.json`, JSON.stringify({ name: `@xandreed/${dir}`, exports }))
const build = (dirs: ReadonlyArray<string>) => ({ packages: join(root, "packages"), types: join(root, "types"), sources: join(root, "sources"), dirs })

manifest("demo", { ".": { types: "./dist/index.d.ts" }, "./extra": { types: "./dist/extra.d.ts" }, "./data.json": { default: "./dist/data.json" } })
write("types/demo/src/index.d.ts", [
  `export { Service, Schema, Level } from "./model.entity.js";`,
  `export type { Service as ServiceType, Schema as SchemaType, Level as LevelType } from "./model.entity.js";`,
  `import type { Shape } from "./model.entity.js";`,
  `export { Shape as ShapeAlias };`,
  `export declare function run(): void;`,
  `export declare let counter: number;`,
  `export * as Tools from "./tools.js";`,
  `export { external } from "ext";`,
  `declare const plugin: { readonly id: string };`,
  `export default plugin;`,
].join("\n"))
write("types/demo/src/model.entity.d.ts", [
  `export declare class Service { readonly id: string }`,
  `export declare const Schema: { readonly Type: { readonly a: number } };`,
  `export type Schema = typeof Schema.Type;`,
  `export declare enum Level { Low = 0 }`,
  `export interface Shape { readonly a: number }`,
].join("\n"))
write("types/demo/src/tools.d.ts", `export declare const tool: string;\n`)
write("types/demo/src/extra.d.ts", `export { parse } from "./internal/json.js";\n`)
write("types/demo/src/internal/json.d.ts", `export declare const parse: (text: string) => unknown;\n`)
write("types/demo/src/engine/run.d.ts", `export declare const start: () => void;\n`)
// Installed beside the sources only, as a package's own dependencies are.
write("sources/demo/node_modules/ext/package.json", JSON.stringify({ name: "ext", types: "index.d.ts" }))
write("sources/demo/node_modules/ext/index.d.ts", `export declare const external: number;\n`)

manifest("cli", { ".": { types: "./dist/index.d.ts" }, "./*": { types: "./dist/*.d.ts" }, "./*.js": { types: "./dist/*.d.ts" } })
const cliModules = { "index.d.ts": `export declare const cli: string;\n`, "run.adapter.d.ts": `export declare const runMain: () => void;\n`, "adapters/store.adapter.d.ts": `export declare class Store {}\n` }
Object.entries(cliModules).forEach(([file, text]) => {
  write(`packages/cli/dist/${file}`, text)
  write(`types/cli/src/${file}`, text)
})

describe("the API snapshot", () => {
  test("lists each published entry's exports as sorted kind-name lines, a wildcard's modules each once", () => {
    const snapshot = apiSnapshot(build(["demo", "cli"]))
    expect(snapshot.problems).toEqual([])
    expect(Object.fromEntries(snapshot.files)).toEqual({
      "cli--adapters--store.adapter.api.txt": "class Store\n",
      "cli--run.adapter.api.txt": "const runMain\n",
      "cli.api.txt": "const cli\n",
      "demo--extra.api.txt": "const parse\n",
      "demo.api.txt": [
        "class Service", "const Schema", "const default", "const external", "enum Level", "function run", "interface ShapeAlias",
        "let counter", "namespace Tools", "type LevelType", "type Schema", "type SchemaType", "type ServiceType", "",
      ].join("\n"),
    })
  })

  test("a root entry may not export what src/internal/ or src/engine/ declares, nor re-export a module that does not resolve; every published path resolves", () => {
    manifest("host", { ".": { types: "./dist/index.d.ts" } })
    write("types/host/src/index.d.ts", [
      `export * from "@xandreed/demo";`,
      `export { parse } from "@xandreed/demo/extra";`,
      `export { start } from "./engine/run.js";`,
      `export { deep } from "@xandreed/demo/internal/json.js";`,
      `export { runMain } from "@xandreed/cli/run.adapter.js";`,
    ].join("\n"))
    write("types/host/src/engine/run.d.ts", `export declare const start: () => void;\n`)
    const snapshot = apiSnapshot(build(["demo", "cli", "host"]))
    expect(snapshot.problems).toEqual([
      `host/src/index.d.ts re-exports "@xandreed/demo/internal/json.js", which does not resolve`,
      "@xandreed/host exports deep, whose declaration does not resolve",
      "@xandreed/host exports parse, declared in demo/src/internal/json.d.ts: a root entry may not export what src/internal/ or src/engine/ declares; export it from its own entry",
      "@xandreed/host exports start, declared in host/src/engine/run.d.ts: a root entry may not export what src/internal/ or src/engine/ declares; export it from its own entry",
    ])
    // `export *` of another package's root is that root's names but `default`; `./*.js` resolves as `./*` does.
    expect(snapshot.files.get("host.api.txt")?.split("\n")).toContain("const runMain")
    expect(snapshot.files.get("host.api.txt")?.split("\n").filter((line) => !/ (parse|start|runMain)$/.test(line)))
      .toEqual(snapshot.files.get("demo.api.txt")?.split("\n").filter((line) => line !== "const default"))
  })

  test("an entry whose declaration the build did not emit is refused", () => {
    manifest("bare", { ".": { types: "./dist/index.d.ts" } })
    expect(apiSnapshot(build(["bare"])).problems).toEqual(["@xandreed/bare: the build emitted no bare/src/index.d.ts; rebuild"])
  })
})

describe("apiDifferences", () => {
  test("names each new, stale and changed file, and the lines that changed", () => {
    const committed = new Map([["core.api.txt", "const a\nconst b\n"], ["gone.api.txt", "const x\n"], ["same.api.txt", "type T\n"]])
    const built = new Map([["core.api.txt", "const a\nconst c\n"], ["new.api.txt", "const n\n"], ["same.api.txt", "type T\n"]])
    expect(apiDifferences(committed, built)).toEqual([
      "api/core.api.txt differs from the build: +const c, -const b",
      "api/gone.api.txt is for an entry the build does not publish",
      "api/new.api.txt is missing: a new entry (1 lines)",
    ])
    expect(apiDifferences(built, built)).toEqual([])
  })
})
