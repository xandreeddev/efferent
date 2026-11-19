import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { Deferred, Effect, Fiber, Layer, Option, Predicate, Ref, Result, Schema } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { dataOf, kernel, messageOf, Sessions, toolResult, TurnNumber, userMessage } from "@xandreed/core"
import type { OpenSession, SessionId, StoredEvent } from "@xandreed/core"
import {
  Approval, approveIn, callTool, decidedEvent, fileHandlers, Files, FilesRefused, fileTools, flatMemory, inMemoryFiles, inProcessJournal, Memory, modelAnswer, scriptedModel,
  sessions, summaryMemory, windowMemory, withFacts, workspacePath,
} from "./index.js"
import type { Decision, FilePath, ModelScript, ModelToolCall } from "./index.js"

/*
 * A workspace (ADR 0017), as a test: files are the world an agent acts on,
 * reached only by tools through `Files`, which the host provides. Nothing
 * the agent is made of reads a file, and nothing reaches a prompt from one
 * but a stored result. `docs/kernel.md` quotes the program and the app's
 * permission layers.
 */

const SYSTEM = "Use a tool when it helps."

/** What the turn does with a call before it runs it: here, nothing. An app that asks a person puts its question here. */
type BeforeCall<R = never> = (session: OpenSession, call: ModelToolCall) => Effect.Effect<boolean, never, R>

const always: BeforeCall = () => Effect.succeed(true)

/** A host's turn with the file tools, one message a turn, run before each call through `before`. */
const turnOf = <R>(before: BeforeCall<R>) => (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const language = yield* LanguageModel.LanguageModel
  const toolkit = yield* fileTools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 6; step++) {
    const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
    const answer = yield* modelAnswer(language.streamText({ prompt, toolkit: fileTools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) if (yield* before(session, call)) yield* callTool(toolkit, call, session)
  }
  return "stopped"
}))

/** No one to ask: a stack whose app never asks gives this, and it is never called. */
const nobody = Layer.succeed(Approval, Approval.of({ ask: () => Effect.succeed<Decision>({ _tag: "Refused" }) }))

