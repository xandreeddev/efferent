import { describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { ModelSpend, modelSpendMemory } from "@xandreed/core/kernel"
import { cosine, Embedder } from "../index.js"
import { isSpendRefusal, openAiCompatibleEmbedder } from "./index.js"

// #region embedder
const GEMINI = "google/gemini-embedding-001"

/**
 * Gemini's embedding model through the Vercel AI Gateway, its vectors cut to 768 numbers (and made unit length again).
 * Its name, which the vectors are kept under, is `google/gemini-embedding-001 dimensions=768`: vectors of another
 * length, or of another model, are never compared with these. Each request holds its texts' worst case at the input
 * price (an embedding has no output) and is settled at the tokens the gateway reported, at that price: its
 * embeddings answer says no cost.
 */
const gemini = Layer.unwrap(Effect.map(Config.Redacted("VERCEL_API_KEY"), (apiKey) => openAiCompatibleEmbedder({
  model: GEMINI,
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  apiKey,
  dimensions: 768,
  spend: { prices: { [GEMINI]: { input: 0.15, output: 0 } }, caps: { total: 0.01 } },
})))

/** The note nearest a question: the question embedded as a query, the notes as passages, compared by cosine. */
const nearest = (question: string, notes: ReadonlyArray<string>) => Effect.gen(function* () {
  const embedder = yield* Embedder
  const [asked] = yield* embedder.embed([question], "query")
  const kept = yield* embedder.embed(notes, "passage")
  const scored = notes.map((note, at) => ({ note, score: asked === undefined ? 0 : cosine(asked, kept[at] ?? []) }))
  return scored.toSorted((a, b) => b.score - a.score)[0]?.note ?? "no note"
}).pipe(Effect.catchIf(isSpendRefusal, () => Effect.succeed("The budget is spent.")))

const program = Effect.gen(function* () {
  const note = yield* nearest("Where does Ana live now?", ["Ana moved to Braga in October.", "Carla likes green tea."])
  return { note, totals: yield* (yield* ModelSpend).totals }
}).pipe(Effect.provide(gemini.pipe(Layer.provideMerge(modelSpendMemory))))
// #endregion embedder

/** A gateway that answers each request with a vector per text and the `tokens` it read, as its embeddings answer does (no cost), and counts the requests. */
const gatewayEmbedding = (tokens: number) => {
  let sent = 0
  const fetch = Object.assign(async (_: RequestInfo | URL, init?: RequestInit) => {
    sent++
    const { input, dimensions } = JSON.parse(await new Response(init?.body ?? "").text()) as { readonly input: ReadonlyArray<string>; readonly dimensions: number }
    // Two numbers that tell Ana's notes from tea's, then small ones, to the length asked for.
    const data = input.map((text, index) => ({ index, embedding: [text.includes("Ana") || text.includes("Braga") ? 30 : 0, text.includes("tea") ? 30 : 0, ...Array.from({ length: dimensions - 2 }, () => 0.01)] }))
    return Response.json({ data, usage: { prompt_tokens: tokens, total_tokens: tokens } })
  }, { preconnect: () => {} })
  return { fetch, sent: () => sent }
}
const configured = ConfigProvider.fromEnv({ env: { VERCEL_API_KEY: "test-key" } })

describe("a host's embedder through the gateway", () => {
  test("finds the note nearest a question, each request settled at the tokens the gateway reported, at the price", async () => {
    const gate = gatewayEmbedding(12)
    const run = await Effect.runPromise(program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured), Effect.provideService(FetchHttpClient.Fetch, gate.fetch)))
    expect(run).toEqual({ note: "Ana moved to Braga in October.", totals: { settled: 2 * 12 * 0.15 / 1_000_000, reserved: 0 } })
    expect(gate.sent()).toBe(2)
  })

  test("once the ledger is near its cap, the next request is refused before it is sent, and the program says so", async () => {
    // The first request read 66,600 tokens: $0.00999 of the cent; the second's worst case passes it.
    const gate = gatewayEmbedding(66_600)
    const run = await Effect.runPromise(program.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured), Effect.provideService(FetchHttpClient.Fetch, gate.fetch)))
    expect(run).toEqual({ note: "The budget is spent.", totals: { settled: 66_600 * 0.15 / 1_000_000, reserved: 0 } })
    expect(gate.sent()).toBe(1)
  })
})
