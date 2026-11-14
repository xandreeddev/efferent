// The workbench runs any lesson's definition, not only lesson 1's: a second
// definition, with one file and names of its own, runs and answers through
// the same runtime.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Option, Result, Stream } from "effect"
import type { Lesson } from "../lesson.ts"
import { runStatements } from "../evaluate.ts"
import { loadEcho } from "../models/mock.ts"
import { Chat } from "../page-chat.ts"
import { LessonRuntime } from "../runtime.ts"
import type { Trace } from "../runtime.ts"
import { lessonOf } from "./index.ts"

/** A lesson the site does not have: one file, `echo.ts`, a program that only answers "ok", over the page's chat. */
const other: Lesson = {
  slug: "other",
  files: [{
    id: "echo",
    label: "echo.ts",
    defaultText: `const main = Effect.gen(function* () {
  const chat = yield* Chat
  yield* Stream.runForEach(chat.messages, (message) => chat.reply("ok: " + message))
}).pipe(Effect.provide(chatOn(pane)), Effect.provide(sessions()), Effect.provide(inProcessJournal()), Effect.provide(kernel()))`,
    documentOf: (editable) => editable,
    editableFrom: 0,
    formatPrefix: "",
    sections: [],
    folded: [],
    readOnly: false,
  }],
  mainFile: "echo",
  chips: [],
  three: [],
  fill: [],
  controls: {},
  experiments: {},
  evaluate: (sources, parts) => Result.flatMap(
    runStatements("echo.ts did not run: ", sources.echo ?? "", "main", { Effect, Stream, Chat, chatOn: parts.chatOn, sessions: parts.sessions, inProcessJournal: parts.inProcessJournal, kernel: parts.kernel, pane: parts.pane }),
    (main) => (Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("echo.ts did not run: main is no Effect")),
  ),
}

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

describe("lesson definitions", () => {
  test("the site's lessons are found by slug, and an unknown slug by none", () => {
    expect(Option.map(lessonOf("your-first-agent"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["agent", "chat", "memory"]))
    expect(Option.map(lessonOf("tools"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["agent", "tools", "chat", "memory"]))
    expect(Option.map(lessonOf("your-own-plugin"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["plugin", "agent", "tools", "chat", "memory"]))
    expect(Option.map(lessonOf("sub-agents"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["agent", "tools", "loop", "chat", "memory"]))
    expect(Option.map(lessonOf("render"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["tools", "agent", "chat", "memory"]))
    expect(Option.map(lessonOf("compaction"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["memory", "summarizer", "agent", "tools", "chat"]))
    expect(lessonOf("no-such-lesson")).toEqual(Option.none())
  })

  test("a second definition runs its own file with its own names and answers through the same runtime", async () => {
    const runtime = await LessonRuntime.create(other)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    expect(await runtime.start({ echo: other.files[0]!.defaultText })).toEqual({ _tag: "Built" })
    const replied = new Promise<Trace>((resolve) => { runtime.onTrace((trace) => { if (trace._tag === "Reply") resolve(trace) }) })
    runtime.send("Hello")
    expect(await replied).toMatchObject({ _tag: "Reply", text: "ok: Hello" })
    // Lesson 1's names are not in scope here, and the failure names this lesson's file.
    expect(await runtime.start({ echo: "const main = flatMemory" })).toMatchObject({ _tag: "Refused", message: expect.stringContaining("echo.ts did not run: ") })
  })
})
