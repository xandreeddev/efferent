// Lesson 2's four files, compiled as written, type-checked, and run on the
// kernel with a scripted model: the turn is a loop over steps, tools run and
// their results are stored, failures are answers, the step limit holds, and a
// message sent while the turn works steers it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { Memory, memoryConformance, scriptedModel } from "@xandreed/sdk/kernel"
import type { ConformanceCheck, StoredEvent } from "@xandreed/core/kernel"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "./tools.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

interface Shown {
  readonly pieces: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

const write = (name: string, agent: string = DEFAULT_AGENT, tools: string = DEFAULT_TOOLS) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(tools))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` with the scripted model, send `messages`, and stop once `answers` replies or
 * errors are shown. `onStatus` may send more, as a learner typing while the agent works.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: Parameters<typeof scriptedModel>[0], answers = messages.length, onStatus: (status: string, send: (text: string) => void) => void = () => {}) => Effect.gen(function* () {
  const { run } = (yield* Effect.promise(() => import(file.href))) as { run: Run }
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<Shown>({ pieces: [], replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let send: (text: string) => void = () => {}
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const settled = () => Effect.runSync(Effect.flatMap(Ref.get(shown), (all) => all.replies.length + all.errors.length >= answers ? Deferred.succeed(done, undefined) : Effect.void))
  const pane: Pane = {
    onSend: (given) => { send = given; Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: (piece) => note("pieces", piece),
    finishAnswer: (text) => { note("replies", text); onStatus(`reply: ${text}`, send); settled() },
    showError: (error) => { note("errors", String(error)); settled() },
    showStatus: (text) => { note("status", text); onStatus(text, send) },
  }
  // The journal, read through the program's own sessions: the test's main provides them, so they are taken from a probe.
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(sent)
  messages.forEach(given)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 2's displayed program", () => {
  test("the model asks for a tool, the result goes back to it, and its answer is the reply", async () => {
    const result = await Effect.runPromise(runMain(write("sum"), ["What is 6 * 7?"], [
      { _tag: "Calls", pieces: ["Let me work it out."], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] },
      { _tag: "Answers", pieces: ["It is 42."] },
    ]))
    expect(result.shown.replies).toEqual(["It is 42."])
    expect(result.shown.status).toEqual(["turn 1", "step 1: calculator"])
    expect(result.calls[1]).toEqual([
      { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." },
      { role: "user", text: "What is 6 * 7?" },
      { role: "assistant", text: "Let me work it out.calculator({\"a\":6,\"op\":\"*\",\"b\":7})" },
      { role: "tool", text: "→ 42" },
    ])
  })

  test("a tool's failure and an unknown tool are answers the model reads, and the turn goes on", async () => {
    const result = await Effect.runPromise(runMain(write("failures"), ["Try."], [
      { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 1, op: "/", b: 0 } }, { name: "search", params: { q: "x" } }] },
      { _tag: "Answers", pieces: ["Neither worked."] },
    ]))
    expect(result.shown.replies).toEqual(["Neither worked."])
    expect(result.calls[1]?.slice(-2).map((message) => message.text)).toEqual([
      "→ failed: \"cannot divide by zero\"",
      "→ failed: \"Toolkit.search.handle: Tool 'search' not found. Available tools: calculator, remember, recall\"",
    ])
  })

  test("the notes a tool keeps are its own: remember then recall, in two turns", async () => {
    // The second message is sent once the first is answered: sent earlier, it would join the first turn.
    const result = await Effect.runPromise(runMain(write("notes"), ["Remember milk."], [
      { _tag: "Calls", pieces: [], calls: [{ name: "remember", params: { note: "milk" } }] },
      { _tag: "Answers", pieces: ["Noted."] },
      { _tag: "Calls", pieces: [], calls: [{ name: "recall", params: {} }] },
      { _tag: "Answers", pieces: ["You noted milk."] },
    ], 2, (shown, send) => { if (shown === "reply: Noted.") send("What are my notes?") }))
    expect(result.shown.replies).toEqual(["Noted.", "You noted milk."])
    expect(result.calls[3]?.at(-1)?.text).toBe("→ [\"milk\"]")
  })

  test("a model that keeps asking stops at the step limit", async () => {
    const result = await Effect.runPromise(runMain(write("limit"), ["Count."], [
      { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 1, op: "+", b: 1 } }] },
    ]))
    expect(result.shown.replies).toEqual(["I stopped after 5 steps."])
    expect(result.calls).toHaveLength(5)
  })

  test("a message sent while the turn works joins it before the model is asked again: one turn, two messages", async () => {
    let steered = false
    const result = await Effect.runPromise(runMain(write("steer"), ["What is 6 * 7?"], [
      { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] },
      { _tag: "Answers", pieces: ["42, and doubled, 84."] },
    ], 1, (status, send) => { if (status === "step 1: calculator" && !steered) { steered = true; send("And double it.") } }))
    expect(result.shown.replies).toEqual(["42, and doubled, 84."])
    expect(result.shown.status).toEqual(["turn 1", "step 1: calculator"])
    expect(result.calls[1]?.slice(-2)).toEqual([{ role: "tool", text: "→ 42" }, { role: "user", text: "And double it." }])
  })

  test("messages sent at once are taken by the first turn as it opens: one turn answers them all", async () => {
    const result = await Effect.runPromise(runMain(write("at-once"), ["What is 6 * 7?", "And remember it."], [
      { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }, { name: "remember", params: { note: "42" } }] },
      { _tag: "Answers", pieces: ["42, and I will remember it."] },
    ], 1))
    expect(result.shown.replies).toEqual(["42, and I will remember it."])
    expect(result.calls[0]?.slice(1)).toEqual([{ role: "user", text: "What is 6 * 7?" }, { role: "user", text: "And remember it." }])
  })

  test("the memory as shown passes every check of the memory kit, pairs included", async () => {
    const file = new URL("./memory.ts", write("kit"))
    const { flatMemory } = (await import(file.href)) as { flatMemory: Layer.Layer<Memory> }
    const checks: ReadonlyArray<ConformanceCheck> = memoryConformance({
      name: "flat",
      open: () => Effect.map(Layer.build(flatMemory), (built) => Context.get(built, Memory)),
    })
    expect(checks.map((check) => check.id)).toContain("pairs")
    const failed = await Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) => result._tag === "Failure" ? [check.id] : []), { concurrency: 1 }))
    expect(failed.flat()).toEqual([])
  })

  test("type-checks as TypeScript, all four files", () => {
    write("typed")
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})

export type { StoredEvent }
