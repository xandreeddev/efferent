import { expect, test } from "bun:test"
import { join, resolve } from "node:path"
import ts from "typescript"
import { Result, Schema } from "effect"
import { guideMetadata, pluginSlug, referenceEnd, referenceStart, updatePluginGuide } from "./plugin-docs.js"
import type { PluginReference } from "./plugin-docs.js"

const root = resolve(import.meta.dir, "..")
const docs = join(root, "packages/website/src/content/docs")
const Reference = Schema.Struct({
  id: Schema.String, version: Schema.String, apiVersion: Schema.Number, scope: Schema.String,
  provides: Schema.Array(Schema.String), requires: Schema.Array(Schema.String),
  optional: Schema.Array(Schema.String), contributes: Schema.Array(Schema.String),
  defaults: Schema.Json, schema: Schema.Json,
})
const references = async () => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(Reference))(await Bun.file(join(root, "docs/plugin-reference.json")).json())
  if (Result.isFailure(decoded)) throw decoded.failure
  return decoded.success
}
const sample: PluginReference = {
  id: "@xandreed/plugin-memory/capture", version: "0.16.2", apiVersion: 3, scope: "session",
  provides: ["memory/Capture"], requires: ["memory/Store"], optional: [], contributes: [],
  defaults: { limit: 8 }, schema: { type: "object" },
}
const source = `---\ntitle: Capture\ndescription: Capture acknowledged turns.\npluginId: ${JSON.stringify(sample.id)}\n---\n\nAuthored explanation.\n\n${referenceStart}\n${referenceEnd}\n`

test("plugin guides derive stable routes from complete plugin IDs", () => {
  expect(pluginSlug("@xandreed/plugin-memory")).toBe("memory")
  expect(pluginSlug(sample.id)).toBe("memory-capture")
  expect(() => pluginSlug("../../outside")).toThrow("Invalid first-party plugin id")
})

test("generated contracts refresh defaults and preserve authored content idempotently", () => {
  const first = updatePluginGuide(source, sample)
  const updated = updatePluginGuide(first, { ...sample, defaults: { limit: 16 } })
  expect(updated).toContain("Authored explanation.")
  expect(updated).toContain('"limit": 16')
  expect(updated).not.toContain('"limit": 8')
  expect(updatePluginGuide(updated, { ...sample, defaults: { limit: 16 } })).toBe(updated)
})

test("a guide cannot silently document another plugin or lose its generated boundary", () => {
  expect(() => guideMetadata(source, "@xandreed/plugin-rag")).toThrow("guide belongs to")
  expect(() => updatePluginGuide(source.replace(referenceEnd, ""), sample)).toThrow("exactly one")
  expect(() => updatePluginGuide(source + referenceStart, sample)).toThrow("exactly one")
  expect(() => updatePluginGuide(source.replace(`${referenceStart}\n${referenceEnd}`, `${referenceEnd}\n${referenceStart}`), sample)).toThrow("reversed")
})

test("every exported plugin has its own current guide and a sidebar entry", async () => {
  const plugins = await references()
  const navigation = Schema.decodeUnknownResult(Schema.Array(Schema.Struct({
    group: Schema.String, items: Schema.Array(Schema.Struct({ slug: Schema.String, label: Schema.String })),
  })))(await Bun.file(join(root, "packages/website/src/data/plugin-navigation.json")).json())
  if (Result.isFailure(navigation)) throw navigation.failure
  const items = navigation.success.flatMap((group) => group.items)
  expect(new Set(items.map((item) => item.slug)).size).toBe(plugins.length)
  for (const plugin of plugins) {
    const slug = pluginSlug(plugin.id)
    const content = await Bun.file(join(docs, "plugins", `${slug}.md`)).text()
    const metadata = guideMetadata(content, plugin.id)
    expect(items).toContainEqual({ slug: `plugins/${slug}`, label: metadata.title })
    expect(updatePluginGuide(content, plugin)).toBe(content)
    expect(content).toMatch(/^```(?:ts|typescript)\b/m)
  }
})

interface Example { readonly file: string; readonly text: string }
const exampleDiagnostics = (examples: ReadonlyArray<Example>): ReadonlyArray<string> => {
  const config = ts.readConfigFile(join(root, "tsconfig.base.json"), ts.sys.readFile)
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true })
  const virtual = new Map(examples.map((example) => [example.file, example.text]))
  const host = ts.createCompilerHost(parsed.options)
  const readSource = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, onError, fresh) => {
    const text = virtual.get(file)
    return text === undefined ? readSource(file, language, onError, fresh) : ts.createSourceFile(file, text, language, true)
  }
  const program = ts.createProgram([...virtual.keys()], parsed.options, host)
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location = diagnostic.file !== undefined && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined
    return `${diagnostic.file?.fileName ?? "compiler"}:${location === undefined ? "" : location.line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
  })
}

test("plugin guide examples compile against the current public APIs", async () => {
  const files = [...(await references()).map((plugin) => `plugins/${pluginSlug(plugin.id)}`), "concepts/context-journal"]
  const examples = (await Promise.all(files.map(async (file) => {
    const markdown = await Bun.file(join(docs, `${file}.md`)).text()
    return Array.from(markdown.matchAll(/^```(?:ts|typescript)\s*\n([\s\S]*?)^```/gm), (match, index) => ({
      file: join(root, "scripts/.plugin-doc-examples", `${file.replaceAll("/", "-")}-${index}.ts`),
      text: `${match[1] ?? ""}\nexport {}\n`,
    }))
  }))).flat()
  expect(examples.length).toBeGreaterThanOrEqual(files.length - 1)
  expect(exampleDiagnostics(examples)).toEqual([])
}, 60_000)

test("the example compiler reports invalid example code", () => {
  expect(exampleDiagnostics([{ file: join(root, "scripts/.plugin-doc-examples/invalid.ts"), text: 'export const invalid: string = 1' }])).not.toEqual([])
}, 30_000)