// #region stack
// What a program with the file tools provides: the model, the tools' handlers, a memory, the sessions over a store,
// and the workspace. Nothing else: the tools never ask anyone.
const stackOf = (model: Layer.Layer<LanguageModel.LanguageModel>, files: Layer.Layer<Files>) =>
  Layer.mergeAll(model, fileHandlers, flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(Layer.provideMerge(files))
// #endregion stack

/** Turns of one conversation over `files`: the journal after, what the model was sent, and the files after. */
const conversation = (script: ModelScript, messages: ReadonlyArray<string>, files: Layer.Layer<Files>, options: { readonly before?: BeforeCall<Approval>; readonly approval?: Layer.Layer<Approval>; readonly between?: Effect.Effect<void, never, Files> } = {}) =>
  Effect.gen(function* () {
    const { model, calls: sent } = yield* scriptedModel(script)
    const turn = turnOf<Approval>(options.before ?? always)
    const out = yield* Effect.gen(function* () {
      const all = yield* Sessions
      const id = yield* all.create({ owner: "test" })
      for (const [index, message] of messages.entries()) {
        if (index > 0 && options.between !== undefined) yield* options.between
        yield* turn(id, message)
      }
      const workspace = yield* Files
      const paths = yield* Effect.orDie(workspace.list(Option.none()))
      const after = Object.fromEntries(yield* Effect.forEach(paths, (path) => Effect.map(Effect.orDie(workspace.read(path)), (text) => [path, text] as const), { concurrency: 1 }))
      return { journal: (yield* all.read(id)).events, after }
    }).pipe(Effect.provide(Layer.merge(stackOf(model, files), options.approval ?? nobody)))
    return { ...out, sent: yield* sent }
  })

/** A path in the workspace, written in a test. */
const at = (text: string): FilePath => Result.getOrThrowWith(workspacePath(text), (problem) => new Error(problem))

// #region path
/** The path a call of a file tool names, as the app keys its question by it. */
const pathOf = (params: unknown): string => Predicate.hasProperty(params, "path") && typeof params.path === "string" ? params.path : "?"
// #endregion path

const results = (journal: ReadonlyArray<StoredEvent>) =>
  journal.flatMap((record) => Option.toArray(messageOf(record))).flatMap((message) => (message._tag === "ToolResult" ? [[message.result, message.isFailure]] : []))
const calling = (name: string, params: Schema.Json) => ({ _tag: "Calls" as const, pieces: [], calls: [{ name, params }] })
const answering = (text: string) => ({ _tag: "Answers" as const, pieces: [text] })

describe("a workspace", () => {
  test("a model reads a file and changes it through the tools; the journal holds each call and its result", async () => {
    // #region tools
    // The workspace this program acts on: in memory, with one file. A test, a page and a command line each give their own.
    const files = inMemoryFiles({ "notes/todo.md": "- buy milk\n- call Ana\n" })
    const { journal, after } = await Effect.runPromise(conversation([
      calling("readFile", { path: "notes/todo.md" }),
      calling("editFile", { path: "notes/todo.md", find: "call Ana", replace: "call Ana at noon" }),
      answering("Done."),
    ], ["Move the call to noon."], files))
    // The read is a stored result, a page of the file; the edit is a call and its result; the file is changed.
    expect(results(journal)).toEqual([
      [{ path: "notes/todo.md", text: "- buy milk\n- call Ana\n", from: 0, to: 22, total: 22 }, false],
      [{ path: "notes/todo.md", characters: 30 }, false],
    ])
    expect(after).toEqual({ "notes/todo.md": "- buy milk\n- call Ana at noon\n" })
    // #endregion tools
  })

  test("a file reaches a prompt only through a stored result, and the context is the same whatever the workspace holds", async () => {
    const script = [calling("readFile", { path: "notes/todo.md" }), answering("You need milk."), answering("Noted.")]
    const run = (between: Effect.Effect<void, never, Files>) =>
      Effect.runPromise(conversation(script, ["What do I need?", "Thanks."], inMemoryFiles({ "notes/todo.md": "- buy milk\n" }), { between }))
    // Between the two turns a person changes the file, and adds another. Nothing tells the agent, and nothing reads them for it.
    const changed = await run(Effect.orDie(Effect.gen(function* () {
      const files = yield* Files
      yield* files.write(at("notes/todo.md"), "- buy bread\n")
      yield* files.write(at("notes/new.md"), "a new file")
    })))
    const untouched = await run(Effect.void)
    const last = JSON.stringify(changed.sent.at(-1))
    expect(last).toContain("- buy milk")
    expect(last).not.toContain("bread")
    expect(changed.sent).toEqual(untouched.sent)
  })

  test("type-level: no stock memory, memory wrapper or the session plugin requires Files", () => {
    type Free<L extends Layer.Any> = [Files] extends [Layer.Services<L>] ? "requires Files" : "free"
    const flat: Free<typeof flatMemory> = "free"
    const window: Free<ReturnType<typeof windowMemory>> = "free"
    const summary: Free<ReturnType<typeof summaryMemory>> = "free"
    const wrapped = withFacts({ limit: 3 })(flatMemory)
    const facts: Free<typeof wrapped> = "free"
    const session: Free<ReturnType<typeof sessions>> = "free"
    // The control: a layer that needs `Files` is told apart.
    const control: Free<Layer.Layer<never, never, Files>> = "requires Files"
    expect([flat, window, summary, facts, session, control]).toEqual(["free", "free", "free", "free", "free", "requires Files"])
  })

  test("no part of the kernel outside the files contract and its tools imports the files contract", () => {
    const root = import.meta.dir
    const sources = (dir: string): ReadonlyArray<string> => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [])
    // Whether a source at `path` (from the kernel's folder) imports anything in the files contract, wherever it sits.
    const reachesFiles = (path: string, text: string) => Array.from(text.matchAll(/from\s+"(\.[^"]*)"/g), (found) => relative(root, join(root, dirname(path), found[1] ?? "")))
      .some((target) => target.startsWith(`contracts${sep}files${sep}`))
    // The search's contract names a `FilePath`, and its adapter reads `Files` for the search tool alone; the disk
    // workspace implements it (ADR 0028). None builds the agent's state or a prompt.
    const allowed = (path: string) => /^(contracts\/files|contracts\/search|plugins\/tool-files|plugins\/files-in-memory|plugins\/search-files|plugins\/tool-search|node\/files-disk)\//.test(path) || path === "index.ts" || /\.test\.ts$|(^|\/)testing(\.port)?\.ts$/.test(path)
    const offenders = sources(root).map((path) => relative(root, path)).filter((path) => !allowed(path) && reachesFiles(path, readFileSync(join(root, path), "utf8")))
    expect(offenders).toEqual([])
    // The controls: an import of the contract from a memory plugin, or from a contract beside it, would be caught.
    expect(reachesFiles(join("plugins", "memory-window", "window.adapter.ts"), `import { Files } from "../../contracts/files/files.port.js"`)).toBe(true)
    expect(reachesFiles(join("contracts", "memory", "memory.entity.functions.ts"), `import { Files } from "../files/files.port.js"`)).toBe(true)
    expect(reachesFiles(join("contracts", "memory", "memory.entity.functions.ts"), `import { pageAt } from "./pointer.entity.functions.js"`)).toBe(false)
    expect(sources(root).some((path) => relative(root, path) === join("plugins", "memory-window", "window.adapter.ts"))).toBe(true)
  })

  test("an interrupted write leaves the file changed and the call with no result: the next prompt does not send the call", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const written = yield* Deferred.make<void>()
      // A workspace that writes, then never answers: Stop, a reload or a crash between the write and its stored result.
      const stalling = Layer.effect(Files, Effect.gen(function* () {
        const inner = yield* Files
        return Files.of({ ...inner, write: (path, text, expected) => Effect.andThen(inner.write(path, text, expected), Effect.andThen(Deferred.succeed(written, undefined), Effect.never)) })
      })).pipe(Layer.provide(inMemoryFiles()))
      const { model, calls: sent } = yield* scriptedModel([calling("writeFile", { path: "a.txt", text: "hello" }), answering("Hi.")])
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const id = yield* all.create({ owner: "test" })
        const running = yield* Effect.forkChild(turnOf(always)(id, "Write hello to a.txt."))
        yield* Deferred.await(written)
        yield* Fiber.interrupt(running)
        yield* turnOf(always)(id, "Hello?")
        const file = yield* Effect.orDie((yield* Files).read(at("a.txt")))
        return { names: (yield* all.read(id)).events.map((record) => String(record.name)), file, next: (yield* sent).at(-1) }
      }).pipe(Effect.provide(stackOf(model, stalling)))
    }).pipe(Effect.timeout("5 seconds")))
    // The file was written; the journal holds the call and no result, and the turn was closed.
    expect(out.file).toBe("hello")
    expect(out.names.slice(0, 4)).toEqual(["core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended"])
    // The next prompt: the two messages, with no call (a call with no result is never sent) and no word of the file.
    expect(out.next).toEqual([{ role: "system", text: SYSTEM }, { role: "user", text: "Write hello to a.txt." }, { role: "user", text: "Hello?" }])
  })

  test("a branch shares the workspace: a file written on the branch is read on the conversation it was cut from", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const { model } = yield* scriptedModel([
        calling("writeFile", { path: "a.txt", text: "one" }), answering("Written."),
        calling("writeFile", { path: "a.txt", text: "two" }), answering("Written on the branch."),
        calling("readFile", { path: "a.txt" }), answering("It says two."),
      ])
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const id = yield* all.create({ owner: "test" })
        yield* turnOf(always)(id, "Write one.")
        const branch = yield* all.fork(id, { through: TurnNumber.make(1) })
        yield* turnOf(always)(branch, "Write two.")
        yield* turnOf(always)(id, "Read it.")
        return results((yield* all.read(id)).events)
      }).pipe(Effect.provide(stackOf(model, inMemoryFiles())))
    }))
    expect(out.at(-1)).toEqual([{ path: "a.txt", text: "two", from: 0, to: 3, total: 3 }, false])
  })
})

