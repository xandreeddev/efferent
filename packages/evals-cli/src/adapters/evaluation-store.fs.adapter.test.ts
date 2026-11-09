import { EvalPath, EvaluationRun, EvaluationRunStore, TranscriptEvent, Trial } from "@xandreed/evals"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdir, mkdtemp as nativeMkdtemp, rm, open, readdir, readFile, stat, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Effect, Exit, Option, Schema } from "effect"
import { EvaluationRunStoreFsLive, readJsonInChunks, readRun, readRunWithin, writeJson, writeRunFile } from "./evaluation-store.fs.adapter.js"

/*
 * A run file holds the bytes `JSON.stringify(run, null, 2)` makes of the
 * encoded run, which is what 0.15.1 wrote and reads, at any size. No run here
 * outgrows the longest string: small chunk sizes exercise boundaries within
 * individual keys, values, UTF-8 characters, escapes and structural tokens.
 */

// Each release's recorded run (the evals package's fixtures), executed and graded: completed and failed trials, every metric kind, measured and unmeasured gates.
const Fixture = Schema.Struct({ execution: EvaluationRun, report: EvaluationRun })
const fixtures = join(import.meta.dir, "../../../evals/fixtures")
const recorded = await Effect.runPromise(Effect.forEach(
  (await readdir(fixtures)).filter((name) => /^run-.+\.json$/.test(name)),
  (name) => Effect.tryPromise(() => readFile(join(fixtures, name), "utf8")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture)))),
  { concurrency: 1 },
))
const graded = recorded[0]!.report
// Text a reader could take for the lines it cuts at, if it did not know that a line break in a string is escaped, and characters JSON escapes or writes in more than one byte.
const lookalikes = ['\n  "trials": [\n    {', "\n    },\n    {", "\n    }\n  ]", "\"\\", "é 日本語 😀 \u2028\u2029 \u0000 \ud800"]
const tricky: EvaluationRun = {
  ...graded,
  fingerprints: { ...graded.fingerprints, trials: lookalikes[0]! },
  trials: [...graded.trials, ...graded.trials].map((trial, index) => ({
    ...trial,
    output: Option.some({ index, lookalikes, trials: [], nested: { trials: [[], {}, [{ "    }": "\n" }]] }, lines: Array.from({ length: 40 }, (_, line) => `line ${line}`) }),
  })),
}
const runs: ReadonlyArray<readonly [string, EvaluationRun]> = [
  ...recorded.flatMap(({ execution, report }) => [[`${execution.id}, executed`, execution] as const, [`${report.id}, graded`, report] as const]),
  ["text that looks like its bounds", tricky],
  ["one trial", { ...graded, trials: graded.trials.slice(0, 1) }],
  ["no trial", { ...graded, trials: [] }],
]

const encoded = (run: EvaluationRun) => Effect.runPromise(Schema.encodeEffect(EvaluationRun)(run))
const freshDirectory = () => mkdtemp(join(tmpdir(), "evaluation-run-file-"))
afterEach(() => mock.restore())
/** The run as the store writes it, in a fresh directory. */
const written = async (run: EvaluationRun) => {
  const directory = await freshDirectory()
  await Effect.runPromise(EvaluationRunStore.use((store) => store.writeRun(run)).pipe(Effect.provide(EvaluationRunStoreFsLive(directory))))
  return { directory, path: join(directory, run.phase === "executed" ? "execution.json" : "report.json") }
}

runs.forEach(([name, run]) => describe(`a run file (${name})`, () => {
  test("holds JSON.stringify(run, null, 2) byte for byte, with mode 0600 and no temporary file left", async () => {
    const { directory, path } = await written(run)
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(await encoded(run), null, 2))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual([basename(path)])
  })

  test("written with a small text buffer, holds the same bytes", async () => {
    const directory = await freshDirectory()
    const value = await encoded(run)
    const pieces = name === "text that looks like its bounds" ? [0, 1, 2, 7, 64] : [64]
    const texts = await Effect.runPromise(Effect.forEach(pieces, (piece) => writeRunFile(join(directory, `${piece}.json`), value, piece).pipe(
      Effect.andThen(Effect.tryPromise(() => readFile(join(directory, `${piece}.json`), "utf8"))),
    ), { concurrency: 1 }))
    expect(texts).toEqual(Array.from({ length: pieces.length }, () => JSON.stringify(value, null, 2)))
  })

  test("is read through bounded chunks at any token boundary", async () => {
    const { path } = await written(run)
    expect(await Effect.runPromise(readRun(path))).toEqual(run)
    expect(await Effect.runPromise(readRunWithin(path, 64))).toEqual(run)
    const chunks = name === "text that looks like its bounds" ? [1, 2, 3, 7, 13, 19, 20, 4096] : [4096]
    expect(await Effect.runPromise(Effect.forEach(chunks, (chunk) => readRunWithin(path, chunk), { concurrency: 1 })))
      .toEqual(chunks.map(() => run))
  })
}))

