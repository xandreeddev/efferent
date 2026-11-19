import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, kernel, messageOf, readJournal, Sessions, userMessage, vocabularyOf } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"
import { callTool, estimateContext, inProcessJournal, Memory, messageText, modelAnswer, paired, pointed, promptMessage, ReadResult, readResult, scriptedModel, sessions, Summarizer, summaryMemory, webStorageJournal, windowMemory } from "./index.js"
import type { KeyValueStore, ModelScript } from "./index.js"

/*
 * Pointers (ADR 0011), as a test: a tool returns a long result, the journal
 * keeps it whole, and the model is sent its start and a pointer, in this
 * prompt and every later one. The model reads on with `readResult`.
 * `docs/kernel.md` quotes the memory, the tools and the turn's story.
 */

/** A long text with a line a reader can tell from the next: forty lines, 1,310 characters. */
const article = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the article on tides.`).join("\n")

// #region memory
// A flat memory that points: every message of the conversation, a long tool result as its start and a pointer.
// `pointed` gives the function that reads a record's message, in place of `messageOf`.
const sent = pointed({ overTokens: 100, previewTokens: 20 })
const pointingMemory = Layer.succeed(Memory, Memory.of({
  context: (session) => Effect.gen(function* () {
    const conversation = yield* Effect.fromResult(readJournal(vocabularyOf("flat", [], CONVERSATION_VOCABULARY))(yield* session.journal))
    return paired(conversation.flatMap((record) => Option.toArray(sent(record)))).map(promptMessage)
  }),
}))
// #endregion memory

// #region tools
// A tool with a long answer, and the kernel's tool that reads on from a pointer, with its handler.
const Lookup = Tool.make("lookup", { description: "Look up an article.", parameters: Schema.Struct({ topic: Schema.String }), success: Schema.String })
const tools = Toolkit.make(Lookup, ReadResult)
const toolsLive = tools.toLayer({ lookup: () => Effect.succeed(article), readResult })
// #endregion tools

const SYSTEM = "Use a tool when it helps."

/** A host's turn with tools over the stack it is given: what the model was sent, call by call, and the journal. */
const run = (script: ModelScript, messages: ReadonlyArray<string>) => Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel(script)
  const sizes = yield* Ref.make<ReadonlyArray<number>>([])
  const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
    const memory = yield* Memory
    const language = yield* LanguageModel.LanguageModel
    const toolkit = yield* tools
    const session = yield* (yield* Sessions).open(conversation)
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 4; step++) {
      const history = yield* memory.context(session)
      yield* Ref.update(sizes, (all) => [...all, Number(estimateContext(history))])
      const answer = yield* modelAnswer(language.streamText({ prompt: Prompt.make([{ role: "system", content: SYSTEM }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
      if (answer.toolCalls.length === 0) return answer.text
      for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
    }
    return "stopped"
  }))
  const journal = yield* Effect.gen(function* () {
    const all = yield* Sessions
    const conversation = yield* all.create({ owner: "test" })
    yield* Effect.forEach(messages, (message) => turn(conversation, message), { concurrency: 1, discard: true })
    return (yield* all.read(conversation)).events
  }).pipe(Effect.provide(Layer.merge(model, toolsLive)))
  return { calls: yield* calls, journal, sizes: yield* Ref.get(sizes) }
})

const base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
const over = (memory: Layer.Layer<Memory>) => Layer.mergeAll(memory, base)

/** The script of the story: look the article up, read on from the pointer, answer; then a second turn. */
const story: ModelScript = [
  { _tag: "Calls", pieces: [], calls: [{ name: "lookup", params: { topic: "tides" } }] },
  { _tag: "Calls", pieces: [], calls: [{ name: "readResult", params: { result: 4, from: 80, length: 120 } }] },
  { _tag: "Answers", pieces: ["Tides."] },
  { _tag: "Answers", pieces: ["You are welcome."] },
]

describe("pointers", () => {
  test("a long result is stored whole and sent as its start and a pointer; the model reads on, and every later prompt starts the same way", async () => {
    // #region read
    const { calls, journal } = await Effect.runPromise(run(story, ["Tell me about tides.", "Thanks."]).pipe(Effect.provide(over(pointingMemory))))

    // The journal keeps the article whole, at place 4, and the page the model read, marked whole by its tool.
    const results = journal.flatMap((record) => Option.toArray(messageOf(record))).filter((message) => message._tag === "ToolResult")
    expect<unknown>(results).toEqual([
      { _tag: "ToolResult", id: "call-1-1", name: "lookup", result: article, isFailure: false },
      { _tag: "ToolResult", id: "call-2-1", name: "readResult", result: { text: article.slice(80, 200), from: 80, to: 200, total: 1310 }, isFailure: false, whole: true },
    ])

    // The model's second call is sent the start of the article and where to read on, not the article.
    const pointer = "<tool-result-preview>\nLine 1 of the article on tides.\nLine 2 of the article on tides.\nLine 3 of the ar\n</tool-result-preview>\n[Host note: the result above is cut short: it is 1310 characters long and its first 80 are shown. To read on, call readResult with result 4 and from 80.]"
    expect(calls[1]).toEqual([
      { role: "system", text: SYSTEM },
      { role: "user", text: "Tell me about tides." },
      { role: "assistant", text: "lookup({\"topic\":\"tides\"})" },
      { role: "tool", text: `→ ${JSON.stringify(pointer)}` },
    ])
    // Each later prompt starts with the one before it: the pointer is the same text every time.
    expect(calls[2]?.slice(0, 4)).toEqual([...calls[1]!])
    expect(calls[3]?.slice(0, calls[2]!.length)).toEqual([...calls[2]!])
    // The page it asked for is sent as it is stored.
    expect(calls[2]?.at(-1)).toEqual({ role: "tool", text: `→ ${JSON.stringify({ text: article.slice(80, 200), from: 80, to: 200, total: 1310 })}` })
    // #endregion read
  })

  test("a stock memory given pointers counts what it sends: the article alone is over the budget, its pointer is not", async () => {
    // The article is 328 tokens by memory's estimate, the budget 200.
    const turns = (memory: Layer.Layer<Memory, unknown>) => Effect.runPromise(Effect.result(run(story, ["Tell me about tides."]).pipe(Effect.provide(over(Layer.orDie(memory))))))
    expect(await turns(windowMemory({ budgetTokens: 200 }))).toMatchObject({ _tag: "Failure", failure: { _tag: "OverBudget", estimatedTokens: 349, budgetTokens: 200 } })
    const pointing = await turns(windowMemory({ budgetTokens: 200, pointers: { overTokens: 100, previewTokens: 20 } }))
    expect(pointing).toMatchObject({ _tag: "Success", success: { sizes: [5, 83, 137] } })
  })

  test("the summary memory given pointers hands its summarizer what the model was sent: the pointer, never the article", async () => {
    const folded: Array<string> = []
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({
      summarize: ({ messages }) => Effect.sync(() => { folded.push(...messages.map(messageText)); return "They asked about tides." }),
    }))
    const memory = Layer.provide(summaryMemory({ budgetTokens: 180, keepTurns: 0, pointers: { overTokens: 100, previewTokens: 20 } }), summarizer)
    const filler = "And what moves the water, the moon or the sun, and how far? ".repeat(3)
    await Effect.runPromise(run(story, ["Tell me about tides.", filler]).pipe(Effect.provide(over(Layer.orDie(memory)))))
    expect(folded.length).toBeGreaterThan(0)
    expect(folded.some((text) => text.includes("<tool-result-preview>") && text.includes("call readResult with result 4 and from 80"))).toBe(true)
    expect(folded.some((text) => text.includes("Line 40 of the article"))).toBe(false)
  })

  test("a result marked whole is still marked when a store that writes text reads it back", async () => {
    // The browser's storage as a value: strings by key. The journal over it encodes each record and decodes it again.
    const values = new Map<string, string>()
    const storage: KeyValueStore = {
      get length() { return values.size },
      key: (index) => Array.from(values.keys())[index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    }
    const durable = () => sessions().pipe(Layer.provideMerge(webStorageJournal(storage, { prefix: "agent:" })), Layer.provideMerge(kernel()))
    const { journal } = await Effect.runPromise(run(story, ["Tell me about tides."]).pipe(Effect.provide(Layer.mergeAll(pointingMemory, durable()))))
    // A second handle on the same storage: what it reads is what was written as text.
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const [header] = yield* all.list
      return (yield* all.read(header!.id)).events
    }).pipe(Effect.provide(durable())))
    const marks = (events: typeof journal) => events.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [[message.name, message.whole]] : []))
    expect(marks(reopened)).toEqual([["lookup", undefined], ["readResult", true]])
    expect(reopened).toEqual([...journal])
  })

  test("without pointers the same turns send the article in every prompt after the lookup", async () => {
    const flat = Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.gen(function* () {
        const conversation = yield* Effect.fromResult(readJournal(vocabularyOf("flat", [], CONVERSATION_VOCABULARY))(yield* session.journal))
        return paired(conversation.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage)
      }),
    }))
    const whole = await Effect.runPromise(run(story, ["Tell me about tides.", "Thanks."]).pipe(Effect.provide(over(flat))))
    const pointing = await Effect.runPromise(run(story, ["Tell me about tides.", "Thanks."]).pipe(Effect.provide(over(pointingMemory))))
    // What each of the four contexts costs, by memory's estimate: sent whole, the article is in each from the second on.
    expect(whole.sizes).toEqual([5, 349, 403, 407])
    expect(pointing.sizes).toEqual([5, 83, 137, 141])
  })
})