describe("permission is the app's: three layers it wraps around the plugin", () => {
  test("a workspace that declines by a rule: the model reads why, and nothing is written", async () => {
    // #region declining
    // A `Files` of the app's over the one it was given: writes to the `docs` folder are declined, everything else passes.
    const keepDocs = <E, R>(files: Layer.Layer<Files, E, R>) => Layer.effect(Files, Effect.gen(function* () {
      const inner = yield* Files
      return Files.of({
        ...inner,
        write: (path, text, expected) => path.startsWith("docs/")
          ? Effect.fail(new FilesRefused({ path, reason: "the docs folder is read-only", message: `declined ${path}` }))
          : inner.write(path, text, expected),
      })
    })).pipe(Layer.provide(files))
    const workspace = keepDocs(inMemoryFiles({ "docs/guide.md": "# Guide\n" }))
    // #endregion declining
    const { journal, after } = await Effect.runPromise(conversation(
      [calling("writeFile", { path: "docs/guide.md", text: "gone" }), calling("writeFile", { path: "notes.md", text: "kept" }), answering("Done.")],
      ["Write."],
      workspace,
    ))
    expect(results(journal)).toEqual([
      ["The workspace declined this for docs/guide.md: \"the docs folder is read-only\". Do not try it again unless the user asks for it.", true],
      [{ path: "notes.md", characters: 4 }, false],
    ])
    expect(after).toEqual({ "docs/guide.md": "# Guide\n", "notes.md": "kept" })
  })

  test("asking a person: the app's loop asks before a write, the answer is a record, and an answer for good stands", async () => {
    const asked = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const answers: ReadonlyArray<Decision> = [{ _tag: "Refused" }, { _tag: "ApprovedAlways" }]
    const person = Layer.succeed(Approval, Approval.of({
      ask: (request) => Effect.map(Ref.updateAndGet(asked, (all) => [...all, request.action]), (all): Decision => answers[all.length - 1] ?? { _tag: "Refused" }),
    }))
    // #region asking
    // The app's turn asks before it runs a call that writes: the tools never ask, so the question is the loop's.
    // A no is stored as the call's result; a yes for good stands for the rest of the conversation, per file.
    // A path that is no path in the workspace is not asked about: the tool refuses it in words.
    const askFirst: BeforeCall<Approval> = (session, call) => {
      if (call.name !== "writeFile" && call.name !== "editFile") return Effect.succeed(true)
      return Result.match(workspacePath(pathOf(call.params)), {
        onFailure: () => Effect.succeed(true),
        onSuccess: (path) => approveIn(session, { action: `files.write:${path}`, detail: `Let the agent write ${path}.` }).pipe(Effect.matchEffect({
          onFailure: (refusal) => Effect.as(Effect.orDie(session.append(toolResult(call, refusal, true))), false),
          onSuccess: () => Effect.succeed(true),
        })),
      })
    }
    // #endregion asking
    const { journal, after } = await Effect.runPromise(conversation(
      [
        calling("writeFile", { path: "a.txt", text: "one" }), answering("Not written."),
        calling("writeFile", { path: "a.txt", text: "two" }), calling("writeFile", { path: "a.txt", text: "three" }), answering("Written twice."),
      ],
      ["Write one.", "Write two, then three."],
      inMemoryFiles(),
      { before: askFirst, approval: person },
    ))
    expect(await Effect.runPromise(Ref.get(asked))).toEqual(["files.write:a.txt", "files.write:a.txt"])
    // The key is the path as the workspace has it: the longest path is asked about, and one that is no path never is.
    const long = `${"d/".repeat(79)}ab`
    const edge = await Effect.runPromise(conversation(
      [calling("writeFile", { path: long, text: "x" }), calling("writeFile", { path: "x".repeat(400), text: "x" }), answering("Done.")],
      ["Write both."],
      inMemoryFiles(),
      { before: askFirst, approval: Layer.succeed(Approval, Approval.of({ ask: () => Effect.succeed<Decision>({ _tag: "Approved" }) })) },
    ))
    expect(long.length).toBe(160)
    expect(edge.journal.flatMap((record) => Option.toArray(dataOf(decidedEvent, record))).map((one) => one.action)).toEqual([`files.write:${long}`])
    expect(results(edge.journal).map(([, failed]) => failed)).toEqual([false, true])
    expect(journal.flatMap((record) => Option.toArray(dataOf(decidedEvent, record))).map((one) => one.decision._tag)).toEqual(["Refused", "ApprovedAlways"])
    expect(results(journal).map(([, failed]) => failed)).toEqual([true, false, false])
    expect(after).toEqual({ "a.txt": "three" })
  })

  test("a model first, a person when it is unsure: an Approval of the app's that passes what its judge is not sure of", async () => {
    const asked = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const person = Layer.succeed(Approval, Approval.of({ ask: (request) => Effect.as(Ref.update(asked, (all) => [...all, request.action]), { _tag: "Approved" as const }) }))
    // #region judge
    // An `Approval` of the app's over the person's: a judge answers first, and what it is not sure of goes to the person.
    // An app's judge asks a model; this one reads the request, so the test is the same every time.
    const judgedFirst = (judge: (detail: string) => Effect.Effect<"safe" | "unsure">) => <E, R>(below: Layer.Layer<Approval, E, R>) =>
      Layer.effect(Approval, Effect.gen(function* () {
        const person = yield* Approval
        return Approval.of({
          ask: (request) => Effect.flatMap(judge(request.detail), (verdict): Effect.Effect<Decision> => verdict === "safe" ? Effect.succeed({ _tag: "Allowed" }) : person.ask(request)),
        })
      })).pipe(Layer.provide(below))
    const approval = judgedFirst((detail) => Effect.succeed(detail.includes("scratch/") ? "safe" : "unsure"))(person)
    // #endregion judge
    const askFirst: BeforeCall<Approval> = (session, call) => approveIn(session, { action: `files.write:${pathOf(call.params)}`, detail: `Let the agent write ${pathOf(call.params)}.` }).pipe(
      Effect.matchEffect({ onFailure: () => Effect.succeed(false), onSuccess: () => Effect.succeed(true) }),
    )
    const { journal, after } = await Effect.runPromise(conversation(
      [calling("writeFile", { path: "scratch/a.txt", text: "x" }), calling("writeFile", { path: "notes.md", text: "y" }), answering("Done.")],
      ["Write both."],
      inMemoryFiles(),
      { before: askFirst, approval },
    ))
    expect(await Effect.runPromise(Ref.get(asked))).toEqual(["files.write:notes.md"])
    expect(journal.flatMap((record) => Option.toArray(dataOf(decidedEvent, record))).map((one) => [one.action, one.decision._tag])).toEqual([["files.write:scratch/a.txt", "Allowed"], ["files.write:notes.md", "Approved"]])
    expect(after).toEqual({ "notes.md": "y", "scratch/a.txt": "x" })
  })
})
