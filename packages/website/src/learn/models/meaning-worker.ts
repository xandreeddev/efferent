/// <reference lib="webworker" />
// The embedder's worker (lesson 20): Transformers.js on WebAssembly, off the
// main thread, so the page stays responsive while a text is turned into
// numbers. It loads e5-small-v2, 8-bit, and turns each text into its vector:
// mean pooled and normalized, with the "query: " or "passage: " the model was
// trained to read first. Each text is embedded alone, in a call of its own:
// an 8-bit model scales its numbers for each batch, and the world's vectors
// the page ships were made by this worker the same way, so a text gives the
// same vector here whether it came alone or among others. Requests carry an
// id, every reply carries it back, and they run one at a time, in the order
// sent. Each message is checked as it arrives: what the page sends is held to
// its fields, never taken on trust.
import { env, pipeline } from "@huggingface/transformers"
import { indexedDbCache, needsIndexedDbCache } from "./idb-cache.ts"

// Downloads are kept for the next visit, as the CPU worker keeps its own (cpu-worker.ts).
if (needsIndexedDbCache()) {
  env.useBrowserCache = false
  env.useCustomCache = true
  env.customCache = indexedDbCache()
}

type Embed = (text: string) => Promise<ReadonlyArray<number>>

let embed: Embed | undefined
let queue: Promise<void> = Promise.resolve()

const send = (message: unknown) => postMessage(message)
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null
const isStrings = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value) && value.every((one) => typeof one === "string")
const numbersOf = (value: unknown): ReadonlyArray<number> => {
  if (!Array.isArray(value) || !value.every((one) => typeof one === "number")) throw new Error("the model gave no list of numbers")
  return value
}
/** What a model's output holds under `tolist()`, read with guards: the library types it broadly. */
const listOf = (value: unknown): unknown => (isRecord(value) && typeof value.tolist === "function" ? value.tolist() : undefined)

const progress = (report: unknown) => send({ type: "progress", report })

const loadEmbedder = async (model: string, revision: string): Promise<Embed> => {
  // WebAssembly on every machine: the same numbers wherever the page runs, and the ones the shipped vectors were made with.
  const extract = await pipeline("feature-extraction", model, { dtype: "q8", device: "wasm", revision, progress_callback: progress })
  return async (text) => {
    const rows = listOf(await extract([text], { pooling: "mean", normalize: true }))
    return numbersOf(Array.isArray(rows) ? rows[0] : undefined)
  }
}

const handle = async (message: unknown): Promise<void> => {
  if (!isRecord(message)) return
  const id = typeof message.id === "number" ? message.id : undefined
  try {
    if (message.type === "load" && typeof message.model === "string" && typeof message.revision === "string") {
      embed = await loadEmbedder(message.model, message.revision)
      send({ type: "ready" })
    } else if (message.type === "embed" && id !== undefined && isStrings(message.texts) && (message.as === "query" || message.as === "passage")) {
      if (embed === undefined) throw new Error("the embedder is not loaded")
      const vectors: Array<ReadonlyArray<number>> = []
      // One text a call, whatever the batch: see the note at the top.
      for (const text of message.texts) vectors.push(await embed(`${message.as}: ${text}`))
      send({ type: "vectors", id, vectors })
    } else {
      throw new Error("the worker was sent a message it does not take")
    }
  } catch (error) {
    send({ type: "error", ...(id === undefined ? {} : { id }), message: words(error) })
  }
}

// One request at a time, in the order sent.
addEventListener("message", (event: MessageEvent<unknown>) => {
  queue = queue.then(() => handle(event.data))
})
