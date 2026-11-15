import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { Tool } from "effect/ai"
import { Core, kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { Message } from "@xandreed/core/kernel"
import { callTool, FileChanged, Files, FilesRefused, FilesUnavailable, inMemoryFiles, inProcessJournal, sessions, writtenEvent } from "../../index.js"
import type { FilePath } from "../../index.js"
import { EditFile, fileHandlers, fileTools, ListFiles, ReadFile, WriteFile } from "./file-tools.adapter.js"

const PATH = { type: "string", description: "A path in the workspace, relative to it, with / between folders, such as notes/todo.md." }

/**
 * One turn that makes each call in order over `files`: what each call stored, the files after, and the paths the
 * live event named.
 */
const calls = (made: ReadonlyArray<readonly [string, unknown]>, files: Layer.Layer<Files> = inMemoryFiles({ "notes/todo.md": "- buy milk\n- call Ana\n" })) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const heard = yield* Ref.make<ReadonlyArray<string>>([])
    yield* (yield* Core).on(writtenEvent, (event) => Ref.update(heard, (all) => [...all, event.data.path]), { name: "test", wait: true })
    const all = yield* Sessions
    const session = yield* all.open(yield* all.create({ owner: "test" }))
    yield* session.append(userMessage("go"))
    const toolkit = yield* fileTools
    const stored = yield* Effect.forEach(made, ([name, params], index) =>
      Effect.map(callTool(toolkit, { id: `c${index}`, name, params }, session), (record) => record.message), { concurrency: 1 })
    const workspace = yield* Files
    const paths = yield* workspace.list(Option.none())
    const after = Object.fromEntries(yield* Effect.forEach(paths, (path) => Effect.map(workspace.read(path), (text) => [path, text] as const), { concurrency: 1 }))
    return { stored, after, heard: yield* Ref.get(heard) }
  }).pipe(Effect.provide(Layer.mergeAll(fileHandlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(Layer.provideMerge(files))))))

const results = (stored: ReadonlyArray<Message | undefined>) => stored.map((message) => (message?._tag === "ToolResult" ? [message.result, message.isFailure] : message))

