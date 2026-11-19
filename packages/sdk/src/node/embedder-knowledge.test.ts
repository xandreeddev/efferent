// `withKnowledgeByMeaning` over the OpenAI-compatible embedder (a fake `fetch` shaped like the `/embeddings` wire) and
// `inMemoryVectors`, in a host's turn of several steps: how many requests a turn sends, a later batch that fails, and
// an embedder refused by the ledger or by its provider falling back to words, said in the event and in one warning.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Redacted, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, kernel, ModelSpend, modelSpendMemory, Sessions, userMessage } from "@xandreed/core"
import type { StoredDraft } from "@xandreed/core"
import {
  callTool, flatMemory, inMemoryVectors, inProcessJournal, knowledgeRecalledEvent, knowledgeSession, Memory, modelAnswer, scriptedModel, sessions, withKnowledgeByMeaning,
} from "../index.js"
import type { KnowledgeRecalledData, ModelScript } from "../index.js"
import { FetchHttpClient } from "effect/http"
import { entity, memory, noon, parts, source } from "../contracts/knowledge/knowledge.testing.js"
import { openAiCompatibleEmbedder } from "./index.js"
import type { SpendOptions } from "./index.js"

const MODEL = "openai/text-embedding-3-small"
const priced: SpendOptions = { prices: { [MODEL]: { input: 0.02, output: 0 } } }
const english = { speaker: ["i", "me", "my"], stopWords: ["who", "a", "where", "does", "do", "is", "in", "the", "what"] }

/** Forty memories about Ana: two calls of passages (32 and 8). */
const FORTY: ReadonlyArray<StoredDraft> = [
  source("s1", parts(["user", "Day one."]), { at: noon("2026-11-10") }),
  entity("n2", "Ana Silva"),
  ...Array.from({ length: 40 }, (_, at) => memory(`m${at + 1}`, `Ana Silva said thing ${at + 1}.`, ["n2"])),
]

interface Sent { readonly as: "query" | "passage"; readonly count: number }

/**
 * A `fetch` shaped like the wire, prefixes telling a query from a passage: a vector made from each text's letters. It
 * keeps what each request asked, and answers request `n` (from 1) with `refusing(n)` when that gives a response.
 */
const embeddingsFetch = (refusing: (n: number) => Response | undefined = () => undefined) => {
  const sent: Array<Sent> = []
  const fetch = Object.assign(async (_: RequestInfo | URL, init?: RequestInit) => {
    const { input } = JSON.parse(await new Response(init?.body ?? "").text()) as { readonly input: ReadonlyArray<string> }
    sent.push({ as: input[0]?.startsWith("query: ") ? "query" : "passage", count: input.length })
    const refusal = refusing(sent.length)
    if (refusal !== undefined) return refusal
    const data = input.map((text, index) => ({ index, embedding: Array.from({ length: 16 }, (_, at) => 1 + ([...text].filter((__, i) => i % 16 === at).reduce((sum, letter) => sum + (letter.codePointAt(0) ?? 0), 0) % 89)) }))
    return Response.json({ data, usage: { prompt_tokens: input.join("").length } })
  }, { preconnect: () => {} })
  return { fetch, sent }
}

const Lookup = Tool.make("lookup", { description: "Look something up.", parameters: Schema.Struct({ what: Schema.String }), success: Schema.String })
const tools = Toolkit.make(Lookup)
const toolsLive = tools.toLayer({ lookup: ({ what }) => Effect.succeed(`nothing more on ${what}`) })

/** A host's turn: the model asks a tool, then answers; memory builds a context at each step. */
const turnOf = (question: string) => Effect.gen(function* () {
  const all = yield* Sessions
  const toolkit = yield* tools
  const id = yield* all.create({ owner: "host" })
  return yield* all.turn(id, (session) => Effect.gen(function* () {
    yield* session.append(userMessage(question))
    for (let step = 0; step < 3; step++) {
      const context = yield* (yield* Memory).context(session)
      const answer = yield* modelAnswer(LanguageModel.streamText({
        prompt: Prompt.make([{ role: "system", content: "Answer." }, ...context]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred",
      }), session)
      if (answer.toolCalls.length === 0) return answer.text
      for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
    }
    return "stopped"
  }))
})

const script = (turns: number): ModelScript => Array.from({ length: turns }, () => [
  { _tag: "Calls" as const, pieces: [], calls: [{ name: "lookup", params: { what: "Ana" } }] },
  { _tag: "Answers" as const, pieces: ["Done."] },
]).flat()

/** Run `turns` turns over the forty memories, the embedder over `fetch`: what recall said, the ledger, what was logged. */
const run = (fetch: ReturnType<typeof embeddingsFetch>["fetch"], questions: ReadonlyArray<string>, spend: SpendOptions = priced) => {
  const heard: Array<KnowledgeRecalledData> = []
  const warnings: Array<string> = []
  const listen = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(knowledgeRecalledEvent, (event) => Effect.sync(() => { heard.push(event.data) }), { wait: true, name: "heard" })))
  const embedder = openAiCompatibleEmbedder({ model: MODEL, baseUrl: "https://gateway.test/v1", apiKey: Redacted.make("test-key"), prefixes: { query: "query: ", passage: "passage: " }, spend })
  const base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model } = yield* scriptedModel(script(questions.length))
    return yield* Effect.gen(function* () {
      const all = yield* Sessions
      const knowledge = yield* knowledgeSession
      yield* all.turn(knowledge, (open) => Effect.forEach(FORTY, (record) => open.append(record), { concurrency: 1, discard: true }))
      const replies = yield* Effect.forEach(questions, turnOf, { concurrency: 1 })
      return { replies, totals: yield* (yield* ModelSpend).totals }
    }).pipe(Effect.provide(Layer.mergeAll(withKnowledgeByMeaning({ limit: 3, walk: 0, ...english })(flatMemory), listen, toolsLive, model).pipe(
      Layer.provideMerge(Layer.mergeAll(base, embedder.pipe(Layer.provideMerge(modelSpendMemory)), inMemoryVectors())),
    )))
  })).pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(Logger.layer([Logger.make((options) => { if (options.logLevel === "Warn") warnings.push([options.message].flat().join(" ")) })])),
  )).then((done) => ({ ...done, heard, warnings }))
}