test("a run in another valid JSON layout is also read in bounded chunks", async () => {
  const directory = await freshDirectory()
  const value = await encoded(tricky)
  const layouts = {
    compact: JSON.stringify(value),
    tabs: JSON.stringify(value, null, "\t"),
    // The trials still cut at their bounds, but the run around them is not what JSON.stringify writes.
    respaced: JSON.stringify(value, null, 2).replace('\n  "phase": ', '\n  "phase":  '),
  }
  const read = await Effect.runPromise(Effect.forEach(Object.entries(layouts), ([layout, text]) => Effect.gen(function* () {
    const path = join(directory, `${layout}.json`)
    yield* Effect.tryPromise(() => writeFile(path, text))
    return yield* readRunWithin(path, 7)
  }), { concurrency: 1 }))
  expect(read).toEqual([tricky, tricky, tricky])
})

test("larger than the longest string, a damaged run file is invalid and a missing one missing, naming the file", async () => {
  const { directory, path } = await written(tricky)
  const text = await readFile(path, "utf8")
  await writeFile(path, text.replace('"status": "error"', '"status": "lost"'))
  const undecoded = await Effect.runPromise(readRunWithin(path, 64).pipe(Effect.flip))
  expect([undecoded.code, undecoded.message.startsWith(`${path}: `)]).toEqual(["invalid", true])
  await writeFile(path, text.slice(0, text.length / 2))
  const cut = await Effect.runPromise(readRunWithin(path, 64).pipe(Effect.flip))
  expect([cut.code, cut.message.startsWith(`${path}: `)]).toEqual(["invalid", true])
  const absent = await Effect.runPromise(readRunWithin(join(directory, "absent.json"), 64).pipe(Effect.flip))
  expect([absent.code, absent.message]).toEqual(["missing", `No file at ${join(directory, "absent.json")}`])
})

test("a run file that cannot be written fails as persistence and leaves no temporary file", async () => {
  const directory = await freshDirectory()
  await mkdir(join(directory, "report.json", "occupied"), { recursive: true })
  const failed = await Effect.runPromise(EvaluationRunStore.use((store) => store.writeRun(graded)).pipe(Effect.provide(EvaluationRunStoreFsLive(directory)), Effect.flip))
  expect([failed.code, failed.message.startsWith("File operation failed: ")]).toEqual(["persistence", true])
  expect(await readdir(directory)).toEqual(["report.json"])
})

test("failed encoding after buffered writes preserves the previous file and removes the temporary", async () => {
  const directory = await freshDirectory()
  const path = join(directory, "previous.json")
  await writeFile(path, '{"previous":true}')
  const cycle: { data: string; self?: unknown } = { data: "large😀\u0000".repeat(20000) }
  cycle.self = cycle
  const failed = await Effect.runPromise(writeJson(path, cycle).pipe(Effect.flip))
  expect(failed.code).toBe("persistence")
  expect(failed.cause).toBeInstanceOf(TypeError)
  expect(await readFile(path, "utf8")).toBe('{"previous":true}')
  expect(await readdir(directory)).toEqual(["previous.json"])
})

