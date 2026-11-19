// The page's embedder (lesson 20), on the main thread's side: e5-small-v2 in
// a worker of its own (meaning-worker.ts), made when "Load the embedder" is
// pressed, as the kernel's `Embedder`. Its `model` is the name the world's
// vectors were made under, so the kernel finds them. Every message from the
// worker is decoded before it is read; a worker that fails says so in words,
// as `EmbedFailed`.
import { Context, Effect, Option, Schema } from "effect"
import { Embedder, EmbedFailed } from "@xandreed/sdk/kernel"
import { EMBEDDER_MODEL, EMBEDDER_REVISION } from "../lessons/recall-by-meaning/shipped.ts"

/** An embedder as the kernel's port holds it. */
export type EmbedderService = Context.Service.Shape<typeof Embedder>

/**
 * The slice of a Worker this adapter uses (a fake in tests): a `Worker` is one. A message event holds the worker's
 * reply in `data`; an error event is the worker failing as a whole (its script did not load, or it died), with no
 * reply to come.
 */
export interface MeaningWorker {
  addEventListener(type: "message" | "error", listener: (event: unknown) => void): void
  postMessage(message: unknown): void
  terminate(): void
}

/** What a message event holds, read with a guard: a worker's event is typed by the DOM, a fake's by its test. */
const dataOf = (event: unknown): unknown => (typeof event === "object" && event !== null && "data" in event ? event.data : undefined)

/** Why a worker failed as a whole, in words: an error event's message where it has one. */
const failureOf = (event: unknown): string =>
  typeof event === "object" && event !== null && "message" in event && typeof event.message === "string" && event.message !== ""
    ? `its worker stopped (${event.message}). Reload the page to load it again`
    : "its worker stopped. Reload the page to load it again"

const Progress = Schema.Struct({
  type: Schema.Literal("progress"),
  report: Schema.Struct({ status: Schema.optionalKey(Schema.String), file: Schema.optionalKey(Schema.String), loaded: Schema.optionalKey(Schema.Number), total: Schema.optionalKey(Schema.Number) }),
})
const FromWorker = Schema.Union([
  Progress,
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("error"), id: Schema.optionalKey(Schema.Number), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("vectors"), id: Schema.Number, vectors: Schema.Array(Schema.Array(Schema.Number)) }),
])
type FromWorker = typeof FromWorker.Type
const fromWorker = Schema.decodeUnknownOption(FromWorker)

/** A new worker of the page's own file. */
const meaningWorker = (): MeaningWorker => new Worker(new URL("./meaning-worker.ts", import.meta.url), { type: "module" })

/** What the page calls the embedder while it downloads. */
export const EMBEDDER_LABEL = "the embedder, e5-small-v2"

/**
 * A worker loaded with the embedder: it says how much of the download is done, in words, as it goes, and gives a
 * function that sends a request and waits for its reply, by the request's id.
 */
const loaded = (onProgress: (text: string) => void, makeWorker: () => MeaningWorker) =>
  new Promise<(request: Record<string, unknown>) => Promise<FromWorker>>((resolve, reject) => {
    const worker = makeWorker()
    const files = new Map<string, { readonly loaded: number; readonly total: number }>()
    const waiting = new Map<number, (reply: FromWorker) => void>()
    let ready = false
    let next = 0
    // Once the worker has failed as a whole, every request in flight and every later one is answered with its words.
    let stopped: string | undefined
    worker.addEventListener("error", (event) => {
      stopped = failureOf(event)
      worker.terminate()
      if (!ready) reject(new Error(stopped))
      for (const answer of waiting.values()) answer({ type: "error", message: stopped })
      waiting.clear()
    })
    worker.addEventListener("message", (event) => Option.map(fromWorker(dataOf(event)), (message) => {
      if (message.type === "progress") {
        const { file, status, loaded: done, total } = message.report
        if (status !== "progress" || file === undefined) return
        files.set(file, { loaded: done ?? 0, total: total ?? 0 })
        const all = [...files.values()]
        const size = all.reduce((sum, one) => sum + one.total, 0)
        const have = all.reduce((sum, one) => sum + one.loaded, 0)
        if (size > 0) onProgress(`Downloading ${EMBEDDER_LABEL}: ${Math.round((have / size) * 100)}% of ${(size / 1e6).toFixed(0)} MB.`)
      } else if (message.type === "ready" && !ready) {
        ready = true
        resolve((request) => new Promise((answer) => {
          if (stopped !== undefined) return answer({ type: "error", message: stopped })
          const id = ++next
          waiting.set(id, answer)
          worker.postMessage({ ...request, id })
        }))
      } else if (message.type === "error" && message.id === undefined && !ready) {
        worker.terminate()
        reject(new Error(message.message))
      } else if (message.type !== "ready" && message.id !== undefined) {
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      }
    }))
    worker.postMessage({ type: "load", model: EMBEDDER_MODEL, revision: EMBEDDER_REVISION })
  })

/**
 * The page's embedder: e5-small-v2 in a worker, loaded here (about 34 MB the first time, then from the browser's
 * cache), as the kernel's `Embedder`. Each text is embedded alone. A worker that fails fails the call with
 * `EmbedFailed`, in its words.
 */
export const loadEmbedder = async (onProgress: (text: string) => void, makeWorker: () => MeaningWorker = meaningWorker): Promise<EmbedderService> => {
  const ask = await loaded(onProgress, makeWorker)
  return Embedder.of({
    model: EMBEDDER_MODEL,
    embed: (texts, as) => texts.length === 0 ? Effect.succeed([]) : Effect.flatMap(
      Effect.tryPromise({ try: () => ask({ type: "embed", texts: [...texts], as }), catch: (error) => new EmbedFailed({ message: `The embedder failed: ${error instanceof Error ? error.message : String(error)}` }) }),
      (reply) => reply.type === "vectors" && reply.vectors.length === texts.length && reply.vectors.every((vector) => vector.length > 0)
        ? Effect.succeed(reply.vectors)
        : Effect.fail(new EmbedFailed({ message: `The embedder failed: ${reply.type === "error" ? reply.message : "it gave no vector for each text"}` }))),
  })
}
