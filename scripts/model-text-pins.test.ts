import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import * as ts from "typescript"

/**
 * Inventory validation, not a proof of semantic coverage. A cited assertion
 * suite must exist and contain exact expectations; deleting those expectations
 * fails this check. Review still establishes that each suite covers its row.
 * Stable module ids replace drifting line numbers. The suites themselves run
 * in bun test and compare actual rendered text or golden conversations.
 */
const root = join(import.meta.dir, "..")
const packages = (await readdir(join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
const inventoryOf = (text: string) => {
  const section = text.split(/^## /m).filter((part) => part.startsWith("Model-facing text\n")).join("\n")
  const header = section.split("\n").some((line) => line.startsWith("|") && line.includes("Pinned by"))
  return { header, rows: section.split("\n").filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line) && !line.includes("Pinned by")) }
}
const inventories = await Promise.all(packages.map(async (name) => {
  const path = `packages/${name}/AGENTS.md`
  const text = await readFile(join(root, path), "utf8").catch(() => "")
  return { name, path, ...inventoryOf(text) }
}))
const rows = inventories.flatMap(({ path, rows }) => rows.map((line) => {
    const cells = line.split(/\|(?=(?:[^`]*`[^`]*`)*[^`]*$)/)
    return { path, text: cells[1] ?? "", evidence: cells[3] ?? "" }
}))
const pinReferences = (evidence: string) => [...evidence.matchAll(/`([^`]+\.test\.ts)#exact-assertions`/g)].map((match) => match[1]!)

test("each known model-text package retains its inventory and table header", () => {
  // This is a reviewed source inventory. Add a package when it introduces model text.
  expect(inventories.filter((entry) => entry.header && entry.rows.length > 0).map((entry) => entry.name)).toEqual([
    "core", "evals", "foundry", "plugin-agent-loop", "plugin-memory", "plugin-memory-digest", "plugin-memory-summary", "plugin-memory-window", "plugin-models", "plugin-rag", "plugin-render", "plugin-sessions", "plugin-tasks", "plugin-tool-discovery", "plugin-workspace", "sdk",
  ])
})

const exactMatchers = new Set(["toBe", "toEqual", "toStrictEqual", "toMatchSnapshot", "toMatchInlineSnapshot"])
const hasExactAssertion = (text: string): boolean => {
  const file = ts.createSourceFile("suite.test.ts", text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): boolean => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && exactMatchers.has(node.expression.name.text) && ts.isCallExpression(node.expression.expression)
    && node.expression.expression.expression.getText(file) === "expect" || ts.forEachChild(node, visit) === true
  return visit(file)
}

const inspectedSuites = new Map<string, Promise<boolean>>()
const inspectSuite = (file: string): Promise<boolean> => {
  const cached = inspectedSuites.get(file)
  if (cached) return cached
  const inspected = readFile(join(root, file), "utf8").then(hasExactAssertion, () => false)
  inspectedSuites.set(file, inspected)
  return inspected
}

test("the inventory names stable assertion suites with exact expectations", async () => {
  expect(rows.length).toBeGreaterThan(40)
  const failures = (await Promise.all(rows.map(async (row) => {
    const references = pinReferences(row.evidence)
    if (references.length === 0) return [`${row.path}: ${row.text}: no stable assertion suite`]
    return (await Promise.all(references.map(async (reference) => {
      const file = reference.startsWith("packages/") ? reference : join(row.path.replace(/AGENTS\.md$/, ""), reference)
      return (await inspectSuite(file)) ? [] : [`${file}: no exact expect assertion`]
    }))).flat()
  }))).flat()
  expect(failures).toEqual([])
})

test("missing tables and empty, prose-only or malformed pins cannot form inventory evidence", () => {
  expect(inventoryOf("## Model-facing text\nno table")).toEqual({ header: false, rows: [] })
  expect(inventoryOf("## Other\n| Text | Source | Pinned by |\n| x | y | z |")).toEqual({ header: false, rows: [] })
  for (const evidence of ["", "some exact tests", "`missing.ts`", "`suite.test.ts#wrong-id`", "suite.test.ts#exact-assertions"]) expect(pinReferences(evidence)).toEqual([])
  expect(pinReferences("`suite.test.ts#exact-assertions`")).toEqual(["suite.test.ts"])
})

test("an assertion-free cited suite fails even if its filename and line count survive", () => {
  const source = 'test("pins a prompt", () => { expect(render()).toBe("exact text") })'
  expect(hasExactAssertion(source)).toBe(true)
  expect(hasExactAssertion(source.replace('expect(render()).toBe("exact text")', '                                    '))).toBe(false)
  expect(hasExactAssertion('test("partial", () => { expect(render()).toContain("part") })')).toBe(false)
})