test("a single trial and its large event lines keep native bytes, order and incomplete evidence on failure", async () => {
  const directory = await freshDirectory()
  const trial: Trial = { ...graded.trials[0]!, status: "running", transcript: [] }
  const data = { text: "escaped\u0000😀\\\"".repeat(12000) }
  const events: ReadonlyArray<TranscriptEvent> = [1, 2].map((sequence) => ({ id: EvalPath.make(`event/${sequence}`), sequence, at: sequence, kind: "test", data }))
  const trialPath = join(directory, "trials", `${encodeURIComponent(trial.id)}.json`)
  const eventsPath = join(directory, "trials", `${encodeURIComponent(trial.id)}.events.jsonl`)
  const withStore = <A, E>(effect: Effect.Effect<A, E, EvaluationRunStore>) => Effect.runPromise(effect.pipe(Effect.provide(EvaluationRunStoreFsLive(directory))))
  await withStore(EvaluationRunStore.use((store) => store.writeTrial(trial).pipe(Effect.andThen(Effect.forEach(events, (event) => store.appendTranscript(trial.id, event), { concurrency: 1, discard: true })))))
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  expect(await readFile(eventsPath, "utf8")).toBe(lines)
  expect((await stat(eventsPath)).mode & 0o777).toBe(0o600)
  const previous = await readFile(trialPath, "utf8")
  const invalid = { self: {} }
  invalid.self = invalid
  const failed = await withStore(EvaluationRunStore.use((store) => store.writeTrial({ ...trial, status: "completed", output: Option.some(invalid), transcript: events })).pipe(Effect.flip))
  expect(failed.code).toBe("persistence")
  expect(await readFile(trialPath, "utf8")).toBe(previous)
  expect(await readFile(eventsPath, "utf8")).toBe(lines)
  const completed: Trial = { ...trial, status: "completed", output: Option.some(data), transcript: events }
  await withStore(EvaluationRunStore.use((store) => store.writeTrial(completed)))
  expect(await readFile(trialPath, "utf8")).toBe(JSON.stringify(await Effect.runPromise(Schema.encodeEffect(Trial)(completed)), null, 2))
  // Keep many unaligned boundaries without turning this large-file regression
  // into hundreds of thousands of filesystem reads. Tiny fragments are covered
  // separately by the codec and UTF-8 boundary tests below.
  expect(await Effect.runPromise(readJsonInChunks(trialPath, Trial, 8191))).toEqual(completed)
  expect(await readdir(join(directory, "trials"))).toEqual([basename(trialPath)])
})

test("bounded UTF-8 decoding matches readFile replacement, including broken sequences and a rejected BOM", async () => {
  const directory = await freshDirectory()
  const path = join(directory, "utf8.json")
  const bytes = Buffer.concat([Buffer.from('{"text":"é😀'), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('"}')])
  await writeFile(path, bytes)
  const expected = JSON.parse(await readFile(path, "utf8"))
  expect(await Effect.runPromise(readJsonInChunks(path, Schema.Json, 1))).toEqual(expected)
  await writeFile(path, "\ufeffnull")
  const failed = await Effect.runPromise(readJsonInChunks(path, Schema.Json, 1).pipe(Effect.flip))
  expect(failed.code).toBe("invalid")
})

test("a proxy revoked while normalization runs fails as typed persistence, like the native codec", async () => {
  const revoked = () => {
    const proxy = Proxy.revocable({}, { get: (target, key) => {
      if (key === "toJSON") { proxy.revoke(); return undefined }
      return Reflect.get(target, key)
    } })
    return proxy.proxy
  }
  const native = await Effect.runPromise(Effect.try(() => JSON.stringify(revoked())).pipe(Effect.flip))
  expect(native.cause).toBeInstanceOf(TypeError)
  const directory = await freshDirectory()
  const failed = await Effect.runPromise(writeJson(join(directory, "proxy.json"), revoked()).pipe(Effect.flip))
  expect(failed.code).toBe("persistence")
  expect(failed.cause).toBeInstanceOf(TypeError)
  expect(await readdir(directory)).toEqual([])
})

