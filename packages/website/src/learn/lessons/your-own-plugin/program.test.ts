// Lesson 3's five files, compiled as written and type-checked; the learner's
// clock, as the page shows it, held to the wrapper kit, and its careless
// variant failing it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Option } from "effect"
import type { Layer } from "effect"
import { memoryWrapperConformance } from "@xandreed/sdk/kernel"
import type { Memory } from "@xandreed/sdk/kernel"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { dropFirst } from "./config-edit.ts"
import { DEFAULT_PLUGIN, pluginModuleOf } from "./plugin.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

const write = (name: string, plugin: string = DEFAULT_PLUGIN) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  writeFileSync(new URL("./plugin.ts", at), pluginModuleOf(plugin))
  return new URL("./plugin.ts", at)
}

type Wrap = (inner: Layer.Layer<Memory>) => Layer.Layer<Memory>
const failedChecks = (wrap: Wrap) =>
  Effect.runPromise(Effect.forEach(memoryWrapperConformance({ name: "clock", wrap }), (one) => Effect.match(one.run, { onFailure: () => [one.id], onSuccess: () => [] }), { concurrency: 1 }).pipe(Effect.map((ids) => ids.flat())))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 3's displayed program", () => {
  test("the clock as the page shows it passes the wrapper kit", async () => {
    const { withClock } = (await import(write("clock").href)) as { withClock: Wrap }
    expect(await failedChecks(withClock)).toEqual([])
  })

  test("the careless experiment's clock fails the kit's starts-with-inner check, and only that", async () => {
    const { withClock } = (await import(write("careless", Option.getOrThrow(dropFirst(DEFAULT_PLUGIN))).href)) as { withClock: Wrap }
    expect(await failedChecks(withClock)).toEqual(["starts-with-inner"])
  })

  test("type-checks as TypeScript, all five files", () => {
    write("typed")
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
