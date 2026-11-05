import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const checker = new URL("../packages/website/scripts/linkcheck.mjs", import.meta.url).pathname
const fixture = async (use: (root: string, dist: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "efferent-linkcheck-"))
  const dist = join(root, "dist")
  try {
    await mkdir(join(dist, "examples"), { recursive: true })
    await mkdir(join(dist, "docs/guide"), { recursive: true })
    await writeFile(join(dist, "examples/memory-walkthrough.json"), '{"sourceHash":"fixture"}\n')
    await writeFile(join(dist, "examples/spaced name.json"), "{}\n")
    await writeFile(join(dist, "docs/guide/index.html"), '<h1 id="chapter">Guide</h1>')
    await use(root, dist)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const run = (dist: string) => {
  const child = Bun.spawnSync([process.execPath, checker, dist, "/efferent"], { stdout: "pipe", stderr: "pipe" })
  return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() }
}

test("built JSON downloads, encoded names, queries and relative asset links resolve alongside HTML anchors", () => fixture(async (_root, dist) => {
  await writeFile(join(dist, "index.html"), [
    '<a href="/efferent/examples/memory-walkthrough.json">Download evidence</a>',
    '<a href="examples/spaced%20name.json?download=1#client-fragment">Download with query</a>',
    '<a href="/efferent/docs/guide/#chapter">Guide</a>',
  ].join("\n"))
  await writeFile(join(dist, "docs/guide/index.html"), [
    '<h1 id="chapter">Guide</h1>',
    '<a href="../../examples/memory-walkthrough.json">Relative download</a>',
    '<a href="#chapter">This chapter</a>',
  ].join("\n"))
  expect(run(dist)).toEqual({ code: 0, output: "Checked 2 pages.\n✓ All internal links resolve.\n" })
}))

test("missing assets, directories and missing HTML anchors still fail", () => fixture(async (_root, dist) => {
  await writeFile(join(dist, "index.html"), [
    '<a href="/efferent/examples/missing.json">Missing download</a>',
    '<a href="/efferent/examples/">Not a file or page</a>',
    '<a href="/efferent/docs/guide/#missing">Missing anchor</a>',
  ].join("\n"))
  const result = run(dist)
  expect(result.code).toBe(1)
  expect(result.output).toContain("3 broken link(s)")
  expect(result.output).toContain("no built page or static file")
  expect(result.output).toContain('no id="missing"')
}))

test("asset lookup rejects literal and encoded traversal and symlinks outside the build", () => fixture(async (root, dist) => {
  await writeFile(join(root, "outside.json"), '{"outside":true}\n')
  await symlink(join(root, "outside.json"), join(dist, "examples/leak.json"))
  await writeFile(join(dist, "index.html"), [
    '<a href="/efferent/../outside.json">Literal traversal</a>',
    '<a href="/efferent/%2e%2e/outside.json">Encoded traversal</a>',
    '<a href="/efferent/..%2foutside.json">Encoded separator</a>',
    '<a href="/efferent/examples/leak.json">Outside symlink</a>',
  ].join("\n"))
  const result = run(dist)
  expect(result.code).toBe(1)
  expect(result.output).toContain("4 broken link(s)")
  expect(result.output).toContain("root link missing base /efferent")
  expect(result.output).toContain("examples/leak.json")
}))