const refused = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

describe("recall by meaning over the OpenAI-compatible embedder", () => {
  test("a turn of two steps embeds the passages once and the last message once; the next turn embeds its own message, the same words included", async () => {
    const { fetch, sent } = embeddingsFetch()
    const done = await run(fetch, ["Where does Ana Silva work?", "Where does Ana Silva work?"])
    expect(done.replies).toEqual(["Done.", "Done."])
    expect(sent).toEqual([
      // The first turn's first step: the forty passages, 32 and 8 a call, then the message.
      { as: "passage", count: 32 }, { as: "passage", count: 8 }, { as: "query", count: 1 },
      // Its second step asks with the same message: nothing is embedded. The next turn's message is its own.
      { as: "query", count: 1 },
    ])
    expect(done.heard.map((one) => one.meaning?.skipped ?? null)).toEqual([null, null, null, null])
    expect(done.warnings).toEqual([])
  })

  test("a later batch of passages that fails leaves the batches before it stored: the next request embeds only what is missing", async () => {
    const { fetch, sent } = embeddingsFetch((n) => (n === 2 ? refused(500, "the model is down") : undefined))
    const done = await run(fetch, ["Where does Ana Silva work?"])
    expect(sent).toEqual([
      { as: "passage", count: 32 }, { as: "passage", count: 8 },
      // The second step: the 32 are stored, the 8 asked again, then the message.
      { as: "passage", count: 8 }, { as: "query", count: 1 },
    ])
    expect(done.heard.map((one) => one.meaning?.skipped ?? null)).toEqual([`The texts were not embedded by ${MODEL} prefixes=["query: ","passage: "]: the model is down`, null])
  })

  test("an embedder the ledger refuses, and one its provider refuses, fall back to words; the event says why, and a warning is logged once for each reason", async () => {
    const capped = embeddingsFetch()
    const overCap = await run(capped.fetch, ["Where does Ana Silva work?", "Who is Ana Silva?"], { ...priced, caps: { total: 0.000000001 } })
    // Nothing is sent; the memories about Ana Silva, named in the message, are sent all the same, found by words.
    expect(capped.sent).toEqual([])
    expect(overCap.totals).toEqual({ settled: 0, reserved: 0 })
    expect(overCap.heard.map((one) => [one.meaning?.skipped?.includes("the total model spend cap") ?? false, one.sent.length > 0])).toEqual([[true, true], [true, true], [true, true], [true, true]])
    expect(overCap.warnings).toHaveLength(1)
    expect(overCap.warnings[0]).toStartWith(`recall by meaning is skipped: the embedder ${MODEL} prefixes=["query: ","passage: "] failed, so memories are found by their words alone until it works (ModelSpendExceeded)`)

    const unauthorized = embeddingsFetch(() => refused(401, "Invalid API key"))
    const wrongKey = await run(unauthorized.fetch, ["Where does Ana Silva work?", "Who is Ana Silva?"])
    expect(wrongKey.heard.map((one) => [one.meaning?.skipped ?? null, one.sent.length > 0])).toEqual(Array.from({ length: 4 }, () => [`The texts were not embedded by ${MODEL} prefixes=["query: ","passage: "]: Invalid API key`, true]))
    expect(wrongKey.warnings).toEqual([`recall by meaning is skipped: the embedder ${MODEL} prefixes=["query: ","passage: "] failed, so memories are found by their words alone until it works (AiError/AuthenticationError)`])
    // Each context asks again: a key fixed meanwhile is used at once.
    expect(unauthorized.sent.length).toBe(4)
  })

  test("a warning is said once for each reason a layer meets: a refused key and a provider that is down, met in turn, give two", async () => {
    const { fetch } = embeddingsFetch((n) => (n % 2 === 1 ? refused(401, "Invalid API key") : refused(500, "the model is down")))
    const done = await run(fetch, ["Where does Ana Silva work?", "Who is Ana Silva?"])
    expect(done.heard.map((one) => one.meaning?.skipped?.endsWith("Invalid API key") ?? false)).toEqual([true, false, true, false])
    expect(done.warnings.map((warning) => warning.slice(warning.lastIndexOf("(")))).toEqual(["(AiError/AuthenticationError)", "(AiError/InternalProviderError)"])
  })
})
