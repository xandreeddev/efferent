import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Exit } from "effect"
import { spawnBounded } from "@xandreed/plugin-tools-local"
import { workspaceChanges } from "./git-changes.adapter.js"

const temporary: string[] = []
afterEach(() => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))
const workspace = async (initialize = true) => {
  const path = await mkdtemp(join(tmpdir(), "efferent-changes-"))
  temporary.push(path)
  if (initialize) expect((await Effect.runPromise(spawnBounded(["git", "init", "-q"], path, 10_000))).exitCode).toBe(0)
  return path
}
const stage = async (path: string, ...files: string[]) => {
  expect((await Effect.runPromise(spawnBounded(["git", "add", "--", ...files], path, 10_000))).exitCode).toBe(0)
}

test("change review keeps staged and unstaged evidence, including after git add", async () => {
  const path = await workspace()
  await writeFile(join(path, "answer.ts"), "export const answer = 1\n")
  await stage(path, "answer.ts")
  await writeFile(join(path, "answer.ts"), "export const answer = 42\n")
  await writeFile(join(path, "new file.ts"), "export const fresh = true\n")
  const rows = await Effect.runPromise(workspaceChanges(path))
  const answer = rows.find((row) => row.label === "answer.ts")!
  expect(answer.text).toContain("Staged changes")
  expect(answer.text).toContain("+export const answer = 1")
  expect(answer.text).toContain("Working tree changes")
  expect(answer.text).toContain("-export const answer = 1")
  expect(answer.text).toContain("+export const answer = 42")
  expect(rows.find((row) => row.label === "new file.ts")?.text).toContain("+export const fresh = true")
  await stage(path, "answer.ts")
  const staged = (await Effect.runPromise(workspaceChanges(path))).find((row) => row.label === "answer.ts")!
  expect(staged.text).toContain("+export const answer = 42")
  expect(staged.text).not.toContain("Working tree changes")
})

test("nested workspaces show their own relative paths and complete diffs", async () => {
  const path = await workspace()
  const nested = join(path, "packages", "project")
  await mkdir(nested, { recursive: true })
  await writeFile(join(path, "outside.ts"), "outside workspace\n")
  await writeFile(join(nested, "inside.ts"), "before\n")
  await stage(path, ".")
  await writeFile(join(nested, "inside.ts"), "after\n")
  await writeFile(join(nested, "new.ts"), "new nested file\n")
  const rows = await Effect.runPromise(workspaceChanges(nested))
  expect(rows.map((row) => row.label)).toEqual(["inside.ts", "new.ts"])
  expect(rows[0]!.text).toContain("+before")
  expect(rows[0]!.text).toContain("-before")
  expect(rows[0]!.text).toContain("+after")
  expect(rows[1]!.text).toContain("+new nested file")
})

test("Git discovery failures reach the command error channel", async () => {
  const path = await workspace(false)
  const result = await Effect.runPromiseExit(workspaceChanges(path))
  expect(Exit.isFailure(result)).toBe(true)
  expect(String(result)).toContain("not a git repository")
})
