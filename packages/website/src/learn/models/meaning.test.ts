// The page's embedder on the main thread's side (lesson 20), over a fake
// worker shaped like meaning-worker.ts: the load is asked for with the
// pinned model and revision and says its progress in words; the embedder is
// the kernel's `Embedder` under the model's name, a request's reply read by
// its id; a worker's failure is `EmbedFailed` in its words; and a message
// that is none of the worker's is passed over.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EMBEDDER_MODEL, EMBEDDER_REVISION } from "../lessons/recall-by-meaning/shipped.ts"
import { loadEmbedder } from "./meaning.ts"
import type { MeaningWorker } from "./meaning.ts"

/** A worker that answers as `answer` says, and keeps what it was sent. */
const fakeWorker = (answer: (message: Record<string, unknown>, reply: (data: unknown) => void) => void) => {
  const sent: Array<Record<string, unknown>> = []
  const listeners: Array<(event: unknown) => void> = []
  const failing: Array<(event: unknown) => void> = []
  const reply = (data: unknown) => queueMicrotask(() => listeners.forEach((listener) => listener({ data })))
  // The worker failing as a whole, as a Worker's error event says it.
  const die = (message: string) => queueMicrotask(() => failing.forEach((listener) => listener({ message })))
  const worker: MeaningWorker = {
    addEventListener: (type, listener) => { (type === "error" ? failing : listeners).push(listener) },
    postMessage: (message) => {
      if (typeof message !== "object" || message === null) return
      const record = Object.fromEntries(Object.entries(message))
      sent.push(record)
      answer(record, reply)
    },
    terminate: () => {},
  }
  return { worker, sent, die }
}

describe("the page's embedder", () => {
  test("the embedder loads the pinned model, says its download in words, and answers each request by its id", async () => {
    const { worker, sent } = fakeWorker((message, reply) => {
      if (message.type === "load") {
        reply("a message that is none of the worker's")
        reply({ type: "progress", report: { status: "progress", file: "model.onnx", loaded: 17_000_000, total: 34_000_000 } })
        reply({ type: "ready" })
      } else if (message.type === "embed") reply({ type: "vectors", id: message.id, vectors: [[0.6, 0.8]] })
    })
    const said: Array<string> = []
    const embedder = await loadEmbedder((text) => said.push(text), () => worker)
    expect(sent[0]).toEqual({ type: "load", model: EMBEDDER_MODEL, revision: EMBEDDER_REVISION })
    expect(said).toEqual(["Downloading the embedder, e5-small-v2: 50% of 34 MB."])
    expect(embedder.model).toBe(EMBEDDER_MODEL)
    expect(await Effect.runPromise(embedder.embed(["Who employs Ana Silva?"], "query"))).toEqual([[0.6, 0.8]])
    expect(sent[1]).toEqual({ type: "embed", texts: ["Who employs Ana Silva?"], as: "query", id: 1 })
    // No texts: no request.
    expect(await Effect.runPromise(embedder.embed([], "passage"))).toEqual([])
    expect(sent).toHaveLength(2)
  })

  test("a worker that fails fails the load, or the call, in its words", async () => {
    const refused = fakeWorker((_message, reply) => reply({ type: "error", message: "no network" }))
    expect(await loadEmbedder(() => {}, () => refused.worker).then(() => "loaded", (error: unknown) => (error instanceof Error ? error.message : "?"))).toBe("no network")
    const failing = fakeWorker((message, reply) => {
      if (message.type === "load") reply({ type: "ready" })
      else reply({ type: "error", id: message.id, message: "out of memory" })
    })
    const embedder = await loadEmbedder(() => {}, () => failing.worker)
    const failed = await Effect.runPromise(Effect.flip(embedder.embed(["a"], "passage")))
    expect([failed._tag, failed.message]).toEqual(["EmbedFailed", "The embedder failed: out of memory"])
  })

  test("a worker that stops fails its load, every request in flight and every later one, in words: nothing waits for ever", async () => {
    const unloadable = fakeWorker((_message, _reply) => {})
    const load = loadEmbedder(() => {}, () => unloadable.worker)
    unloadable.die("Failed to fetch the worker's script")
    expect(await load.then(() => "loaded", (error: unknown) => (error instanceof Error ? error.message : "?"))).toBe("its worker stopped (Failed to fetch the worker's script). Reload the page to load it again")
    // Ready, then it dies while a request waits for its reply.
    const dying = fakeWorker((message, reply) => { if (message.type === "load") reply({ type: "ready" }) })
    const embedder = await loadEmbedder(() => {}, () => dying.worker)
    const waiting = Effect.runPromise(Effect.flip(embedder.embed(["a"], "passage")))
    dying.die("")
    const failed = await waiting
    expect([failed._tag, failed.message]).toEqual(["EmbedFailed", "The embedder failed: its worker stopped. Reload the page to load it again"])
    const later = await Effect.runPromise(Effect.flip(embedder.embed(["b"], "query")))
    expect(later.message).toBe("The embedder failed: its worker stopped. Reload the page to load it again")
    expect(dying.sent).toHaveLength(2)
  })
})
