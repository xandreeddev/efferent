import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Every package's AGENTS.md lists the text its package puts before the model
 * in a "Model-facing text" table, and its "Pinned by" column names the test
 * that pins each text exactly (or a golden). A text pinned in part, or not
 * at all, is a wording change no test sees: the column never says so, and
 * every test file it cites exists, with the cited lines in it.
 */
const root = join(import.meta.dir, "..")
const packages = (await readdir(join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

interface Row {
  readonly agents: string
  readonly text: string
  readonly pinnedBy: string
}

/** A table row's cells, split on the pipes outside code spans. */
const cells = (line: string): ReadonlyArray<string> =>
  line.trim().replace(/^\||\|$/g, "").split(/\|(?=(?:[^`]*`[^`]*`)*[^`]*$)/).map((cell) => cell.trim())

/** The rows of a package's "Model-facing text" table, with its "Pinned by" cell. */
const rowsOf = async (name: string): Promise<ReadonlyArray<Row>> => {
  const agents = `packages/${name}/AGENTS.md`
  const guide = await readFile(join(root, agents), "utf8").catch(() => "")
  const section = guide.split(/^## /m).find((part) => part.startsWith("Model-facing text\n")) ?? ""
  const lines = section.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|---"))
  const header = cells(lines[0] ?? "")
  const column = header.indexOf("Pinned by")
  return column === -1 ? [] : lines.slice(1).map((line) => {
    const row = cells(line)
    return { agents, text: row[0] ?? "", pinnedBy: row[column] ?? "" }
  })
}

const rows = (await Promise.all(packages.map(rowsOf))).flat()

/** The test files a cell cites (`src/x.test.ts:12`, then `:30` for the same file), each with its cited lines. */
const citations = (agents: string, cell: string): ReadonlyArray<{ readonly path: string; readonly lines: ReadonlyArray<number> }> => {
  const base = agents.replace(/AGENTS\.md$/, "")
  const found = [...cell.matchAll(/`([^`\s]*?)(?::(\d+)(?:-(\d+))?)?`/g)].reduce<ReadonlyArray<{ readonly path: string; readonly lines: ReadonlyArray<number> }>>((all, match) => {
    const [, path = "", from, to] = match
    const lines = from === undefined ? [] : [Number(from), ...(to === undefined ? [] : [Number(to)])]
    if (/\.test\.ts$/.test(path)) return [...all, { path: path.startsWith("packages/") ? path : `${base}${path}`, lines }]
    const last = all.at(-1)
    return path === "" && last !== undefined ? [...all.slice(0, -1), { path: last.path, lines: [...last.lines, ...lines] }] : all
  }, [])
  return found
}

test("the tables have rows to check", () => {
  expect(rows.length).toBeGreaterThan(40)
})

test("every model-facing text is pinned exactly: no cell says unpinned, contains, codes only or by reference only", () => {
  const partial = rows.filter((row) => /unpinned|contains|codes only|by reference only/.test(row.pinnedBy))
  expect(partial.map((row) => `${row.agents}: ${row.text}: ${row.pinnedBy}`)).toEqual([])
})

test("every test file a pin cites exists, and holds the lines it cites", async () => {
  const cited = rows.flatMap((row) => citations(row.agents, row.pinnedBy).map((citation) => ({ ...citation, row })))
  expect(cited.length).toBeGreaterThan(40)
  const missing = await Promise.all(cited.map(async ({ path, lines, row }) => {
    const text = await readFile(join(root, path), "utf8").catch(() => undefined)
    if (text === undefined) return [`${row.agents}: ${row.text}: ${path} does not exist`]
    const length = text.split("\n").length
    return lines.filter((line) => line < 1 || line > length).map((line) => `${row.agents}: ${row.text}: ${path}:${line} is past its ${length} lines`)
  }))
  expect(missing.flat()).toEqual([])
})
