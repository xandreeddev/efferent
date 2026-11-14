// Lesson 6's four files, compiled as written, type-checked, and run on the
// kernel with a scripted model: show stores a view in the turn its call runs
// in, the model's next prompt holds a few words and none of the cells, and
// without its turn the tool fails as an answer the model reads.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import type { Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { scriptedModel } from "@xandreed/sdk/kernel"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, moduleOf } from "./agent.source.ts"
import { noTurn, tableAsResult } from "./config-edit.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "./tools.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

interface Shown {
  readonly pieces: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
}

const write = (name: string, agent: string = DEFAULT_AGENT, tools: string = DEFAULT_TOOLS) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(agent))
  writeFileSync(new URL("./chat.ts", at), CHAT)
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(tools))
  return new URL("./agent.ts", at)
}

type Pane = { readonly onSend: (send: (text: string) => void) => void; readonly appendToAnswer: (piece: string) => void; readonly finishAnswer: (text: string) => void; readonly showError: (error: unknown) => void; readonly showStatus: (text: string) => void }
type Run = (pane: Pane, model: Layer.Layer<LanguageModel.LanguageModel>) => Effect.Effect<void, unknown>

/**
 * Run `main` from the module at `file` with the scripted model, send `messages`, and stop once `answers` replies or
 * errors are shown. `onStatus` may send more, as a learner typing while the agent works.
 */
const runMain = (file: URL, messages: ReadonlyArray<string>, script: Parameters<typeof scriptedModel>[0], answers = messages.length, onStatus: (status: string, send: (text: string) => void) => void = () => {}) => Effect.gen(function* () {
  const { run } = (yield* Effect.promise(() => import(file.href))) as { run: Run }
  const { model, calls } = yield* scriptedModel(script)
  const shown = yield* Ref.make<Shown>({ pieces: [], replies: [], errors: [], status: [] })
  const done = yield* Deferred.make<void>()
  const sent = yield* Deferred.make<(text: string) => void>()
  let send: (text: string) => void = () => {}
  const note = (key: keyof Shown, text: string) => Effect.runSync(Ref.update(shown, (all) => ({ ...all, [key]: [...all[key], text] })))
  const settled = () => Effect.runSync(Effect.flatMap(Ref.get(shown), (all) => all.replies.length + all.errors.length >= answers ? Deferred.succeed(done, undefined) : Effect.void))
  const pane: Pane = {
    onSend: (given) => { send = given; Effect.runSync(Deferred.succeed(sent, given)) },
    appendToAnswer: (piece) => note("pieces", piece),
    finishAnswer: (text) => { note("replies", text); onStatus(`reply: ${text}`, send); settled() },
    showError: (error) => { note("errors", String(error)); settled() },
    showStatus: (text) => { note("status", text); onStatus(text, send) },
  }
  // The journal, read through the program's own sessions: the test's main provides them, so they are taken from a probe.
  const program = yield* Effect.forkChild(run(pane, model))
  const given = yield* Deferred.await(sent)
  messages.forEach(given)
  yield* Deferred.await(done)
  yield* Fiber.interrupt(program)
  return { shown: yield* Ref.get(shown), calls: yield* calls }
}).pipe(Effect.scoped, Effect.timeout("10 seconds"))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const squares = { id: "squares", title: "Squares", columns: ["n", "n²"], rows: [["1", "1"], ["2", "4"], ["3", "9"]] }
const script = [
  { _tag: "Calls" as const, pieces: [], calls: [{ name: "show", params: squares }] },
  { _tag: "Answers" as const, pieces: ["There it is."] },
]

describe("lesson 6's displayed program", () => {
  test("show stores a view in the turn its call runs in, and the model reads a few words, none of the cells", async () => {
    const result = await Effect.runPromise(runMain(write("shows"), ["Show me squares."], script))
    expect(result.shown.replies).toEqual(["There it is."])
    expect(result.calls[1]?.slice(-2)).toEqual([
      { role: "assistant", text: `show(${JSON.stringify(squares)})` },
      { role: "tool", text: "→ \"shown as squares\"" },
    ])
    expect(result.calls[1]?.some((message) => message.role === "tool" && message.text.includes("n²"))).toBe(false)
  })

  test("the wrong way, the table returned as the result, puts the cells in the model's next prompt", async () => {
    const result = await Effect.runPromise(runMain(write("as-result", DEFAULT_AGENT, Option.getOrThrow(tableAsResult(DEFAULT_TOOLS))), ["Show me squares."], script))
    expect(result.calls[1]?.at(-1)?.text).toContain("n | n²")
  })

  test("a loop that gives a call no turn: show fails, and the model reads why", async () => {
    const result = await Effect.runPromise(runMain(write("no-turn", Option.getOrThrow(noTurn(DEFAULT_AGENT))), ["Show me squares."], script))
    expect(result.calls[1]?.at(-1)?.text).toMatch(/^→ failed: .*CurrentTurn/)
  })

  test("type-checks as TypeScript, all four files", () => {
    write("typed")
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
