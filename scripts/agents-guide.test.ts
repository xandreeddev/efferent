import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import config from "../foundry.config.js"

/**
 * The root AGENTS.md is the first thing an agent reads: its gate table names
 * exactly the rules the repo profile runs, and its definition of done runs
 * every command CI runs.
 */
const root = join(import.meta.dir, "..")
const guide = await readFile(join(root, "AGENTS.md"), "utf8")
const section = (heading: string): string => guide.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? ""

test("the gate table lists every rule the repo profile runs, and only those", () => {
  const listed = [...section("Gate rules").matchAll(/^\| `([a-z-]+\/[a-z-]+)` \|/gm)].map((match) => match[1] ?? "")
  const configured = [
    ...config.rules.map((entry) => entry.rule),
    ...(config.boundaries === undefined ? [] : ["boundaries/illegal-import", "boundaries/illegal-external"]),
    ...(config.registration === undefined ? [] : ["quality/package-registered"]),
    ...(config.privateText === undefined ? [] : ["quality/no-private-text"]),
    ...(config.baseline === "empty" ? ["quality/baseline-empty"] : []),
  ]
  expect([...listed].sort()).toEqual([...configured].sort())
})

test("effect/branded-id-fields judges the entity files of every package the profile checks", () => {
  const includeOf = (rule: string): ReadonlyArray<string> => config.rules.find((entry) => entry.rule === rule)?.include ?? []
  const judged = includeOf("effect/branded-id-fields")
  expect(includeOf("effect/no-try-catch").filter((checked) => !judged.includes(`${checked}/*.entity.ts`))).toEqual([])
})

test("the definition of done runs every command of the CI workflow", async () => {
  const workflow = Bun.YAML.parse(await readFile(join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: ReadonlyArray<{ run?: string }> }> }
  const commands = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => (step.run ?? "").split("\n").map((line) => line.trim()).filter(Boolean)))
  expect(commands.length).toBeGreaterThan(5)
  const done = section("Definition of done")
  expect(commands.filter((command) => !done.includes(command))).toEqual([])
})
