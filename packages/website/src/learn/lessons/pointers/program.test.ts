// Lesson 8's four files, compiled as written, type-checked, and run on the
// kernel with a scripted model: lookup's article is sent as its start and a
// pointer, the model reads on with readResult, and each later prompt starts
// with the one before it, the next turn's included. Each text the lesson
// derives is checked against the text it starts from.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { CONVERSATION_VOCABULARY, messageOf, readJournal, vocabularyOf } from "@xandreed/core"
import { Memory, paired, pointed, promptMessage, ReadResult, readResult, scriptedModel } from "@xandreed/sdk"
import { evaluateStatements } from "../../evaluate.ts"
import { BASE_AGENT } from "../base/agent.source.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY as FLAT_MEMORY, MEMORY_IMPORTS as FLAT_IMPORTS, MEMORY_INTRO as FLAT_INTRO } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, moduleOf, REPLACED as AGENT_REPLACED } from "./agent.source.ts"
import { noPointers, noReadResult, olderTurns } from "./config-edit.ts"
import { DEFAULT_MEMORY, FLAT_DECLARATION, MEMORY_HEADER, memoryBodyOf, memoryDocumentOf, memoryModuleOf, NEW_COMMENT, REPLACED, REPLACED_DECLARATION, REPLACED_IMPORTS, RULE } from "./memory.source.ts"
import { DEFAULT_TOOLS, toolsBodyOf, toolsModuleOf } from "./tools.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

