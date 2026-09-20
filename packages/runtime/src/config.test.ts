import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { loadConfig, writeConfig } from "./config.js"

const fixture = (body: (directory: string) => Promise<void>) => Effect.runPromise(Effect.acquireUseRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-config-"))),
  (directory) => Effect.promise(() => body(directory)),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
))

describe("configuration composition", () => {
  test("JSON and TypeScript normalize identically; overrides and invocation have explicit precedence", () => fixture(async (directory) => {
    const home = join(directory, "home")
    await mkdir(home)
    const base = { version: 1 as const, profile: "review", plugins: [{ id: "memory", use: "memory", options: { limit: 2, file: "memory.jsonl" } }], profiles: { review: { plugins: [{ id: "memory", use: "memory", options: { limit: 3 } }] } } }
    const load = () => Effect.runPromise(loadConfig({ workspace: directory, home, preset: { version: 1 }, invocation: { version: 1, plugins: [{ id: "memory", use: "memory", options: { limit: 5 } }] } }))
    await Effect.runPromise(writeConfig(join(directory, "efferent.config.json"), base))
    await Effect.runPromise(writeConfig(join(directory, ".efferent/overrides.json"), { version: 1, plugins: [{ id: "memory", use: "memory", options: { limit: 4 } }] }))
    const json = await load()
    expect(json.config.plugins?.[0]?.options).toEqual({ limit: 5, file: "memory.jsonl" })
    await rm(join(directory, "efferent.config.json"))
    await writeFile(join(directory, "efferent.config.ts"), `export default ${JSON.stringify(base)}`)
    expect((await load()).config).toEqual(json.config)
  }))
  test("rejects ambiguous bases, unknown profiles and invalid versions", () => fixture(async (directory) => {
    const options = { workspace: directory, home: join(directory, "home"), preset: { version: 1 as const } }
    await writeFile(join(directory, "efferent.config.json"), '{"version":1}')
    await writeFile(join(directory, "efferent.config.ts"), 'export default {version:1}')
    expect(await Effect.runPromise(Effect.either(loadConfig(options)))).toHaveProperty("left.code", "config.ambiguous")
    await rm(join(directory, "efferent.config.ts"))
    await writeFile(join(directory, "efferent.config.json"), '{"version":1,"profile":"typo"}')
    expect(await Effect.runPromise(Effect.either(loadConfig(options)))).toHaveProperty("left.code", "config.profile")
    await writeFile(join(directory, "efferent.config.json"), '{"version":99}')
    expect(await Effect.runPromise(Effect.either(loadConfig(options)))).toHaveProperty("left.code", "config.invalid")
  }))
})
