import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import * as ts from "typescript"

/**
 * Inventory validation, not a proof of semantic coverage. Each row cites the
 * tests that pin its text as `path.test.ts#<title>`: `<title>` is part of the
 * title of exactly one `test`, `it` or `describe` call in that file, and that
 * block must hold an exact expectation (`toBe`, `toEqual`, `toStrictEqual`, a
 * snapshot), in its own body or in a helper of the same file it calls.
 * Deleting the last exact expectation of a cited test, renaming the test away
 * from its citation or citing a title that two tests share fails this check;
 * deleting one expectation among several of one test does not, which is why a
 * row's pin is best a test of its own. Review still establishes that each
 * cited test covers its row. The tests themselves run in bun test and compare
 * actual rendered text or golden conversations.
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
const pinReferences = (evidence: string) => [...evidence.matchAll(/`([^`#]+\.test\.ts)#([^`]+)`/g)].map((match) => ({ file: match[1]!, title: match[2]! }))

test("each known model-text package retains its inventory and table header", () => {
  // This is a reviewed source inventory. Add a package when it introduces model text.
  expect(inventories.filter((entry) => entry.header && entry.rows.length > 0).map((entry) => entry.name)).toEqual([
    "core", "evals", "foundry", "plugin-agent-loop", "plugin-memory", "plugin-memory-digest", "plugin-memory-summary", "plugin-memory-window", "plugin-models", "plugin-rag", "plugin-render", "plugin-sessions", "plugin-tasks", "plugin-tool-discovery", "plugin-workspace", "sdk",
  ])
})

const exactMatchers = new Set(["toBe", "toEqual", "toStrictEqual", "toMatchSnapshot", "toMatchInlineSnapshot"])
const blockCallees = new Set(["test", "it", "describe"])

/** The `test`, `it` and `describe` blocks of a suite with a literal title, and whether each holds an exact expectation, directly or through a helper declared in the same file. */
const suiteBlocks = (text: string): ReadonlyArray<{ readonly title: string; readonly exact: boolean }> => {
  const file = ts.createSourceFile("suite.test.ts", text, ts.ScriptTarget.Latest, true)
  const isExpectation = (node: ts.Node): boolean => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && exactMatchers.has(node.expression.name.text) && ts.isCallExpression(node.expression.expression)
    && node.expression.expression.expression.getText(file) === "expect"
  const helpers = new Map(file.statements.flatMap((statement): ReadonlyArray<readonly [string, ts.Node]> =>
    ts.isFunctionDeclaration(statement) && statement.name !== undefined ? [[statement.name.text, statement]]
      : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap((declaration): ReadonlyArray<readonly [string, ts.Node]> =>
        ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          ? [[declaration.name.text, declaration.initializer]] : [])
      : []))
  const exactHelpers = new Set<string>()
  const holdsExact = (node: ts.Node): boolean => isExpectation(node)
    || ts.isCallExpression(node) && ts.isIdentifier(node.expression) && exactHelpers.has(node.expression.text)
    || ts.forEachChild(node, holdsExact) === true
  // A helper that calls a helper holding one holds one too: grow the set until it stops changing.
  const grow = (): void => {
    const found = [...helpers].filter(([name, node]) => !exactHelpers.has(name) && holdsExact(node))
    found.forEach(([name]) => exactHelpers.add(name))
    if (found.length > 0) grow()
  }
  grow()
  const blocks: Array<{ readonly title: string; readonly exact: boolean }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isCallExpression(node.expression) ? node.expression.expression : node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : ""
      const [title] = node.arguments
      const body = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      if (blockCallees.has(name) && title !== undefined && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) && body !== undefined) {
        blocks.push({ title: title.text, exact: holdsExact(body) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return blocks
}

/** What is wrong with citing `title` in a suite: no block with it, several, or one without an exact expectation. */
const citationProblem = (blocks: ReadonlyArray<{ readonly title: string; readonly exact: boolean }>, title: string): string | undefined => {
  const named = blocks.filter((block) => block.title.includes(title))
  return named.length === 0 ? "no test is titled with it"
    : named.length > 1 ? `${named.length} tests are titled with it`
    : named[0]!.exact ? undefined : "its test holds no exact expect assertion"
}

const inspectedSuites = new Map<string, Promise<ReadonlyArray<{ readonly title: string; readonly exact: boolean }> | undefined>>()
const inspectSuite = (file: string) => {
  const cached = inspectedSuites.get(file)
  if (cached) return cached
  const inspected = readFile(join(root, file), "utf8").then(suiteBlocks, () => undefined)
  inspectedSuites.set(file, inspected)
  return inspected
}

test("the inventory names stable assertion suites with exact expectations", async () => {
  expect(rows.length).toBeGreaterThan(40)
  const failures = (await Promise.all(rows.map(async (row) => {
    const references = pinReferences(row.evidence)
    if (references.length === 0) return [`${row.path}: ${row.text}: no stable assertion suite`]
    return (await Promise.all(references.map(async (reference) => {
      const file = reference.file.startsWith("packages/") ? reference.file : join(row.path.replace(/AGENTS\.md$/, ""), reference.file)
      const blocks = await inspectSuite(file)
      if (blocks === undefined) return [`${file}: no such suite`]
      const problem = citationProblem(blocks, reference.title)
      return problem === undefined ? [] : [`${file}#${reference.title}: ${problem}`]
    }))).flat()
  }))).flat()
  expect(failures).toEqual([])
})

test("missing tables and empty, prose-only or malformed pins cannot form inventory evidence", () => {
  expect(inventoryOf("## Model-facing text\nno table")).toEqual({ header: false, rows: [] })
  expect(inventoryOf("## Other\n| Text | Source | Pinned by |\n| x | y | z |")).toEqual({ header: false, rows: [] })
  for (const evidence of ["", "some exact tests", "`missing.ts`", "`suite.test.ts`", "suite.test.ts#pins a prompt"]) expect(pinReferences(evidence)).toEqual([])
  expect(pinReferences("`suite.test.ts#pins a prompt`; `other.test.ts#a view`")).toEqual([{ file: "suite.test.ts", title: "pins a prompt" }, { file: "other.test.ts", title: "a view" }])
})

test("a citation names one test that holds an exact expectation, in its body or a helper of its file", () => {
  const suite = [
    'const expectGolden = (text: string) => { expect(text).toBe("golden") }',
    'const viaHelper = (text: string) => expectGolden(text)',
    'describe("prompts", () => {',
    '  test("pins a prompt", () => { expect(render()).toBe("exact text") })',
    '  test("frames a prompt through a helper", () => { viaHelper(render()) })',
    '  test("checks a part", () => { expect(render()).toContain("part") })',
    "})",
  ].join("\n")
  const blocks = suiteBlocks(suite)
  expect(citationProblem(blocks, "frames a prompt")).toBeUndefined()
  expect(citationProblem(blocks, "pins a prompt")).toBeUndefined()
  expect(citationProblem(blocks, "prompts")).toBeUndefined()
  expect(citationProblem(blocks, "no such test")).toBe("no test is titled with it")
  expect(citationProblem(blocks, "a prompt")).toBe("2 tests are titled with it")
  expect(citationProblem(blocks, "checks a part")).toBe("its test holds no exact expect assertion")
  // The old id names no test.
  expect(citationProblem(blocks, "exact-assertions")).toBe("no test is titled with it")
  const blanked = suite.replace('expect(render()).toBe("exact text")', '                                    ')
  expect(citationProblem(suiteBlocks(blanked), "pins a prompt")).toBe("its test holds no exact expect assertion")
  expect(citationProblem(suiteBlocks(suite.replace('expect(text).toBe("golden")', "")), "frames a prompt")).toBe("its test holds no exact expect assertion")
})

test("deleting the assertion a row cites fails its citation, though the suite keeps many others", async () => {
  const file = "packages/plugin-workspace/src/workspace-tools.adapter.test.ts"
  const text = await readFile(join(root, file), "utf8")
  const cited = "each tool carries its description, as toolDescriptions words it"
  expect(citationProblem(suiteBlocks(text), cited)).toBeUndefined()
  const pin = text.split("\n").filter((line) => line.includes(").toEqual(toolDescriptions("))
  expect(pin).toHaveLength(1)
  const deleted = suiteBlocks(text.replace(pin[0]!, ""))
  expect(deleted.filter((block) => block.exact).length).toBeGreaterThan(40)
  expect(citationProblem(deleted, cited)).toBe("its test holds no exact expect assertion")
})
