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
