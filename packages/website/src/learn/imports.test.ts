// The learn track runs on the kernel alone: every `@xandreed/` specifier its
// code names, the lessons' shown sources included, is one of the two kernel
// entries, `@xandreed/core` and `@xandreed/sdk` (never the Node entry
// `@xandreed/sdk/node`, nor the `./kernel` subpaths the kernel had before it
// took the package roots). The engine of earlier releases is gone, and no name of it (an
// `@xandreed/plugin-*` package, core's old subpaths) is shown to a learner.
// Lessons 13 and 19 alone also name the eval package (`@xandreed/evals` and
// its `/stats`), which brings core's kernel with it for its `ModelSpend`
// ledger: only in their own files, which the page loads when their button is
// pressed (13's evals, 19's check of the graders).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ALLOWED = new Set(["@xandreed/core", "@xandreed/sdk"])

/** The eval package's two entries, which lessons 13's and 19's files may name beside the kernel's. */
const EVALS = new Set(["@xandreed/evals", "@xandreed/evals/stats"])

/** Lessons 13's and 19's files: each one's folder of the track's code, its components and its page. */
const evalsLessonFile = (file: string): boolean =>
  file.startsWith("learn/lessons/evals/") || file.startsWith("components/learn/evals/") || file === "content/learn/13-evals.mdx" ||
  file.startsWith("learn/lessons/grade-the-grader/") || file.startsWith("components/learn/grade-the-grader/") || file === "content/learn/19-grade-the-grader.mdx"

/** Whether a file may name a specifier: the kernel's two entries anywhere, the eval package's in lessons 13's and 19's files alone. */
const allowedIn = (file: string, specifier: string): boolean => ALLOWED.has(specifier) || (EVALS.has(specifier) && evalsLessonFile(file))

/** Every `@xandreed/…` module a text names in an import or export, written as code or inside a shown source string. */
export const specifiersOf = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(/(?:from|import)\s+\\?["'`](@xandreed\/[^"'`\\]+)\\?["'`]|import\(\s*["'`](@xandreed\/[^"'`]+)["'`]\s*\)/g), (match) => match[1] ?? match[2] ?? "")

/** The track's files, this test aside: its controls name other entries on purpose. */
const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "generated-program-check" || entry.name === "node_modules" || entry.name === "imports.test.ts" ? []
      : entry.isDirectory() ? filesUnder(join(dir, entry.name))
        : /\.(ts|astro|mdx)$/.test(entry.name) ? [join(dir, entry.name)] : [])

const root = fileURLToPath(new URL("../", import.meta.url))

describe("the learn track's imports", () => {
  test("name only the two kernel entries, in the page's code and in every shown source", () => {
    const files = [...filesUnder(join(root, "learn")), ...filesUnder(join(root, "components/learn")), ...filesUnder(join(root, "content/learn")), ...filesUnder(join(root, "pages/learn"))]
    const named = files.flatMap((file) => specifiersOf(readFileSync(file, "utf8")).map((specifier) => ({ specifier, file: file.slice(root.length) })))
    expect(named.length).toBeGreaterThan(20)
    expect(named.filter(({ specifier, file }) => !allowedIn(file, specifier)).map(({ specifier, file }) => `${specifier} in ${file}`)).toEqual([])
    // Lessons 13 and 19 name the eval package, in their shown sources and their page code; no other file of the track does.
    const evals = named.filter(({ specifier }) => EVALS.has(specifier))
    expect(evals.length).toBeGreaterThan(3)
    expect(evals.filter(({ file }) => !evalsLessonFile(file))).toEqual([])
    expect(evals.some(({ file }) => file.startsWith("learn/lessons/grade-the-grader/"))).toBe(true)
  })

  test("the eval package is allowed in lessons 13's and 19's files alone, and the Node entry and the old subpaths nowhere", () => {
    expect(allowedIn("learn/lessons/evals/run.ts", "@xandreed/evals")).toBe(true)
    expect(allowedIn("learn/lessons/evals/board.ts", "@xandreed/evals/stats")).toBe(true)
    expect(allowedIn("learn/lessons/grade-the-grader/run.ts", "@xandreed/evals")).toBe(true)
    expect(allowedIn("components/learn/grade-the-grader/Graders.astro", "@xandreed/evals")).toBe(true)
    expect(allowedIn("learn/lessons/connected-memory/lesson.ts", "@xandreed/evals")).toBe(false)
    expect(allowedIn("learn/panes/graders.ts", "@xandreed/evals")).toBe(false)
    expect(allowedIn("learn/lessons/test-your-agent/lesson.ts", "@xandreed/evals")).toBe(false)
    expect(allowedIn("learn/playground.ts", "@xandreed/evals/stats")).toBe(false)
    expect(allowedIn("learn/lessons/evals/run.ts", "@xandreed/core")).toBe(true)
    expect(allowedIn("learn/lessons/base/program.ts", "@xandreed/sdk/node")).toBe(false)
    expect(allowedIn("learn/lessons/base/program.ts", "@xandreed/sdk/kernel")).toBe(false)
    expect(allowedIn("learn/lessons/base/program.ts", "@xandreed/core/kernel")).toBe(false)
    expect(allowedIn("learn/lessons/evals/run.ts", "@xandreed/evals/testing/fixture.testing")).toBe(false)
  })

  test("the scan sees an import of another entry, written as code or inside a shown source", () => {
    expect(specifiersOf('import { directoryJournal } from "@xandreed/sdk/node"')).toEqual(["@xandreed/sdk/node"])
    expect(specifiersOf('export const IMPORTS = `import { Memory } from "@xandreed/core"`')).toEqual(["@xandreed/core"])
    expect(specifiersOf("const shown = \"import { x } from \\\"@xandreed/plugin-render\\\"\"")).toEqual(["@xandreed/plugin-render"])
    expect(specifiersOf('await import("@xandreed/core/internal")')).toEqual(["@xandreed/core/internal"])
    expect(specifiersOf('import "@xandreed/plugin-models"')).toEqual(["@xandreed/plugin-models"])
  })
})
