// The three files the Code pane shows are compiled as written, type-checked,
// and run on the kernel with a scripted model: if the displayed code stops
// being valid, this fails.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { Memory, memoryConformance, scriptedModel } from "@xandreed/sdk/kernel"
import type { ConformanceCheck } from "@xandreed/core/kernel"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "./memory.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

/** What a pane is told, in order. */
interface Shown {
  readonly pieces: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

/** The module form of the three files; the agent's program as given. */
const write = (name: string, program: string, memory: string = DEFAULT_MEMORY) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(program))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(memory))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file`, send `messages` through its pane, and stop the program once they are
 * answered. One by one, each is sent once the one before has its answer; at once, all are sent together, and one
 * turn takes them all.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: Parameters<typeof scriptedModel>[0], sending: "one by one" | "at once" = "one by one") => Effect.gen(function* () {
  const { run } = (yield* Effect.promise(() => import(file.href))) as { run: Run }
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<Shown>({ pieces: [], replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const expected = sending === "at once" ? 1 : messages.length
  let send: (text: string) => void = () => {}
  const settled = () => Effect.runSync(Effect.flatMap(Ref.get(shown), (all) => {
    const answered = all.replies.length + all.errors.length
    if (sending === "one by one" && answered < messages.length) send(messages[answered]!)
    return answered >= expected ? Deferred.succeed(done, undefined) : Effect.void
  }))
  const pane: Pane = {
    onSend: (given) => { send = given; Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: (piece) => note("pieces", piece),
    finishAnswer: (text) => { note("replies", text); settled() },
    showError: (error) => { note("errors", String(error)); settled() },
    showStatus: (text) => note("status", text),
  }
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(sent)
  if (sending === "at once") messages.forEach(given)
  else given(messages[0]!)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 1's displayed program", () => {
  test("one by one, each message is a turn of its own, every turn seeing the turns before it", async () => {
    const result = await Effect.runPromise(runMain(write("default", DEFAULT_AGENT), ["Hi, I'm Ana.", "What's my name?", "Spell it backwards."], [
      { _tag: "Answers", pieces: ["Hello, ", "Ana!"] },
      { _tag: "Answers", pieces: ["Your name is Ana."] },
      { _tag: "Answers", pieces: ["A-n-A."] },
    ]))
    expect(result.shown.replies).toEqual(["Hello, Ana!", "Your name is Ana.", "A-n-A."])
    expect(result.shown.pieces).toEqual(["Hello, ", "Ana!", "Your name is Ana.", "A-n-A."])
    // The boot hook named each turn on the status line as it started.
    expect(result.shown.status).toEqual(["turn 1", "turn 2", "turn 3"])
    expect(result.shown.errors).toEqual([])
    // The second prompt is the system text, the first turn, then its own message.
    expect(result.calls[1]).toEqual([
      { role: "system", text: "You are a friendly tutor. Keep answers short." },
      { role: "user", text: "Hi, I'm Ana." },
      { role: "assistant", text: "Hello, Ana!" },
      { role: "user", text: "What's my name?" },
    ])
  })

  test("sent at once, the messages waiting behind the first are taken by its turn: all stored, one answer", async () => {
    const result = await Effect.runPromise(runMain(write("at-once", DEFAULT_AGENT), ["Hi, I'm Ana.", "What's my name?", "Spell it backwards."], [
      { _tag: "Answers", pieces: ["Hello Ana, your name is Ana, A-n-A."] },
    ], "at once"))
    expect(result.shown.replies).toEqual(["Hello Ana, your name is Ana, A-n-A."])
    expect(result.shown.status).toEqual(["turn 1"])
    expect(result.calls).toEqual([[
      { role: "system", text: "You are a friendly tutor. Keep answers short." },
      { role: "user", text: "Hi, I'm Ana." },
      { role: "user", text: "What's my name?" },
      { role: "user", text: "Spell it backwards." },
    ]])
  })

  test("a model that fails fails its own turn, which the chat shows, and the program goes on", async () => {
    const result = await Effect.runPromise(runMain(write("failing", DEFAULT_AGENT), ["One", "Two"], [
      { _tag: "Fails" },
      { _tag: "Answers", pieces: ["Back."] },
    ]))
    expect(result.shown.errors).toHaveLength(1)
    expect(result.shown.replies).toEqual(["Back."])
  })

  test("with the memory sending only the last message, the same program runs and the model sees only that", async () => {
    const lastOnly = DEFAULT_MEMORY.replace("return messages.map(promptMessage)", "return messages.slice(-1).map(promptMessage)")
    expect(lastOnly).not.toBe(DEFAULT_MEMORY)
    const result = await Effect.runPromise(runMain(write("last-one", DEFAULT_AGENT, lastOnly), ["Hi, I'm Ana.", "What's my name?"], [{ _tag: "Answers", pieces: ["Hi."] }]))
    expect(result.calls[1]).toEqual([{ role: "system", text: "You are a friendly tutor. Keep answers short." }, { role: "user", text: "What's my name?" }])
  })

  test("the memory as shown passes every check of the memory kit but pairs, which a conversation with tools needs", async () => {
    const file = new URL("./memory.ts", write("kit", DEFAULT_AGENT))
    const { flatMemory } = (await import(file.href)) as { flatMemory: Layer.Layer<Memory> }
    const checks: ReadonlyArray<ConformanceCheck> = memoryConformance({
      name: "flat",
      open: () => Effect.map(Layer.build(flatMemory), (built) => Context.get(built, Memory)),
    })
    const failed = await Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) => result._tag === "Failure" ? [check.id] : []), { concurrency: 1 }))
    // Lesson 1 has no tools; lesson 2's memory adds paired, and passes pairs too.
    expect(failed.flat()).toEqual(["pairs"])
  })

  test("type-checks as TypeScript, all three files", () => {
    write("typed", DEFAULT_AGENT)
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
