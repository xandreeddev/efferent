// The program the Code tab shows is compiled as written and run through the
// real framework: if the displayed code stops being valid, this fails.
import { afterAll, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { Effect, Option } from "effect"
import { DEFAULT_CONFIG, moduleOf } from "./lesson1.source.ts"
import { DEFAULT_TINY, tinyModuleOf } from "./tiny-memory.source.ts"
import { loadEcho } from "./models/mock.ts"

const file = new URL("./lesson1.generated.test-module.ts", import.meta.url)
const tinyFile = new URL("./tiny.generated.test-module.ts", import.meta.url)

afterAll(() => { rmSync(file, { force: true }); rmSync(tinyFile, { force: true }) })

describe("lesson 1's displayed program", () => {
  test("compiles and answers through Agent.define and agent.turn", async () => {
    writeFileSync(file, moduleOf(DEFAULT_CONFIG))
    const { program } = (await import(file.href)) as { program: (model: unknown, text: string) => Effect.Effect<{ outcome: string; reply: Option.Option<string> }> }
    const outcome = await Effect.runPromise(program(loadEcho().model, "tell me about programs"))
    expect(outcome.outcome).toBe("completed")
    expect(Option.getOrElse(outcome.reply, () => "")).toContain("tell me about programs")
  })

  test("the tiny memory file compiles with its own imports and makes a plugin", async () => {
    writeFileSync(tinyFile, tinyModuleOf(DEFAULT_TINY))
    const { tinyMemory } = (await import(tinyFile.href)) as { tinyMemory: (n: number) => { id: string; provides: ReadonlyArray<unknown> } }
    const plugin = tinyMemory(2)
    expect(plugin.id).toBe("tiny-memory")
    expect(plugin.provides.length).toBe(1)
  })
})
