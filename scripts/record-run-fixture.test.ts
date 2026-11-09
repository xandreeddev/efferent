import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const isolated = async (body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "efferent-run-recorder-"))
  await Promise.resolve().then(async () => {
    await mkdir(join(directory, "scripts"))
    await mkdir(join(directory, "packages/evals/fixtures"), { recursive: true })
    await writeFile(join(directory, "packages/evals/package.json"), '{"version":"0.19.2"}')
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.base.json") }))
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir")
    await copyFile(join(root, "scripts/record-run-fixture.ts"), join(directory, "scripts/record-run-fixture.ts"))
    await body(directory)
  }).finally(() => rm(directory, { recursive: true, force: true }))
}
const invoke = async (directory: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, "scripts/record-run-fixture.ts", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 10_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

test("release run fixtures cannot be overwritten, including --force", () => isolated(async (directory) => {
  const path = join(directory, "packages/evals/fixtures/run-0.19.2.json")
  await writeFile(path, "immutable release evidence")
  expect((await invoke(directory, [])).code).toBe(1)
  expect((await invoke(directory, ["--force"])).stderr).toContain("only with --unreleased")
  expect(await readFile(path, "utf8")).toBe("immutable release evidence")
}))

test("concurrent run recorders publish one complete fixture exclusively", () => isolated(async (directory) => {
  const results = await Promise.all([invoke(directory, []), invoke(directory, [])])
  expect(results.map((result) => result.code).toSorted((a, b) => a - b)).toEqual([0, 1])
  const fixture = JSON.parse(await readFile(join(directory, "packages/evals/fixtures/run-0.19.2.json"), "utf8"))
  expect(fixture.execution.phase).toBe("executed")
  expect(fixture.report.phase).toBe("graded")
}), 15_000)
