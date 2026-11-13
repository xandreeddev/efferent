// Lesson 4's five files, compiled as written, type-checked, and run on the
// kernel with a scripted model: the chat's agent hands a task to its helper,
// which works in a session of its own; the chat sees only the call and the
// helper's answer.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Fiber, Ref } from "effect"
import type { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { DEFAULT_LOOP, loopModuleOf } from "./loop.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "./tools.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

const write = (name: string, agent: string = DEFAULT_AGENT) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  writeFileSync(new URL("./loop.ts", at), loopModuleOf(DEFAULT_LOOP))
  return new URL("./agent.ts", at)
}

type Pane = { readonly session: string; readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/** Run `main` with the scripted model, send one message, and stop at its reply. */
const runMain = (file: URL, message: string, script: Parameters<typeof scriptedModel>[0]) => Effect.gen(function* () {
  const { run } = (yield* Effect.promise(() => import(file.href))) as { run: Run }
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<{ readonly replies: ReadonlyArray<string>; readonly status: ReadonlyArray<string>; readonly pieces: ReadonlyArray<string> }>({ replies: [], status: [], pieces: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  const note = (key: "replies" | "status" | "pieces", text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const pane: Pane = {
    session: "the-chat",
    onSend: (given) => Effect.runSync(Deferred.succeed(sent, given)),
    appendToAnswer: (piece) => note("pieces", piece),
    finishAnswer: (text) => { note("replies", text); Effect.runSync(Deferred.succeed(done, undefined)) },
    showError: (error) => { note("replies", `error: ${String(error)}`); Effect.runSync(Deferred.succeed(done, undefined)) },
    showStatus: (text) => note("status", text),
  }
  const program = yield* Effect.forkChild(run(pane, model))
  ;(yield* Deferred.await(sent))(message)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 4's displayed program", () => {
  test("the chat delegates; the helper works in a session of its own; the chat sees the call and the answer only", async () => {
    const result = await Effect.runPromise(runMain(write("delegate"), "Ask a helper: what is 6 * 7?", [
      { _tag: "Calls", pieces: ["I'll ask a helper."], calls: [{ name: "delegate", params: { task: "What is 6 * 7?" } }] },
      { _tag: "Calls", pieces: ["Working it out."], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] },
      { _tag: "Answers", pieces: ["It is 42."] },
      { _tag: "Answers", pieces: ["The helper says 42."] },
    ]))
    expect(result.shown.replies).toEqual(["The helper says 42."])
    expect(result.shown.status).toEqual(["turn 1", "step 1: delegate", "helper: step 1: calculator", "turn 1: answered"])
    // The helper's words never reach the chat's bubble.
    expect(result.shown.pieces.join("")).toBe("I'll ask a helper.The helper says 42.")
    const shown = result.calls.map((prompt) => prompt.map((message) => `${message.role}: ${message.text}`))
    expect(shown[1]).toEqual(["system: You are a helper. Do the task you are given, then answer in one short sentence.", "user: What is 6 * 7?"])
    expect(shown[3]?.length).toBe(4)
    expect(shown[3]?.at(-1)).toMatch(/^tool: → \{"answer":"It is 42\.","session":"[0-9a-f-]+"\}$/)
  })

  test("type-checks as TypeScript, all five files", () => {
    write("typed")
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
