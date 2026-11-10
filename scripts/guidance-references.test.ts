import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { effectPack } from "../packages/foundry/src/gates/rules/packs.js"

/*
 * Guidance names gate rules and spans by their ids: a rule retired or a span
 * deleted must leave the skills, the package rules, the website and the
 * Foundry examples with it, or a reader expects what no longer runs.
 */

const root = join(import.meta.dir, "..")

/** Every Markdown file under `dir` (recursively), as paths from the root. */
const markdownUnder = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(join(root, dir), { recursive: true }))
    .filter((name) => /\.mdx?$/.test(name) && !name.includes("node_modules"))
    .map((name) => join(dir, name))

const guidance = async (): Promise<ReadonlyArray<string>> => [
  ...await markdownUnder(".agents/skills"),
  ...await markdownUnder("packages/website/src/content/docs"),
  ...await markdownUnder("packages/foundry/examples"),
  ...(await readdir(join(root, "packages"))).map((name) => join("packages", name, "AGENTS.md")),
  "AGENTS.md", "README.md", "CONTRIBUTING.md", "docs/framework.md",
]

const readIfThere = (path: string) => readFile(join(root, path), "utf8").catch(() => "")

test("every effect/ rule the guidance names is one the effect pack defines", async () => {
  const defined = new Set<string>(effectPack.rules.map((rule) => rule.id))
  const named = await Promise.all((await guidance()).map(async (path) =>
    [...(await readIfThere(path)).matchAll(/`(effect\/[a-z]+(?:-[a-z]+)+)`/g)].map((match) => `${path}: ${match[1]}`)))
  expect(named.flat().filter((entry) => !defined.has(entry.slice(entry.lastIndexOf(" ") + 1)))).toEqual([])
})

test("every span the effect-idioms skill lists is named in a package's source", async () => {
  const skill = await readFile(join(root, ".agents/skills/effect-idioms/SKILL.md"), "utf8")
  const table = skill.slice(skill.indexOf("| Area | Spans |"), skill.indexOf("## 8."))
  const spans = [...table.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((match) => match[1]!)
  const sources = await Promise.all((await readdir(join(root, "packages"))).map(async (name) =>
    (await readdir(join(root, "packages", name, "src"), { recursive: true }).catch(() => []))
      .filter((file) => file.endsWith(".ts") && !/\.(test|bench)\.ts$/.test(file) && !file.endsWith("testing.ts"))
      .map((file) => join("packages", name, "src", file))))
  const text = (await Promise.all(sources.flat().map(readIfThere))).join("\n")
  expect(spans.length).toBeGreaterThan(30)
  expect(spans.filter((span) => !text.includes(`"${span}"`))).toEqual([])
})