interface Shown {
  readonly pieces: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

const write = (name: string, memory: string = DEFAULT_MEMORY, tools: string = DEFAULT_TOOLS) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(memory))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(tools))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` with the scripted model, send `messages`, and stop once `answers` replies or
 * errors are shown. `onStatus` may send more, as a learner typing once an answer is there.
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
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(sent)
  messages.forEach(given)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const SYSTEM = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."

/** The articles of the shown tools.ts, read from the text the page runs. */
const articles = evaluateStatements(toolsBodyOf(DEFAULT_TOOLS), "articles", { Effect, Schema, Tool, Toolkit, ReadResult, readResult }) as Record<"tides" | "volcanoes" | "honeybees", string>
const tides = articles.tides

/** The pointer the model is sent for the article on tides, stored at place 4: its first 160 characters, and the note. */
const POINTER = `<tool-result-preview>\n${tides.slice(0, 160)}\n</tool-result-preview>\n[Host note: the result above is cut short: it is 2347 characters long and its first 160 are shown. To read on, call readResult with result 4 and from 160.]`

/** The story: look the article up, read on from the pointer, answer; then a second turn. */
const story = [
  { _tag: "Calls" as const, pieces: [], calls: [{ name: "lookup", params: { topic: "tides" } }] },
  { _tag: "Calls" as const, pieces: [], calls: [{ name: "readResult", params: { result: 4, from: 160, length: 400 } }] },
  { _tag: "Answers" as const, pieces: ["Tides rise and fall twice a day."] },
  { _tag: "Answers" as const, pieces: ["You are welcome."] },
]
/** "Thanks." is sent once the first turn is answered, so it is a turn of its own. */
const thenThanks = (status: string, send: (text: string) => void) => { if (status === "reply: Tides rise and fall twice a day.") send("Thanks.") }
const tell = (file: URL) => Effect.runPromise(runMain(file, ["Look up tides."], story, 2, thenThanks))

describe("lesson 8's displayed program", () => {
  test("lesson 2's memory and the base program still hold what this lesson replaces in them, and nothing else differs", () => {
    for (const [from] of REPLACED) expect({ from, held: FLAT_MEMORY.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_IMPORTS) expect({ from, held: FLAT_IMPORTS.split(from).length - 1 }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_DECLARATION) expect({ from, held: FLAT_DECLARATION.split(from).length - 1 }).toEqual({ from, held: 1 })
    // Lesson 2's read-only start is its imports, a blank line, then its comment and declaration: what this lesson cuts it by.
    expect(FLAT_INTRO).toBe(`${FLAT_IMPORTS}\n\n${FLAT_DECLARATION}`)
    expect(FLAT_DECLARATION.endsWith("\nexport const flatMemory = ")).toBe(true)
    for (const [from] of AGENT_REPLACED) expect({ from, held: BASE_AGENT.split(from).length - 1 }).toEqual({ from, held: 1 })
    // The whole file beside lesson 2's: the rule's statement, the line that says so, one import and the line that reads each record.
    const ours = memoryDocumentOf(DEFAULT_MEMORY).split("\n")
    const flat = `${FLAT_INTRO}${FLAT_MEMORY}\n`.split("\n")
    expect(ours.filter((line) => !flat.includes(line))).toEqual([
      'import { Memory, paired, pointed, promptMessage } from "@xandreed/sdk"',
      "// A long tool result is sent as its start and a pointer: the journal keeps it whole.",
      "// Over `overTokens` a result is long; `previewTokens` of its start go with the pointer.",
      "// The rule reads only the record, so a result is sent the same way in every prompt.",
      "const sent = pointed({ overTokens: 150, previewTokens: 40 })",
      "// One thing is new: each record's message is read with the rule above, not with messageOf.",
      "        const messages = conversation.flatMap((record) => Option.toArray(sent(record)))",
    ])
    expect(flat.filter((line) => !ours.includes(line))).toEqual([
      'import { Memory, paired, promptMessage } from "@xandreed/sdk"',
      "        const messages = conversation.flatMap((record) => Option.toArray(messageOf(record)))",
    ])
    // The rule is a statement of the file, above the layer: the editable part starts with it.
    expect(DEFAULT_MEMORY.startsWith(`${RULE}\n// A memory decides what of the journal goes into the context.\n`)).toBe(true)
    expect(DEFAULT_MEMORY.indexOf("\nconst sent = pointed(")).toBeLessThan(DEFAULT_MEMORY.indexOf("\nexport const flatMemory = "))
    // Its imports gain `pointed` and keep `messageOf`, which two experiments read a record with.
    expect(MEMORY_HEADER).toContain("messageOf")
    // Without the rule (the first experiment) what is left is lesson 2's memory, word for word, whatever the numbers were.
    expect(noPointers(DEFAULT_MEMORY)).toEqual(Option.some(`${FLAT_DECLARATION}${FLAT_MEMORY}`))
    expect(noPointers(DEFAULT_MEMORY.replace("previewTokens: 40", "previewTokens: 400"))).toEqual(Option.some(`${FLAT_DECLARATION}${FLAT_MEMORY}`))
    expect(Option.getOrThrow(noPointers(DEFAULT_MEMORY))).not.toContain("pointed(")
    // Pointing only older turns keeps the rule, and says what it now reads.
    const older = Option.getOrThrow(olderTurns(DEFAULT_MEMORY))
    expect(older.startsWith(RULE)).toBe(true)
    expect(older).not.toContain(NEW_COMMENT)
    expect(older).toContain("Option.toArray(record.turn < session.turn ? sent(record) : messageOf(record)),")
    // agent.ts is the base's loop: the kernel's two functions, and one comment of main changed.
    expect(DEFAULT_AGENT.split("\n").filter((line) => !BASE_AGENT.split("\n").includes(line))).toEqual(["  Effect.provide(flatMemory), // what of the journal the model sees: a long result as a pointer"])
    expect(DEFAULT_AGENT).toContain("yield* modelAnswer(")
    expect(DEFAULT_AGENT).toContain("yield* callTool(toolkit, call, session)")
  })

  test("the rule is made once, as the file runs, and not again for each context; numbers it refuses are refused then", () => {
    let made = 0
    const counting: typeof pointed = (options) => { made++; return pointed(options) }
    const names = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage, pointed: counting }
    const layer = evaluateStatements(memoryBodyOf(DEFAULT_MEMORY), "flatMemory", names) as Layer.Layer<Memory>
    expect(made).toBe(1)
    // Two contexts over an empty journal: the rule made as the file ran is the one both read with.
    const memory = Effect.runSync(Effect.scoped(Effect.map(Layer.build(layer), (built) => Context.get(built, Memory))))
    const session = { journal: Effect.succeed([]) } as unknown as Parameters<typeof memory.context>[0]
    expect(Effect.runSync(Effect.all([memory.context(session), memory.context(session)], { concurrency: 1 }))).toEqual([[], []])
    expect(made).toBe(1)
    // A preview not shorter than the size throws as the file runs: nothing of the layer is made.
    expect(() => evaluateStatements(memoryBodyOf(DEFAULT_MEMORY.replace("previewTokens: 40", "previewTokens: 400")), "flatMemory", names))
      .toThrow("a preview of 400 tokens is not shorter than the results it stands for, those over 150 tokens: give pointers a previewTokens below overTokens")
  })

  test("the article is sent as its start and a pointer, the model reads on, and every later prompt starts with the one before", async () => {
    const result = await tell(write("points"))
    expect(result.shown.errors).toEqual([])
    expect(result.shown.replies).toEqual(["Tides rise and fall twice a day.", "You are welcome."])
    expect(result.calls).toHaveLength(4)
    // The second call of the first turn: the start of the article and where to read on, not the article.
    expect(result.calls[1]).toEqual([
      { role: "system", text: SYSTEM },
      { role: "user", text: "Look up tides." },
      { role: "assistant", text: 'lookup({"topic":"tides"})' },
      { role: "tool", text: `→ ${JSON.stringify(POINTER)}` },
    ])
    // The third: the same four messages, then the call that read on and the part it returned, as it is stored.
    expect(result.calls[2]).toEqual([
      ...result.calls[1]!,
      { role: "assistant", text: 'readResult({"result":4,"from":160,"length":400})' },
      { role: "tool", text: `→ ${JSON.stringify({ text: tides.slice(160, 560), from: 160, to: 560, total: 2347 })}` },
    ])
    // The next turn: everything the turn before was sent, its answer, and the new message. The pointer is the same text.
    expect(result.calls[3]).toEqual([
      ...result.calls[2]!,
      { role: "assistant", text: "Tides rise and fall twice a day." },
      { role: "user", text: "Thanks." },
    ])
    // No prompt holds the article past its first 160 characters, but for the part the model asked for.
    expect(result.calls.flat().some((message) => message.text.includes(JSON.stringify(tides.slice(560, 700)).slice(1, -1)))).toBe(false)
  })

  test("read with messageOf again, the same turns send the whole article in every prompt after the lookup", async () => {
    const result = await tell(write("whole", Option.getOrThrow(noPointers(DEFAULT_MEMORY))))
    expect(result.calls[1]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify(tides)}` })
    expect(result.calls[3]?.[3]).toEqual({ role: "tool", text: `→ ${JSON.stringify(tides)}` })
    // There is no pointer at place 4, but the result is there: readResult reads a part of any stored result.
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify({ text: tides.slice(160, 560), from: 160, to: 560, total: 2347 })}` })
  })

  test("pointing only older turns, the open turn is sent the article whole and the next turn its pointer: the prompt's start changes", async () => {
    const result = await tell(write("older", Option.getOrThrow(olderTurns(DEFAULT_MEMORY))))
    expect(result.calls[1]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify(tides)}` })
    expect(result.calls[2]?.slice(0, 4)).toEqual([...result.calls[1]!])
    // The next turn: the same record, now sent as its pointer. The prompt no longer starts with the one before.
    expect(result.calls[3]?.[3]).toEqual({ role: "tool", text: `→ ${JSON.stringify(POINTER)}` })
    expect(result.calls[3]?.slice(0, 4)).not.toEqual([...result.calls[1]!])
  })

  test("without ReadResult in the toolkit, a model that follows the pointer calls a tool the program does not have, and reads a failure", async () => {
    const result = await tell(write("no-tool", DEFAULT_MEMORY, Option.getOrThrow(noReadResult(DEFAULT_TOOLS))))
    expect(result.calls[1]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify(POINTER)}` })
    const answer = result.calls[2]?.at(-1)
    expect(answer?.role).toBe("tool")
    expect(answer?.text).toContain("failed: ")
    expect(answer?.text).toContain("Tool 'readResult' not found. Available tools: lookup")
    expect(answer?.text).not.toContain(JSON.stringify(tides.slice(160, 560)).slice(1, -1))
  })

  test("one call of readResult reads at most 2000 characters, whatever length is asked", async () => {
    const result = await Effect.runPromise(runMain(write("page"), ["Look up tides."], [
      story[0]!,
      { _tag: "Calls", pieces: [], calls: [{ name: "readResult", params: { result: 4, from: 0, length: 5000 } }] },
      { _tag: "Answers", pieces: ["Tides."] },
    ]))
    expect(result.calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify({ text: tides.slice(0, 2000), from: 0, to: 2000, total: 2347 })}` })
  })

  test("a topic there is no article on is a failure the model reads, naming the three there are", async () => {
    const result = await Effect.runPromise(runMain(write("unknown"), ["Look up wolves."], [
      { _tag: "Calls", pieces: [], calls: [{ name: "lookup", params: { topic: "wolves" } }] },
      { _tag: "Answers", pieces: ["I have no article on wolves."] },
    ]))
    expect(result.calls[1]?.at(-1)?.text).toContain('No article on \\"wolves\\". The topics are tides, volcanoes and honeybees.')
    expect(result.shown.replies).toEqual(["I have no article on wolves."])
  })

  test("the three articles are long, and each line of the shown files that Format would wrap fits 100 columns", () => {
    expect(Object.entries(articles).map(([topic, text]) => [topic, text.length, text.split("\n\n").length])).toEqual([["tides", 2347, 6], ["volcanoes", 2396, 6], ["honeybees", 2336, 6]])
    expect(DEFAULT_TOOLS.split("\n").filter((line) => line.length > 100)).toEqual([])
    // memory.ts's new lines fit too; lesson 2's own comments, which Format leaves as they are, are longer.
    expect([RULE, NEW_COMMENT, ...REPLACED.map(([, to]) => to)].flatMap((text) => text.split("\n")).filter((line) => line.length > 100)).toEqual([])
  })

  test("type-checks as TypeScript, all four files, as shown and as each experiment leaves them", () => {
    write("typed")
    write("typed-whole", Option.getOrThrow(noPointers(DEFAULT_MEMORY)))
    write("typed-older", Option.getOrThrow(olderTurns(DEFAULT_MEMORY)))
    write("typed-no-tool", DEFAULT_MEMORY, Option.getOrThrow(noReadResult(DEFAULT_TOOLS)))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
