import { expect, test } from "bun:test"
import { readFile, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { KNOWLEDGE_EXTRACTION_VERSION } from "@xandreed/core"

const root = join(import.meta.dir, "..")
test("the website's native knowledge contract matches the canonical current guide", async () => {
  const canonical = await readFile(join(root, "docs/native-knowledge.md"), "utf8")
  const website = await readFile(join(root, "packages/website/src/content/docs/concepts/native-knowledge.md"), "utf8")
  expect(website.replace(/^---[\s\S]*?---\s*/, "")).toBe(canonical)
  expect(canonical).toContain(`KNOWLEDGE_EXTRACTION_VERSION\`, now \`${KNOWLEDGE_EXTRACTION_VERSION}\``)
})

/** The plugin pages' engine-version history: one "version N since …" for every version from 2 to the current one, none twice. */
for (const [page, engine] of [["plugins/memory.md", "memory"], ["plugins/rag.md", "rag"]] as const) {
  test(`${page} names the current extraction version and why each version since 2 changed`, async () => {
    const text = (await readFile(join(root, "packages/website/src/content/docs", page), "utf8")).replace(/\s+/g, " ")
    expect(text).toContain(`knowledgeEngineId("${engine}:${KNOWLEDGE_EXTRACTION_VERSION}"`)
    const versions = [...text.matchAll(/version (\d+) since/g)].map((match) => Number(match[1]))
    expect(versions.toSorted((a, b) => a - b)).toEqual(Array.from({ length: KNOWLEDGE_EXTRACTION_VERSION - 1 }, (_, index) => index + 2))
  })

  test(`${page} keeps its own prose above the generated reference`, async () => {
    const text = await readFile(join(root, "packages/website/src/content/docs", page), "utf8")
    expect(text.slice(text.indexOf("<!-- plugin-reference:end -->") + "<!-- plugin-reference:end -->".length).trim()).toBe("")
  })
}

test("the memory engine guide introduces its citation example directly", async () => {
  const guide = await readFile(join(root, "packages/website/src/content/docs/guides/memory-engine.mdx"), "utf8")
  expect(guide).toMatch(/For M2, one citation is:\n\n```json\n/)
})

test("the documented standalone spend composition actually defines an agent", async () => {
  const framework = await readFile(join(root, "docs/framework.md"), "utf8")
  const section = framework.slice(framework.indexOf("The models plugin's `spend` option"))
  const code = /```ts\n([\s\S]*?)```/.exec(section)![1]!
  const directory = join(root, ".artifacts/doc-examples")
  await mkdir(directory, { recursive: true })
  const file = join(directory, `spend-${crypto.randomUUID()}.ts`)
  await writeFile(file, `${code}\nexport default program\n`)
  await Promise.resolve().then(async () => {
    const { default: program } = await import(file)
    const result = await Effect.runPromise(Effect.scoped(program))
    expect(result).toHaveProperty("agent.turn")
    expect(result).toHaveProperty("ledger.reserve")
  }).finally(() => rm(file, { force: true }))
}, 15_000)
