// The learn track runs on the kernel alone: every `@xandreed/` specifier its
// code names, the lessons' shown sources included, is one of the two kernel
// entries. The old engine is never imported, nor shown to a learner.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ALLOWED = new Set(["@xandreed/core/kernel", "@xandreed/sdk/kernel"])

/** Every `@xandreed/…` module a text names in an import or export, written as code or inside a shown source string. */
export const specifiersOf = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(/(?:from|import)\s+\\?["'`](@xandreed\/[^"'`\\]+)\\?["'`]|import\(\s*["'`](@xandreed\/[^"'`]+)["'`]\s*\)/g), (match) => match[1] ?? match[2] ?? "")

/** The track's files, this test aside: its controls name the old engine on purpose. */
const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "generated-program-check" || entry.name === "node_modules" || entry.name === "imports.test.ts" ? []
      : entry.isDirectory() ? filesUnder(join(dir, entry.name))
        : /\.(ts|astro|mdx)$/.test(entry.name) ? [join(dir, entry.name)] : [])

const root = fileURLToPath(new URL("../", import.meta.url))

describe("the learn track's imports", () => {
  test("name only the two kernel entries, in the page's code and in every shown source", () => {
    const files = [...filesUnder(join(root, "learn")), ...filesUnder(join(root, "components/learn")), ...filesUnder(join(root, "content/learn")), ...filesUnder(join(root, "pages/learn"))]
    const named = files.flatMap((file) => specifiersOf(readFileSync(file, "utf8")).map((specifier) => `${specifier} in ${file.slice(root.length)}`))
    expect(named.length).toBeGreaterThan(20)
    expect(named.filter((entry) => !ALLOWED.has(entry.split(" in ")[0]!))).toEqual([])
  })

  test("the scan sees an import of the old engine, written as code or inside a shown source", () => {
    expect(specifiersOf('import { Agent } from "@xandreed/sdk"')).toEqual(["@xandreed/sdk"])
    expect(specifiersOf('export const IMPORTS = `import { Memory } from "@xandreed/core"`')).toEqual(["@xandreed/core"])
    expect(specifiersOf("const shown = \"import { x } from \\\"@xandreed/plugin-render\\\"\"")).toEqual(["@xandreed/plugin-render"])
    expect(specifiersOf('await import("@xandreed/core/internal")')).toEqual(["@xandreed/core/internal"])
    expect(specifiersOf('import "@xandreed/plugin-models"')).toEqual(["@xandreed/plugin-models"])
  })
})
