import { Worker } from "node:worker_threads"
import { Effect, Schema } from "effect"
import type { Failure } from "@xandreed/core"
import { FileSearch } from "./text-search.entity.js"

const source = `
import { parentPort, workerData } from "node:worker_threads"
const { searchText } = await import(workerData.module)
const pattern = new RegExp(workerData.source, workerData.flags)
parentPort.on("message", ({ text, options }) => parentPort.postMessage(searchText(text, pattern, options)))
`

/** One scoped worker per grep, one file at a time. Termination interrupts native regexp backtracking. */
export const openRegexSearch = Effect.fn("workspace.regex.open")(function* (pattern: RegExp) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => new Worker(source, { eval: true, workerData: { module: new URL("./text-search.entity.functions.js", import.meta.url).href, source: pattern.source, flags: pattern.flags } })),
    (worker) => Effect.tryPromise(() => worker.terminate()).pipe(Effect.ignore({ log: "Warn", message: "regex worker termination failed" })),
  )
  return (text: string, options: { readonly lineChars: number; readonly context: number; readonly cap: number }) => Effect.callback<unknown, Failure>((resume) => {
    const message = (value: unknown) => resume(Effect.succeed(value))
    const error = () => resume(Effect.fail({ error: "SearchFailed", message: "the regular expression worker failed" }))
    const exit = () => resume(Effect.fail({ error: "SearchFailed", message: "the regular expression worker exited before answering" }))
    worker.once("message", message)
    worker.once("error", error)
    worker.once("exit", exit)
    worker.postMessage({ text, options })
    return Effect.sync(() => { worker.off("message", message); worker.off("error", error); worker.off("exit", exit) })
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FileSearch)), Effect.mapError((): Failure => ({ error: "SearchFailed", message: "the regular expression worker returned an invalid result" })))
})
