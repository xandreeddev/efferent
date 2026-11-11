// Small open models on the CPU (WebAssembly), for machines with no usable GPU.
// Transformers.js runs in a worker (cpu-worker.ts) so the page stays responsive;
// this module is the main-thread side: it loads, streams, and stops.
import { Effect } from "effect"
import type { ChatMessage } from "../prompt-map.ts"
import { settledParts, toChatMessages, usageOf } from "../prompt-map.ts"
import { makeBrowserModel } from "./make.ts"
import { aiError, modelStream } from "./stream.ts"
import type { LoadedModel, LoadProgress, ModelChoice } from "./types.ts"

export const cpuChoices: ReadonlyArray<ModelChoice> = [
  { id: "cpu-smollm2-135m", kind: "cpu", label: "SmolLM2 135M (CPU)", memoryMB: 0, downloadMB: 136, contextTokens: 2048,
    blurb: "Runs on any computer, no GPU. Quick, but very small: expect odd answers.",
    cpu: { id: "onnx-community/SmolLM2-135M-Instruct-ONNX", dtype: "q8" } },
  { id: "cpu-smollm2-360m", kind: "cpu", label: "SmolLM2 360M (CPU)", memoryMB: 0, downloadMB: 363, contextTokens: 2048,
    blurb: "Runs on any computer, no GPU. Slower, noticeably better answers.",
    cpu: { id: "onnx-community/SmolLM2-360M-Instruct-ONNX", dtype: "q8" } },
]

/** The slice of a Worker this adapter uses (a fake in tests). */
export interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}

type FromWorker =
  | { type: "progress"; progress: { status?: string; file?: string; loaded?: number; total?: number } }
  | { type: "ready" }
  | { type: "token"; id?: number; text: string }
  | { type: "done"; id?: number; tokens: number }
  | { type: "error"; id?: number; message: string }

const MAX_NEW_TOKENS = 256

export const loadCpu = (
  choice: ModelChoice,
  onProgress: (progress: LoadProgress) => void,
  makeWorker: () => WorkerLike = () => new Worker(new URL("./cpu-worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
): Promise<LoadedModel> => {
  const spec = choice.cpu
  if (spec === undefined) return Promise.reject(new Error(`${choice.id} is not a CPU model`))
  const worker = makeWorker()
  let handler: ((message: FromWorker) => void) | undefined
  worker.onmessage = (event) => handler?.(event.data as FromWorker)

  return new Promise<LoadedModel>((resolve, reject) => {
    const files = new Map<string, { loaded: number; total: number }>()
    handler = (message) => {
      if (message.type === "progress" && message.progress.status === "progress" && message.progress.file !== undefined) {
        files.set(message.progress.file, { loaded: message.progress.loaded ?? 0, total: message.progress.total ?? 0 })
        const all = [...files.values()]
        const total = all.reduce((sum, file) => sum + file.total, 0)
        const loaded = all.reduce((sum, file) => sum + file.loaded, 0)
        if (total > 0) onProgress({ fraction: loaded / total, text: `Downloading ${choice.label}: ${Math.round((loaded / total) * 100)}% of ${(total / 1e6).toFixed(0)} MB` })
      } else if (message.type === "ready") {
        handler = undefined
        resolve(wrap(choice, worker))
      } else if (message.type === "error") {
        worker.terminate()
        reject(new Error(message.message))
      }
    }
    worker.postMessage({ type: "load", id: spec.id, dtype: spec.dtype })
  })
}

const wrap = (choice: ModelChoice, worker: WorkerLike): LoadedModel => {
  // Each request has an id; replies carry it, so a stale reply (an interrupted
  // request finishing late) never reaches a newer request.
  let nextId = 0
  const handlers = new Map<number, (message: FromWorker) => void>()
  worker.onmessage = (event) => {
    const message = event.data as FromWorker
    if ("id" in message && message.id !== undefined) handlers.get(message.id)?.(message)
  }
  const generate = (messages: ReadonlyArray<ChatMessage>, on: (message: FromWorker) => void): number => {
    const id = ++nextId
    handlers.set(id, (message) => {
      on(message)
      if (message.type === "done" || message.type === "error") handlers.delete(id)
    })
    worker.postMessage({ type: "generate", id, messages, maxNewTokens: MAX_NEW_TOKENS })
    return id
  }
  const interruptRequest = (id: number) => worker.postMessage({ type: "interrupt", id })

  const model = makeBrowserModel({
    generateText: (options) => Effect.tryPromise({
      try: () => new Promise<never>((resolve, reject) => {
        const messages = toChatMessages(options.prompt)
        let reply = ""
        generate(messages, (message) => {
          if (message.type === "token") reply += message.text
          else if (message.type === "done") resolve(settledParts(reply, usageOf(messages, reply)) as never)
          else if (message.type === "error") reject(new Error(message.message))
        })
      }),
      catch: (error) => aiError("CpuModel", "generateText", error),
    }),
    streamText: (options) => {
      const messages = toChatMessages(options.prompt)
      return modelStream("CpuModel", (sink) => {
        let reply = ""
        let finished = false
        const id = generate(messages, (message) => {
          if (message.type === "token") { reply += message.text; sink.push(message.text) }
          else if (message.type === "done") { finished = true; sink.end(usageOf(messages, reply)) }
          else if (message.type === "error") { finished = true; sink.fail(new Error(message.message)) }
        })
        return () => { if (!finished) interruptRequest(id) }
      }) as never
    },
  })
  // The Stop button: interrupt the latest request.
  return { choice, model, interrupt: () => interruptRequest(nextId), dispose: () => worker.terminate() }
}
