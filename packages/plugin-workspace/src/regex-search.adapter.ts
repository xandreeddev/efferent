import { Worker } from "node:worker_threads"
import { Deferred, Duration, Effect, Exit, Result, Schema, Semaphore } from "effect"
import type { Failure } from "@xandreed/core"
import { LineHits } from "./text-search.entity.js"
import { plausibleHits } from "./text-search.entity.functions.js"

/**
 * The worker's whole program: `matchingLines` over the lines it is sent,
 * with the pattern compiled once from `workerData`. It imports nothing but
 * `node:worker_threads`, so it starts in milliseconds and needs no module
 * file beside the adapter (a bundled or compiled host has none). It posts
 * `ready` once it listens.
 */
export const matcherScript = `
import { parentPort, workerData } from "node:worker_threads"
const pattern = new RegExp(workerData.source, workerData.flags)
parentPort.on("message", ({ lines, cap }) => {
  const found = []
  let capped = false
  for (let at = 0; at < lines.length && !capped; at++) {
    if (!pattern.test(lines[at])) continue
    if (found.length >= cap) capped = true
    else found.push(at)
  }
  parentPort.postMessage({ found, capped })
})
parentPort.postMessage("ready")
`

/** How many regex workers the process runs at once, whatever its hosts and sessions. */
export const REGEX_WORKERS = 4

/**
 * The process's regex worker slots, one per worker while it runs. A module's
 * own, so every grep tool of every host in the process shares the bound.
 */
const workerSlots = Semaphore.makeUnsafe(REGEX_WORKERS)

/** How long a worker may take to start before the grep fails; the grep's deadline is not charged for it. */
const START_MS = 10_000

/** A worker that stopped: the failure a search returns, and what Node or Bun said, for the log. */
interface Stopped {
  readonly failure: Failure
  readonly cause: unknown
}

const searchFailed = (message: string): Failure => ({ error: "SearchFailed", message })
const logged = (stopped: Stopped) => Effect.logWarning(stopped.failure.message, stopped.cause)

/** One file's cut lines against the grep's pattern: the indices of at most `cap` matching lines. */
export type RegexSearch = (lines: ReadonlyArray<string>, cap: number) => Effect.Effect<LineHits, Failure>

/**
 * One scoped worker per grep, opened at its first file to search and
 * returned once it has started; one file at a time. At most
 * `REGEX_WORKERS` run in the process at once: an open waits for a slot (up
 * to `START_MS`, then fails with `SearchFailed`), and the grep's deadline
 * is not charged for that wait either. Termination interrupts
 * native regexp backtracking. The worker's `error` and `exit` are heard for
 * its whole life, so a worker that fails or dies (between files too) fails
 * the next search at once with what happened, and never the host process.
 * `script` replaces the worker's program in tests.
 */
export const openRegexSearch = Effect.fn("workspace.regex.open")(function* (pattern: RegExp, script: string = matcherScript) {
  const stopped = yield* Deferred.make<never, Stopped>()
  const ready = yield* Deferred.make<void>()
  const stop = (message: string) => (cause: unknown) => { Deferred.doneUnsafe(stopped, Exit.fail({ failure: searchFailed(message), cause })) }
  const failed = Deferred.await(stopped).pipe(Effect.tapError(logged), Effect.mapError((stopped) => stopped.failure))
  // A slot for the worker's whole life, released with the scope; a wait interrupted takes none.
  yield* Effect.uninterruptibleMask((restore) => restore(Semaphore.take(workerSlots, 1).pipe(
    Effect.timeoutOrElse({ duration: Duration.millis(START_MS), orElse: () => Effect.fail(searchFailed(`no regular expression worker was free within ${START_MS / 1000} s`)) }),
  )).pipe(Effect.andThen(Effect.addFinalizer(() => Semaphore.release(workerSlots, 1)))))
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const worker = new Worker(script, { eval: true, workerData: { source: pattern.source, flags: pattern.flags } })
        worker.on("error", stop("the regular expression worker failed"))
        worker.on("exit", stop("the regular expression worker exited before answering"))
        worker.once("message", () => { Deferred.doneUnsafe(ready, Exit.void) })
        return worker
      },
      catch: (cause): Stopped => ({ failure: searchFailed("the regular expression worker could not start"), cause }),
    }).pipe(Effect.tapError(logged), Effect.mapError((stopped) => stopped.failure)),
    (worker) => Effect.tryPromise(() => worker.terminate()).pipe(Effect.ignore({ log: "Warn", message: "regex worker termination failed" })),
  )
  yield* Deferred.await(ready).pipe(
    Effect.raceFirst(failed),
    Effect.timeoutOrElse({ duration: Duration.millis(START_MS), orElse: () => Effect.fail(searchFailed(`the regular expression worker did not start within ${START_MS / 1000} s`)) }),
  )
  const answer = (lines: ReadonlyArray<string>, cap: number) => Effect.callback<unknown, Failure>((resume) => {
    const heard = (value: unknown) => resume(Effect.succeed(value))
    worker.once("message", heard)
    if (Result.isFailure(Result.try(() => worker.postMessage({ lines, cap })))) resume(Effect.fail(searchFailed("the regular expression worker could not be sent the file")))
    return Effect.sync(() => { worker.off("message", heard) })
  })
  const search: RegexSearch = (lines, cap) => Deferred.isDone(stopped).pipe(
    Effect.flatMap((done) => done ? failed : answer(lines, cap).pipe(Effect.raceFirst(failed))),
    Effect.flatMap((value) => Schema.decodeUnknownEffect(LineHits)(value).pipe(
      Effect.filterOrFail((hits) => plausibleHits(hits, lines.length, cap)),
      Effect.mapError((): Failure => searchFailed("the regular expression worker returned an invalid result")),
    )),
  )
  return search
})
