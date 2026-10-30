import { describe, expect, test } from "bun:test"
import { declarationImportProblems, declarationSpecifiers } from "./declaration-imports.js"

const manifest = { name: "@xandreed/core", dependencies: { "@noble/hashes": "2.4.0" }, peerDependencies: { effect: "^4.0.7" } }

describe("declarationSpecifiers", () => {
  test("names the modules of import and export clauses, import types, require imports, augmentations and type references", () => {
    expect(declarationSpecifiers([
      `/// <reference types="node" />`,
      `import { Effect } from "effect"`,
      `import type { Brand } from "effect/Brand"`,
      `export { x } from "./x.js"`,
      `export * from "@xandreed/runtime"`,
      `import fs = require("node:fs")`,
      `declare module "@xandreed/plugin-models" { interface Extra {} }`,
      `export declare const message: typeof import("@xandreed/sdk").UserMessage`,
      `export declare const brand: import("effect/Brand").Brand<"Id">`,
    ].join("\n"))).toEqual(["node", "effect", "effect/Brand", "./x.js", "@xandreed/runtime", "node:fs", "@xandreed/plugin-models", "@xandreed/sdk", "effect/Brand"])
  })
})

describe("declarationImportProblems", () => {
  test("its own files, its dependencies and peers, their subpaths and the runtime's modules are declared", () => {
    expect(declarationImportProblems(manifest, [{
      path: "core/dist/index.d.ts",
      text: [
        `import { Effect } from "effect"`,
        `import type { Brand } from "effect/Brand"`,
        `import { sha256 } from "@noble/hashes/sha2.js"`,
        `export { x } from "./x.js"`,
        `export type { Inner } from "@xandreed/core/internal"`,
        `import type { Stats } from "node:fs"`,
        `import type { Readable } from "stream"`,
        `import type { Database } from "bun:sqlite"`,
        `/// <reference types="bun" />`,
      ].join("\n"),
    }])).toEqual([])
  })

  test("a package the manifest does not declare fails, naming the file and the module, once per file", () => {
    expect(declarationImportProblems(manifest, [{
      path: "core/dist/turn/turn-phase.entity.d.ts",
      text: [
        `export declare const a: typeof import("@xandreed/sdk").UserMessage`,
        `export declare const b: typeof import("@xandreed/sdk").UserMessage`,
        `import type { Tool } from "@effect/ai-openai"`,
      ].join("\n"),
    }])).toEqual([
      `core/dist/turn/turn-phase.entity.d.ts imports "@xandreed/sdk", which @xandreed/core does not declare as a dependency or a peer`,
      `core/dist/turn/turn-phase.entity.d.ts imports "@effect/ai-openai", which @xandreed/core does not declare as a dependency or a peer`,
    ])
  })
})