test("a failed event after a flushed chunk restores the valid prefix before the next event", async () => {
  const directory = await freshDirectory()
  const id = EvalPath.make("trial")
  const event: TranscriptEvent = { id: EvalPath.make("event"), sequence: 1, at: 1, kind: "test", data: "prior" }
  const append = (value: TranscriptEvent) => Effect.runPromise(EvaluationRunStore.use((store) => store.appendTranscript(id, value)).pipe(Effect.provide(EvaluationRunStoreFsLive(directory)), Effect.exit))
  expect(Exit.isSuccess(await append(event))).toBe(true)
  const invalid: { text: string; self?: unknown } = { text: "large😀\u0000".repeat(20000) }
  invalid.self = invalid
  const failed = await append({ ...event, sequence: 2, data: invalid })
  expect(Exit.isFailure(failed)).toBe(true)
  const last = { ...event, sequence: 3, data: "next" }
  expect(Exit.isSuccess(await append(last))).toBe(true)
  const path = join(directory, "trials", "trial.events.jsonl")
  expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(event)}\n${JSON.stringify(last)}\n`)
})

test("ordinary interruption between chunks completes its event before the next append", async () => {
  const directory = await freshDirectory()
  const reference = await open(join(directory, "reference"), "w")
  const prototype = Object.getPrototypeOf(reference)
  const write = prototype.write
  await reference.close()
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const pause = { active: true }
  const hook = spyOn(prototype, "write").mockImplementation(function(this: FileHandle, ...args: Array<unknown>) {
    const result = Reflect.apply(write, this, args)
    if (!pause.active) return result
    pause.active = false
    return Promise.resolve(result).then(async (written: unknown) => { entered.resolve(); await resume.promise; return written })
  })
  const id = EvalPath.make("trial")
  const event: TranscriptEvent = { id: EvalPath.make("event"), sequence: 1, at: 1, kind: "test", data: "large😀\u0000".repeat(20000) }
  const append = (value: TranscriptEvent) => EvaluationRunStore.use((store) => store.appendTranscript(id, value)).pipe(Effect.provide(EvaluationRunStoreFsLive(directory)))
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(append(event), { signal: controller.signal })
  await entered.promise
  controller.abort()
  resume.resolve()
  const interrupted = await pending
  hook.mockRestore()
  expect(Exit.isFailure(interrupted)).toBe(true)
  const next = { ...event, sequence: 2, data: "next" }
  await Effect.runPromise(append(next))
  expect(await readFile(join(directory, "trials", "trial.events.jsonl"), "utf8")).toBe(`${JSON.stringify(event)}\n${JSON.stringify(next)}\n`)
})

test("a concurrent append from another store cannot be truncated by the first caller's rollback", async () => {
  const directory = await freshDirectory()
  const reference = await open(join(directory, "reference"), "w")
  const prototype = Object.getPrototypeOf(reference)
  const write = prototype.write
  await reference.close()
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const pause = { active: true }
  const hook = spyOn(prototype, "write").mockImplementation(function(this: FileHandle, ...args: Array<unknown>) {
    const result = Reflect.apply(write, this, args)
    if (!pause.active) return result
    pause.active = false
    return Promise.resolve(result).then(async (written: unknown) => { entered.resolve(); await resume.promise; return written })
  })
  const id = EvalPath.make("trial")
  const invalid: { text: string; self?: unknown } = { text: "large😀\u0000".repeat(20000) }
  invalid.self = invalid
  const event: TranscriptEvent = { id: EvalPath.make("event"), sequence: 1, at: 1, kind: "test", data: invalid }
  const append = (value: TranscriptEvent, root: string) => Effect.runPromiseExit(EvaluationRunStore.use((store) => store.appendTranscript(id, value)).pipe(Effect.provide(EvaluationRunStoreFsLive(root))))
  const failing = append(event, directory)
  await entered.promise
  const next = { ...event, sequence: 2, data: "concurrent success" }
  // A separately constructed layer and a different spelling of the same directory.
  const succeeding = append(next, join(directory, "trials", ".."))
  resume.resolve()
  expect(Exit.isFailure(await failing)).toBe(true)
  expect(Exit.isSuccess(await succeeding)).toBe(true)
  hook.mockRestore()
  expect(await readFile(join(directory, "trials", "trial.events.jsonl"), "utf8")).toBe(`${JSON.stringify(next)}\n`)
})

const temporaryDirectories = new Set<string>()
const mkdtemp = async (prefix: string) => { const directory = await nativeMkdtemp(prefix); temporaryDirectories.add(directory); return directory }
afterEach(async () => { await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))); temporaryDirectories.clear() })
