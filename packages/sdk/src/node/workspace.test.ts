import { describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import type { Schema } from "effect"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import { kernel, messageOf, Sessions, userMessage } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"
import { callTool, fileHandlers, fileTools, filesSearch, flatMemory, inProcessJournal, Memory, modelAnswer, scriptedModel, searchHandlers, searchTools, sessions, shellHandlers, shellTools } from "../index.js"
import { diskFiles, processShell } from "./index.js"
import { scratch } from "./testing.js"

/*
 * A host on Node or Bun that gives its agent a folder of the disk, a shell and
 * a search (ADR 0028), each a layer it plugs in: a scripted model searches,
 * reads, edits and runs a command in a real folder, with a real shell.
 * `docs/kernel.md` quotes the stack.
 */

// #region workspace
/**
 * The tools a host offers and what they run over: the file tools and the search over a folder of the disk, and a shell
 * that starts there with only the `PATH` the host gives. Each is a layer the host plugs in or leaves out; none asks
 * anyone, so a host that wants a rule or a person wraps the contract or asks in its loop.
 */
const tools = Toolkit.merge(fileTools, searchTools, shellTools)

const workspace = (folder: string) => Layer.mergeAll(fileHandlers, searchHandlers, shellHandlers).pipe(
  Layer.provideMerge(filesSearch()),
  Layer.provideMerge(diskFiles({ root: folder })),
  Layer.provideMerge(processShell({ cwd: folder, env: { PATH: "/usr/bin:/bin" } })),
)
// #endregion workspace

const SYSTEM = "Use a tool when it helps."

/** A host's turn over the tools: the model's calls run in order until it answers. */
const turnOf = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const language = yield* LanguageModel.LanguageModel
  const toolkit = yield* tools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 8; step++) {
    const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
    const answer = yield* modelAnswer(language.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
  }
  return "stopped"
}))

const calling = (name: string, params: Schema.Json) => ({ _tag: "Calls" as const, pieces: [], calls: [{ name, params }] })

describe("a workspace on the disk", () => {
  test("a model searches a folder, reads and edits a file, and runs a command there; each call and result is in the journal", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const folder = yield* Effect.flatMap(scratch, (made) => Effect.promise(() => realpath(made)))
      yield* Effect.promise(async () => {
        await mkdir(join(folder, "src"))
        await writeFile(join(folder, "src", "greet.ts"), "export const greet = () => \"hello\"\n")
        await mkdir(join(folder, "node_modules"))
        await writeFile(join(folder, "node_modules", "dep.ts"), "export const greet = 1\n")
      })
      const { model } = yield* scriptedModel([
        calling("searchFiles", { pattern: "greet", glob: "*.ts" }),
        calling("editFile", { path: "src/greet.ts", find: "\"hello\"", replace: "\"hi\"" }),
        calling("runCommand", { command: "cat src/greet.ts; ls" }),
        { _tag: "Answers", pieces: ["Done."] },
      ])
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const id = yield* all.create({ owner: "test" })
        const reply = yield* turnOf(id, "Make greet say hi.")
        const results = (yield* all.read(id)).events.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => message._tag === "ToolResult" ? [message.result] : [])
        return { reply, results, file: yield* Effect.promise(() => readFile(join(folder, "src", "greet.ts"), "utf8")) }
      }).pipe(Effect.provide(Layer.mergeAll(model, flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())), workspace(folder))))
    })))
    expect<unknown>(out).toEqual({
      reply: "Done.",
      results: [
        { matches: [{ path: "src/greet.ts", line: 1, column: 14, text: "export const greet = () => \"hello\"" }], more: false, skipped: 0 },
        { path: "src/greet.ts", characters: 32 },
        { ended: "exited", exitCode: 0, stdout: "export const greet = () => \"hi\"\nnode_modules\nsrc\n", stderr: "", stdoutCut: 0, stderrCut: 0 },
      ],
      file: "export const greet = () => \"hi\"\n",
    })
  }, 30_000)
})
