// Lesson 7's five files, compiled as written, type-checked, and run on the
// kernel with a scripted model, twice over one storage: the second program
// finds the conversation the first one wrote, closes the turn it left open,
// and sends the model what was stored. The learner's store is held to the
// storage kit beside the kernel's own, and each derived text to the text it
// starts from.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { JournalStorage, journalStorageConformance } from "@xandreed/core"
import type { ConformanceCheck } from "@xandreed/core"
import { scriptedModel, webStorageJournal } from "@xandreed/sdk"
import type { KeyValueStore } from "@xandreed/sdk"
import { BASE_AGENT, IMPORTS as BASE_IMPORTS } from "../base/agent.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { CHAT as FIRST_CHAT } from "../your-first-agent/chat.source.ts"
import { DEFAULT_AGENT, IMPORTS, moduleOf, REPLACED, REPLACED_IMPORTS } from "./agent.source.ts"
import { chatModuleOf, DEFAULT_RESUME, REPLACED as CHAT_REPLACED } from "./chat.source.ts"
import { noRecover } from "./config-edit.ts"
import { DEFAULT_STORE, storeModuleOf, TYPED } from "./store.source.ts"
import { Option } from "effect"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

const write = (name: string, resume: string = DEFAULT_RESUME) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), chatModuleOf(resume))
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./store.ts", at), storeModuleOf(DEFAULT_STORE))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
  return at
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (localStorage: KeyValueStore, pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>
type Store = (storage: KeyValueStore, options: { readonly prefix: string }) => Layer.Layer<JournalStorage>

/** What stands for the browser's storage: strings by key, kept for the whole test. */
const storageOf = (): KeyValueStore => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

/** A page's view of the storage, and how the test closes that page: every call of a closed view throws. */
const viewOf = (storage: KeyValueStore) => {
  let open = true
  const live = <A>(run: () => A): A => {
    if (!open) throw new Error("this page is closed")
    return run()
  }
  const view: KeyValueStore = {
    get length() { return live(() => storage.length) },
    key: (index) => live(() => storage.key(index)),
    getItem: (key) => live(() => storage.getItem(key)),
    setItem: (key, value) => live(() => storage.setItem(key, value)),
    removeItem: (key) => live(() => storage.removeItem(key)),
  }
  return { view, close: () => { open = false } }
}

/**
 * One page: `main` from the module at `at`, over a view of `storage`, with the scripted model. It sends `messages`
 * and gives what was shown once `answers` replies or errors are, or once `until` says so of a status line; the page
 * is then closed, as a reload closes it, with its program still running.
 */
const pageOver = (at: URL, storage: KeyValueStore, messages: ReadonlyArray<string>, script: Parameters<typeof scriptedModel>[0], stopAt: { readonly answers?: number; readonly status?: string } = {}) => Effect.gen(function* () {
  const { run } = (yield* Effect.promise(() => import(new URL("./agent.ts", at).href))) as { run: Run }
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<{ readonly replies: ReadonlyArray<string>; readonly errors: ReadonlyArray<string>; readonly status: ReadonlyArray<string> }>({ replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  const answers = stopAt.answers ?? messages.length
  const note = (key: "replies" | "errors" | "status", text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const settled = () => Effect.runSync(Effect.flatMap(Ref.get(shown), (all) => all.replies.length + all.errors.length >= answers ? Deferred.succeed(done, undefined) : Effect.void))
  const pane: Pane = {
    onSend: (given) => { Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: () => {},
    finishAnswer: (text) => { note("replies", text); settled() },
    showError: (error) => { note("errors", error instanceof Error ? error.message : String((error as { readonly message?: string }).message ?? error)); settled() },
    showStatus: (text) => { note("status", text); if (text === stopAt.status) Effect.runSync(Deferred.succeed(done, undefined)) },
  }
  const { view, close } = viewOf(storage)
  const program = yield* Effect.forkChild(run(view, pane, model))
  const given = yield* Deferred.await(sent)
  messages.forEach(given)
  yield* Deferred.await(done)
  // The page is closed with its program as it stands: nothing it does from here on reaches the storage.
  close()
  yield* Effect.exit(Fiber.interrupt(program))
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) => result._tag === "Failure" ? [`${check.id}: ${result.failure.message}`] : []), { concurrency: 1 })).then((failed) => failed.flat())

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 7's displayed program", () => {
  test("the base program still holds what this lesson replaces in it, and lesson 1's chat what its chat.ts replaces", () => {
    for (const [from] of REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: BASE_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of CHAT_REPLACED) expect({ from, held: FIRST_CHAT.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of TYPED) expect({ from, held: DEFAULT_STORE.split(from).length - 1 }).toEqual({ from, held: 1 })
    // The program is the base's but for where the journal is kept; it names no in-process journal any more.
    expect(`${IMPORTS}\n${DEFAULT_AGENT}`).not.toContain("inProcessJournal")
    expect(DEFAULT_AGENT).toContain('  Effect.provide(store(localStorage, { prefix: "agent:" })), // where every record is kept: your store\n')
    expect(DEFAULT_AGENT).toContain("const session = yield* sessions.open(chat.session)")
    // chat.ts creates no session of its own accord: it shows what `resume` gives.
    const chat = chatModuleOf(DEFAULT_RESUME)
    expect(chat).toContain("      const session = yield* resume\n")
    expect(chat.split('sessions.create({ owner: "learner" })').length - 1).toBe(1)
    expect(chat).toContain("  yield* sessions.recover(last.id)\n")
  })

  test("the conversation outlives the page: the second program is sent what the first one stored", async () => {
    const at = write("resumed")
    const storage = storageOf()
    const first = await Effect.runPromise(pageOver(at, storage, ["My name is Ana."], [{ _tag: "Answers", pieces: ["Hello, Ana."] }]))
    expect(first.shown.replies).toEqual(["Hello, Ana."])
    const second = await Effect.runPromise(pageOver(at, storage, ["What is my name?"], [{ _tag: "Answers", pieces: ["Ana."] }]))
    expect(second.shown.replies).toEqual(["Ana."])
    expect(second.shown.status).toEqual(["turn 2"])
    expect(second.calls).toEqual([[
      { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." },
      { role: "user", text: "My name is Ana." },
      { role: "assistant", text: "Hello, Ana." },
      { role: "user", text: "What is my name?" },
    ]])
  })

  test("a page closed while a tool runs leaves its turn open: the next program closes it, and the unanswered call is not sent", async () => {
    const at = write("abandoned")
    const storage = storageOf()
    // The first page's model asks for the calculator; the page is closed as the call starts, before any result is stored.
    await Effect.runPromise(pageOver(at, storage, ["What is 6 * 7?"], [{ _tag: "Calls", pieces: ["Let me see."], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] }], { status: "step 1: calculator" }))
    const second = await Effect.runPromise(pageOver(at, storage, ["Are you there?"], [{ _tag: "Answers", pieces: ["Yes."] }]))
    expect(second.shown).toEqual({ replies: ["Yes."], errors: [], status: ["turn 2"] })
    expect(second.calls).toEqual([[
      { role: "system", text: "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence." },
      { role: "user", text: "What is 6 * 7?" },
      { role: "assistant", text: "Let me see." },
      { role: "user", text: "Are you there?" },
    ]])
  })

  test("without recover the turn stays open: the next message is refused, and the model is not called", async () => {
    const at = write("stuck", Option.getOrThrow(noRecover(DEFAULT_RESUME)))
    const storage = storageOf()
    await Effect.runPromise(pageOver(write("abandoning"), storage, ["What is 6 * 7?"], [{ _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] }], { status: "step 1: calculator" }))
    const second = await Effect.runPromise(pageOver(at, storage, ["Are you there?"], [{ _tag: "Answers", pieces: ["Yes."] }]))
    expect(second.shown.errors).toEqual(["turn 1 is still open: if the writer that opened it is gone, close it with `Sessions.recover`"])
    expect(second.calls).toEqual([])
  })

  test("the store as written, and the kernel's webStorageJournal, pass the same kit, a second handle on the same storage included", async () => {
    const { store } = (await import(new URL("./store.ts", write("kit")).href)) as { store: Store }
    const kit = (make: (storage: KeyValueStore) => Layer.Layer<JournalStorage>) => {
      const over = (storage: KeyValueStore) => Effect.map(Effect.orDie(Layer.build(make(storage))), (built) => Context.get(built, JournalStorage))
      return journalStorageConformance({
        open: Effect.suspend(() => over(storageOf())),
        pair: Effect.suspend(() => { const storage = storageOf(); return Effect.all([over(storage), over(storage)], { concurrency: 1 }) }),
      })
    }
    const learners = kit((storage) => store(storage, { prefix: "agent:" }))
    expect(learners.map((check) => check.id)).toEqual(["create", "append", "conflict", "read-from", "missing", "list", "fork", "reopens"])
    expect(await failedChecks(learners)).toEqual([])
    expect(await failedChecks(kit((storage) => webStorageJournal(storage, { prefix: "agent:" })))).toEqual([])
  })

  test("the two stores read each other's journals: what one wrote under a prefix, the other reads back the same", async () => {
    const { store } = (await import(new URL("./store.ts", write("shared")).href)) as { store: Store }
    const storage = storageOf()
    const at = write("shared-run")
    await Effect.runPromise(pageOver(at, storage, ["My name is Ana."], [{ _tag: "Answers", pieces: ["Hello, Ana."] }]))
    const read = (make: Layer.Layer<JournalStorage>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const journals = Context.get(yield* Layer.build(make), JournalStorage)
      const [header] = yield* journals.list
      return header === undefined ? [] : (yield* journals.read(header.id)).events
    })))
    const mine = await read(store(storage, { prefix: "agent:" }))
    expect(mine).toHaveLength(4)
    expect(await read(webStorageJournal(storage, { prefix: "agent:" }))).toEqual(mine)
  })

  test("type-checks as TypeScript, all five files", () => {
    write("typed")
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
