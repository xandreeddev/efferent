import { EvaluationRun, EvaluationRunStore } from "@xandreed/evals"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { EvaluationRunStoreFsLive, readRun, readRunInParts, readRunWithin, writeRunFile } from "./evaluation-store.fs.adapter.js"

/*
 * A run file holds the bytes `JSON.stringify(run, null, 2)` makes of the
 * encoded run, which is what 0.15.1 wrote and reads, at any size. No run here
 * outgrows the longest string, so these tests pass a small limit, chunk or
 * piece where the store passes the runtime's own and its defaults.
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

  test("written a few characters at a time, holds the same bytes", async () => {
    const directory = await freshDirectory()
    const value = await encoded(run)
    const texts = await Effect.runPromise(Effect.forEach([0, 1, 2, 7, 64], (piece) => writeRunFile(join(directory, `${piece}.json`), value, piece).pipe(
      Effect.andThen(Effect.tryPromise(() => readFile(join(directory, `${piece}.json`), "utf8"))),
    ), { concurrency: 1 }))
    expect(texts).toEqual(Array.from({ length: 5 }, () => JSON.stringify(value, null, 2)))
  })

  test("larger than the longest string, is read back in parts at any chunk size", async () => {
    const { path } = await written(run)
    const { size } = await stat(path)
    expect(await Effect.runPromise(readRun(path))).toEqual(run)
    expect(await Effect.runPromise(readRunWithin(path, 64))).toEqual(run)
    const chunks = [1, 2, 3, 7, 13, 19, 20, 4096]
    // With no trial there is nothing to cut: the file is read whole, as before.
    expect(await Effect.runPromise(Effect.forEach(chunks, (chunk) => readRunInParts(path, size, chunk), { concurrency: 1 })))
      .toEqual(chunks.map(() => run.trials.length === 0 ? Option.none() : Option.some(run)))
  })
}))

test("larger than the longest string, a run in another layout is read whole, as before", async () => {
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
    return [yield* readRunInParts(path, Buffer.byteLength(text), 4096), yield* readRunWithin(path, 64)] as const
  }), { concurrency: 1 }))
  expect(read).toEqual([[Option.none(), tricky], [Option.none(), tricky], [Option.none(), tricky]])
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
