import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import type { Scope } from "effect"
import { openRegexSearch, REGEX_WORKERS } from "./regex-search.adapter.js"
import { matchingLines } from "./text-search.entity.functions.js"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
/** The failure of a search that must fail. */
const fails = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => run(Effect.flip(effect))
const searchFailed = (message: string) => ({ error: "SearchFailed", message })

/** A worker program that answers its first file with no hits and then exits, as a worker that crashes between files. */
const diesAfterFirst = `import { parentPort } from "node:worker_threads"
parentPort.on("message", () => { parentPort.postMessage({ found: [], capped: false }); setTimeout(() => process.exit(3), 10) })
parentPort.postMessage("ready")`
const answers = (value: string) => `import { parentPort } from "node:worker_threads"
parentPort.on("message", () => parentPort.postMessage(${value}))
parentPort.postMessage("ready")`

test("the worker matches the lines as the in-process loop does, cap and case included", async () => {
  const lines = ["Alpha", "beta", "ALPHA beta", "gamma", "alphabet", "delta alpha"]
  const found = await run(Effect.gen(function* () {
    const search = yield* openRegexSearch(/alpha/i)
    return [yield* search(lines, 10), yield* search(lines, 2), yield* search([], 3)]
  }))
  expect(found).toEqual([
    matchingLines(lines, (line) => /alpha/i.test(line), 10),
    matchingLines(lines, (line) => /alpha/i.test(line), 2),
    { found: [], capped: false },
  ])
  expect(found).toEqual([{ found: [0, 2, 4, 5], capped: false }, { found: [0, 2], capped: true }, { found: [], capped: false }])
})

test("a worker that cannot load fails the search with that reason, and the process survives", async () => {
  const exit = await fails(Effect.gen(function* () {
    const search = yield* openRegexSearch(/x/, `throw new Error("cannot load")`)
    yield* Effect.sleep("200 millis")
    return yield* search(["x"], 1)
  }))
  expect(exit).toEqual(searchFailed("the regular expression worker failed"))
}, 5000)

test("a worker that dies between files fails the next search at once with its own reason", async () => {
  const exit = await fails(Effect.gen(function* () {
    const search = yield* openRegexSearch(/x/, diesAfterFirst)
    yield* search(["x"], 1)
    yield* Effect.sleep("200 millis")
    return yield* search(["x"], 1).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.fail({ error: "Hung", message: "the search waited for a dead worker" }) }))
  }))
  expect(exit).toEqual(searchFailed("the regular expression worker exited before answering"))
}, 5000)

test("an answer that is not hits for the lines sent is an invalid result", async () => {
  for (const answer of [`"nonsense"`, `{ found: [5], capped: false }`, `{ found: [1, 0], capped: false }`, `{ found: [0, 1], capped: false }`]) {
    const exit = await fails(Effect.gen(function* () {
      const search = yield* openRegexSearch(/x/, answers(answer))
      return yield* search(["x", "x"], 1)
    }))
    expect(exit).toEqual(searchFailed("the regular expression worker returned an invalid result"))
  }
})

test("at most REGEX_WORKERS regex workers run at once in the process: one more opens only once another is closed", async () => {
  const observed = await run(Effect.gen(function* () {
    const close = yield* Deferred.make<void>()
    const opened = yield* Ref.make(0)
    // Each held open until `close`: every worker the process may run, then one more.
    const holding = (index: number) => Effect.scoped(openRegexSearch(/a/).pipe(
      Effect.andThen(Ref.update(opened, (count) => count + 1)),
      Effect.andThen(index === 0 ? Deferred.await(close) : Effect.never),
    ))
    const held = yield* Effect.forEach(Array.from({ length: REGEX_WORKERS }, (_, index) => index), (index) => Effect.forkChild(holding(index)), { concurrency: 1 })
    yield* Ref.get(opened).pipe(Effect.delay("20 millis"), Effect.repeat({ until: (count) => count === REGEX_WORKERS }))
    const extra = yield* Effect.forkChild(Effect.scoped(openRegexSearch(/b/).pipe(Effect.andThen(Ref.update(opened, (count) => count + 1)))))
    yield* Effect.sleep("300 millis")
    const waiting = yield* Ref.get(opened)
    yield* Deferred.succeed(close, undefined)
    yield* Fiber.join(extra)
    const after = yield* Ref.get(opened)
    yield* Effect.forEach(held, (fiber) => Fiber.interrupt(fiber), { concurrency: 1, discard: true })
    return { waiting, after }
  }))
  expect(observed).toEqual({ waiting: REGEX_WORKERS, after: REGEX_WORKERS + 1 })
})