describe("the file tools", () => {
  test("readFile says what it reads, what it returns and its page, in fixed words", () => {
    expect(ReadFile.name).toBe("readFile")
    expect(ReadFile.description).toBe(
      "Read a file of the workspace. Returns `text`, the file's characters from `from` up to `to`, and `total`, its length: while `to` is less than `total`, call again with `from` set to `to`. One call reads at most 4000 characters.",
    )
    expect(Tool.getJsonSchema(ReadFile)).toEqual({
      type: "object",
      properties: {
        path: PATH,
        from: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "The character to start at: 0, or left out, for the start; then the `to` of the last part you read." },
      },
      required: ["path"],
      additionalProperties: true,
    })
  })

  test("listFiles says what it lists and its limit, in fixed words", () => {
    expect(ListFiles.name).toBe("listFiles")
    expect(ListFiles.description).toBe(
      "List the files of the workspace, or of one folder and the folders in it. Returns `paths`, in order, and `more`, how many were left out: one call lists at most 200, so give a folder to see the rest.",
    )
    expect(Tool.getJsonSchema(ListFiles)).toEqual({
      type: "object",
      properties: { folder: { type: "string", description: "A folder in the workspace, such as notes. Left out, the whole workspace." } },
      additionalProperties: true,
    })
  })

  test("writeFile says what it writes, its limit and how to write more, in fixed words", () => {
    expect(WriteFile.name).toBe("writeFile")
    expect(WriteFile.description).toBe(
      "Create a file of the workspace, or replace all its text. Returns the file's path and how many characters it holds. One call writes at most 4000 characters: write a longer file in parts, the first as it is and each next part with append set to true. To change part of a file, use editFile.",
    )
    expect(Tool.getJsonSchema(WriteFile)).toEqual({
      type: "object",
      properties: {
        path: PATH,
        text: { type: "string", description: "The file's text, or with append the part to add at its end. At most 4000 characters." },
        append: { type: "boolean", description: "True to add the text at the end of the file, which must exist. Left out, the text replaces the file's." },
      },
      required: ["path", "text"],
      additionalProperties: true,
    })
  })

  test("editFile says what it changes and when it changes nothing, in fixed words", () => {
    expect(EditFile.name).toBe("editFile")
    expect(EditFile.description).toBe(
      "Change part of a file of the workspace: the one place that holds `find` is replaced with `replace`. Returns the file's path and how many characters it now holds. `find` must be in the file exactly once, copied from what readFile returned; when it is not, nothing is changed. Each text is at most 4000 characters.",
    )
    expect(Tool.getJsonSchema(EditFile)).toEqual({
      type: "object",
      properties: {
        path: PATH,
        find: { type: "string", description: "The text to change, exactly as it is in the file, spaces and line breaks included." },
        replace: { type: "string", description: "The text to put in its place. Empty to remove it." },
      },
      required: ["path", "find", "replace"],
      additionalProperties: true,
    })
  })

  test("a file is read a page at a time, its pages stored whole; a folder is listed; a write and an edit are said live", async () => {
    const long = "0123456789".repeat(500)
    const { stored, after, heard } = await calls([
      ["readFile", { path: "./notes//todo.md" }],
      ["writeFile", { path: "notes/long.txt", text: long.slice(0, 4000) }],
      ["writeFile", { path: "notes/long.txt", text: long.slice(4000), append: true }],
      ["readFile", { path: "notes/long.txt", from: 3990 }],
      ["readFile", { path: "notes/long.txt", from: 4000 }],
      ["editFile", { path: "notes/todo.md", find: "call Ana", replace: "call Ana at $1 noon" }],
      ["listFiles", { folder: "notes" }],
      ["listFiles", {}],
    ])
    expect<unknown>(stored[0]).toEqual({ _tag: "ToolResult", id: "c0", name: "readFile", isFailure: false, whole: true, result: { path: "notes/todo.md", text: "- buy milk\n- call Ana\n", from: 0, to: 22, total: 22 } })
    expect(results(stored.slice(1))).toEqual([
      [{ path: "notes/long.txt", characters: 4000 }, false],
      [{ path: "notes/long.txt", characters: 5000 }, false],
      [{ path: "notes/long.txt", text: long.slice(3990, 5000), from: 3990, to: 5000, total: 5000 }, false],
      [{ path: "notes/long.txt", text: long.slice(4000), from: 4000, to: 5000, total: 5000 }, false],
      [{ path: "notes/todo.md", characters: 33 }, false],
      [{ paths: ["notes/long.txt", "notes/todo.md"], more: 0 }, false],
      [{ paths: ["notes/long.txt", "notes/todo.md"], more: 0 }, false],
    ])
    expect(after).toEqual({ "notes/long.txt": long, "notes/todo.md": "- buy milk\n- call Ana at $1 noon\n" })
    expect(heard).toEqual(["notes/long.txt", "notes/long.txt", "notes/todo.md"])
  })

  test("a page never ends inside a character, and a list over its limit says how many it left out", async () => {
    const files = inMemoryFiles(Object.fromEntries([...Array.from({ length: 205 }, (_, index) => [`many/${String(index).padStart(3, "0")}.txt`, ""]), ["wide.txt", `${"a".repeat(3999)}\u{1F600}b`]]))
    const { stored } = await calls([["readFile", { path: "wide.txt" }], ["readFile", { path: "wide.txt", from: 3999 }], ["listFiles", { folder: "many" }]], files)
    expect(results(stored)).toEqual([
      [{ path: "wide.txt", text: "a".repeat(3999), from: 0, to: 3999, total: 4002 }, false],
      [{ path: "wide.txt", text: "\u{1F600}b", from: 3999, to: 4002, total: 4002 }, false],
      [{ paths: Array.from({ length: 200 }, (_, index) => `many/${String(index).padStart(3, "0")}.txt`), more: 5 }, false],
    ])
  })

  test("each failure is a result the model reads, in fixed words, and changes no file", async () => {
    const { stored, after, heard } = await calls([
      ["readFile", { path: "../secret.txt" }],
      ["readFile", { path: "/etc/passwd" }],
      ["readFile", { path: "notes/none.md" }],
      ["readFile", { path: "notes/todo.md", from: 22 }],
      ["writeFile", { path: "notes/big.md", text: "x".repeat(4001) }],
      ["writeFile", { path: "notes/none.md", text: "more", append: true }],
      ["editFile", { path: "notes/todo.md", find: "call Bob", replace: "x" }],
      ["editFile", { path: "notes/todo.md", find: "- ", replace: "* " }],
      ["editFile", { path: "notes/todo.md", find: "", replace: "x" }],
      ["editFile", { path: "notes/todo.md", find: "milk", replace: "y".repeat(4001) }],
      ["listFiles", { folder: "a/../b" }],
    ])
    expect(results(stored)).toEqual([
      ["The path \"../secret.txt\" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \"..\", such as notes/todo.md.", true],
      ["The path \"/etc/passwd\" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \"..\", such as notes/todo.md.", true],
      ["No file is at notes/none.md. Call listFiles to see the files.", true],
      ["notes/todo.md is 22 characters long: from must be less than 22.", true],
      ["The text is 4001 characters long, and one call takes at most 4000. Write a longer file in parts: call writeFile with the first part, then with each next part and append set to true.", true],
      ["No file is at notes/none.md. Call listFiles to see the files.", true],
      ["The text to find is not in notes/todo.md, so nothing was changed. Call readFile and copy the text exactly, spaces and line breaks included.", true],
      ["The text to find is in notes/todo.md 2 times, so nothing was changed. Give more of the text around the place to change, so that it is there once.", true],
      ["The text to find is empty: copy the text to change from what readFile returned.", true],
      ["The replacement is 4001 characters long, and one call takes at most 4000. Write a longer file in parts: call writeFile with the first part, then with each next part and append set to true.", true],
      ["The path \"a/../b\" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \"..\", such as notes/todo.md.", true],
    ])
    expect(after).toEqual({ "notes/todo.md": "- buy milk\n- call Ana\n" })
    expect(heard).toEqual([])
  })

  test("a file written by someone else between an edit's read and its write is not overwritten: the edit fails in fixed words", async () => {
    // A workspace where a person saves the file just after the tool has read it.
    const racing = Layer.effect(Files, Effect.gen(function* () {
      const inner = yield* Files
      return Files.of({
        ...inner,
        read: (path) => Effect.tap(inner.read(path), () => Effect.orDie(inner.write(path, "- buy bread\n"))),
      })
    })).pipe(Layer.provide(inMemoryFiles({ "notes/todo.md": "- buy milk\n" })))
    const { stored, after, heard } = await calls([["editFile", { path: "notes/todo.md", find: "milk", replace: "eggs" }]], racing)
    expect(results(stored)).toEqual([["notes/todo.md was changed by someone else while it was being edited, so nothing was written. Call readFile and edit it again.", true]])
    expect(after).toEqual({ "notes/todo.md": "- buy bread\n" })
    expect(heard).toEqual([])
  })

  test("a workspace that declines is said with its reason, in fixed words; a medium that fails is a defect, stored as a failed result", async () => {
    const declining = Layer.effect(Files, Effect.gen(function* () {
      const inner = yield* Files
      return Files.of({
        ...inner,
        write: (path, text, expected) => path.startsWith("private/")
          ? Effect.fail(new FilesRefused({ path, reason: "the private folder is kept from the agent", message: "declined" }))
          : path === "broken.txt" ? Effect.fail(new FilesUnavailable({ message: "the disk is gone" })) : inner.write(path, text, expected),
      })
    })).pipe(Layer.provide(inMemoryFiles()))
    const { stored, after } = await calls([["writeFile", { path: "private/a.txt", text: "x" }], ["writeFile", { path: "broken.txt", text: "x" }], ["writeFile", { path: "ok.txt", text: "x" }]], declining)
    expect(results(stored).slice(0, 1)).toEqual([["The workspace declined this for private/a.txt: \"the private folder is kept from the agent\". Do not try it again unless the user asks for it.", true]])
    expect(stored[1]).toMatchObject({ _tag: "ToolResult", name: "writeFile", isFailure: true })
    expect(after).toEqual({ "ok.txt": "x" })
  })

  test("a listener of the write that fails is logged: the file is written and the call answers", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* (yield* Core).on(writtenEvent, () => Effect.fail({ _tag: "Broken", message: "the pane is gone" }), { name: "pane", wait: true })
      const all = yield* Sessions
      const session = yield* all.open(yield* all.create({ owner: "test" }))
      yield* session.append(userMessage("go"))
      const stored = yield* callTool(yield* fileTools, { id: "c0", name: "writeFile", params: { path: "a.txt", text: "x" } }, session)
      return { stored: stored.message, file: yield* (yield* Files).read("a.txt" as FilePath) }
    })).pipe(Effect.provide(Layer.mergeAll(fileHandlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(Layer.provideMerge(inMemoryFiles())))))
    expect(out.file).toBe("x")
    expect(out.stored).toMatchObject({ _tag: "ToolResult", isFailure: false, result: { path: "a.txt", characters: 1 } })
  })

  test("a write that expects text still holds the compare and set when the workspace is shared", async () => {
    // Two writers of one workspace: the second edit is made against text the first changed, and fails.
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const files = yield* Files
      const at = "a.txt" as FilePath
      yield* files.write(at, "one")
      yield* files.write(at, "two", { _tag: "Holds", text: "one" })
      return yield* Effect.flip(files.write(at, "three", { _tag: "Holds", text: "one" }))
    }).pipe(Effect.provide(inMemoryFiles())))
    expect(outcome).toBeInstanceOf(FileChanged)
  })
})
