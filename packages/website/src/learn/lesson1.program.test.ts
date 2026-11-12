// The program the Code pane shows is compiled as written, type-checked, and
// run on the kernel with a scripted model: if the displayed code stops being
// valid, this fails.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import type { Reply } from "@xandreed/sdk/kernel"
import { DEFAULT_AGENT, moduleOf } from "./lesson1.source.ts"
import { DEFAULT_TINY, tinyModuleOf } from "./tiny-memory.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const agentFile = new URL("./agent.ts", dir)
const tinyFile = new URL("./tiny-memory.ts", dir)
const tsconfig = new URL("./tsconfig.json", dir)

type Run = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  messages: ReadonlyArray<string>,
  show: (text: string) => Effect.Effect<void>,
) => Effect.Effect<ReadonlyArray<Reply>, unknown>

const write = (agent: string, file: URL = agentFile) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, moduleOf(agent))
  writeFileSync(tinyFile, tinyModuleOf(DEFAULT_TINY))
}

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 1's displayed program", () => {
  test("three messages queued at once are answered in order, each turn seeing the ones before", async () => {
    write(DEFAULT_AGENT)
    const { run } = (await import(agentFile.href)) as { run: Run }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([
        { _tag: "Answers", pieces: ["Hello, ", "Ana!"] },
        { _tag: "Answers", pieces: ["Your name is Ana."] },
        { _tag: "Answers", pieces: ["A-n-A."] },
      ])
      const shown = yield* Ref.make<ReadonlyArray<string>>([])
      const replies = yield* run(model, ["Hi, I'm Ana.", "What's my name?", "Spell it backwards."], (text) => Ref.update(shown, (all) => [...all, text]))
      return { replies, calls: yield* calls, shown: yield* Ref.get(shown) }
    }))
    expect(result.replies).toEqual([{ text: "Hello, Ana!" }, { text: "Your name is Ana." }, { text: "A-n-A." }])
    // The listeners drew the chat: three queued, then each turn's answer and its end, in order.
    expect(result.shown).toEqual([
      "queued #1", "queued #2", "queued #3",
      "Hello, ", "Ana!", "turn 1 ended",
      "Your name is Ana.", "turn 2 ended",
      "A-n-A.", "turn 3 ended",
    ])
    // The second turn's request carries the first turn, under the system text the agent sets.
    expect(result.calls[1]).toEqual([
      { role: "system", text: "You are a friendly tutor. Keep answers short." },
      { role: "user", text: "Hi, I'm Ana." },
      { role: "assistant", text: "Hello, Ana!" },
      { role: "user", text: "What's my name?" },
    ])
  })

  test("with the memory swapped for the learner's lastMessages, the same program runs and sends only the last message", async () => {
    // A file of its own: the module of the first test stays cached under its name.
    const lastFile = new URL("./agent-last.ts", dir)
    write(DEFAULT_AGENT.replace("windowMemory({ budgetTokens: 3000 })", "lastMessages({ n: 1, budgetTokens: 3000 })"), lastFile)
    const { run } = (await import(lastFile.href)) as { run: Run }
    const calls = await Effect.runPromise(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hi."] }])
      yield* run(model, ["Hi, I'm Ana.", "What's my name?"], () => Effect.void)
      return yield* calls
    }))
    expect(calls[1]).toEqual([{ role: "system", text: "You are a friendly tutor. Keep answers short." }, { role: "user", text: "What's my name?" }])
  })

  test("type-checks as TypeScript, the learner's memory included", () => {
    write(DEFAULT_AGENT)
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../tsconfig.learn.json", include: ["./*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
