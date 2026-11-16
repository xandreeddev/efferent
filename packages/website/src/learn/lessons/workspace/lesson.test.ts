// Lesson 15 on the page's runtime, with Echo: the four file tools over the
// page's workspace and their limits; the file pane, which reads the page's
// own files, again after a write a tool said and after every turn's end, and
// which saves a person's change as a compare and set; what the journal holds
// of a file (the read's result, not the file); files that outlive Rebuild,
// Stop and Clear context and not a reload; a stale edit; an interrupted
// write; and each experiment. Questions are answered through
// `runtime.decide`, as the chat's buttons answer them.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import { dataOf, turnEndedEvent } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { APPROVAL_REFUSED, FILE_PAGE, LIST_LIMIT, PATH_LIMIT, WRITE_LIMIT, workspacePath, writtenEvent } from "@xandreed/sdk/kernel"
import type { Decision, FilePath } from "@xandreed/sdk/kernel"
import { emptyChat, hear, sent } from "../../chat-model.ts"
import type { ChatBoard, ChatRow } from "../../chat-model.ts"
import { applyExperiment } from "../../lesson.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { changedUnderDraft, saveRefused, savedLine, WorkspacePane, workspaceLine } from "../../workspace-pane.ts"
import { DOCS_REASON } from "./config-edit.ts"
import { SEED, workspace } from "./lesson.ts"

// Echo streams a word every 35 ms, and the walks here run up to a dozen turns.
setDefaultTimeout(60_000)

declare global {
  /** Said by a workspace.ts edited for a test once a slow write has been made, before it is answered. */
  var workspaceLessonWrote: (() => void) | undefined
}

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(workspace.files.map((file) => [file.id, file.defaultText]))

/** The lesson's files with an experiment applied as the page applies it: every file it edits, or none. */
const applied = (id: string, sources: Record<string, string> = SOURCES): Record<string, string> => {
  const experiment = workspace.experiments[id]
  if (experiment === undefined) throw new Error(`no experiment ${id}`)
  return { ...sources, ...Object.fromEntries(Option.getOrThrow(applyExperiment(experiment, (file) => sources[file] ?? ""))) }
}

const at = (text: string): FilePath => Result.getOrThrowWith(workspacePath(text), (problem) => new Error(problem))

type Question = Extract<Trace, { readonly _tag: "Asking" }>

/** A row as a test reads it: its kind, whether a record is behind it (`*` when none), and its text. */
const told = (row: ChatRow) => `${row.kind}${row.seq === undefined ? "*" : ""}: ${row.text}`

/**
 * The page: the runtime on Echo, what it heard, the chat's rows as the page folds them, and the Files tab's model
 * over the page's workspace, hearing what the page hears, as playground.ts wires it.
 */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(workspace)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const files = Option.getOrThrow(runtime.workspace)
  const drawn: Array<string> = []
  const pane = new WorkspacePane(files, (view) => { drawn.push(Option.getOrElse(view.chosen, () => "")) })
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  runtime.onTrace((trace) => {
    heard.push(trace)
    board = hear(board, trace, runtime.conversation)
    void pane.hear(trace)
  })
  await pane.refresh()
  const result = await runtime.start(sources)
  const until = <T extends Trace>(match: (trace: Trace) => trace is T) => new Promise<T>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (match(trace)) { stop(); resolve(trace) } })
  })
  const isQuestion = (trace: Trace): trace is Question => trace._tag === "Asking"
  const isEnd = (trace: Trace): trace is Trace => trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended"
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  /** Send each once the one before is answered, then wait for the pane to have read the workspace again. */
  const say = async (...texts: ReadonlyArray<string>) => {
    for (const text of texts) { const done = until(isEnd); send(text); await done }
    await pane.settled()
  }
  const ask = async (text: string): Promise<Question> => { const question = until(isQuestion); send(text); return question }
  const answer = async (id: string, decision: Decision) => { const done = until(isEnd); runtime.decide(id, decision); await done; await pane.settled() }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const prompts = () => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : []))
  const questions = () => heard.flatMap((trace) => (trace._tag === "Asking" ? [trace] : []))
  /** What the chat's status line would say of the workspace, in order, from what the page heard. */
  const lines = () => heard.flatMap((trace) => (trace._tag === "Event" ? Option.toArray(workspaceLine(trace.event)) : []))
  const rows = () => board.rows.map(told)
  /** A file of the page's workspace as it is, or none. */
  const file = async (path: string): Promise<string | undefined> =>
    Effect.runPromise(Effect.match(files.read(at(path)), { onFailure: () => undefined, onSuccess: (text) => text }))
  const paths = async (): Promise<ReadonlyArray<string>> => Effect.runPromise(files.list(Option.none()))
  /** A person's change in the Files tab: the file chosen, the text typed, and Save. */
  const personSaves = async (path: string, change: (text: string) => string) => {
    await pane.choose(path)
    pane.edit(change(pane.current.draft))
    await pane.save()
  }
  return { runtime, heard, result, send, say, ask, answer, replies, prompts, questions, lines, rows, file, paths, pane, personSaves, until, board: () => board }
}

const TODO = SEED["notes/todo.md"] ?? ""
const LONG = SEED["notes/long.md"] ?? ""
const GUIDE = SEED["docs/guide.md"] ?? ""
const outcomes = (journal: ReadonlyArray<StoredEvent>) => journal.flatMap((event) => Option.toArray(dataOf(turnEndedEvent, event))).map((ended) => ended.outcome._tag)

describe("lesson 15 on the page (the kernel, Echo)", () => {
  test("the page's workspace starts with the seed: the Files tab lists it and shows the first file", async () => {
    const { result, pane, paths } = await page()
    expect(result).toEqual({ _tag: "Built" })
    expect(await paths()).toEqual(["docs/guide.md", "notes/long.md", "notes/todo.md"])
    expect(pane.current).toEqual({ paths: ["docs/guide.md", "notes/long.md", "notes/todo.md"], chosen: Option.some("docs/guide.md"), loaded: GUIDE, draft: GUIDE, changed: false, notice: "" })
    await pane.choose("notes/todo.md")
    expect([pane.current.chosen, pane.current.draft]).toEqual([Option.some("notes/todo.md"), TODO])
  })

  test("step 1: the agent lists the files, reads one and changes it through the tools; the Files tab shows the change", async () => {
    const { runtime, say, replies, rows, pane, file, lines, heard } = await page()
    await pane.choose("notes/todo.md")
    // A second tab that hears nothing but the tools' writes: it reads the workspace again on plugin.files.written alone.
    const onWrites = new WorkspacePane(Option.getOrThrow(runtime.workspace), () => {})
    await onWrites.choose("notes/todo.md")
    runtime.onTrace((trace) => { if (trace._tag === "Event" && Option.isSome(dataOf(writtenEvent, trace.event))) void onWrites.hear(trace) })
    await say("List the files.", "Read notes/todo.md.", "In notes/todo.md replace call Ana with call Ana at noon.")
    expect(replies()).toEqual([
      "I see 3 files: docs/guide.md, notes/long.md, notes/todo.md.",
      'I read notes/todo.md, characters 0 to 22 of 22: "- buy milk - call Ana"',
      "I changed notes/todo.md: it holds 30 characters now.",
    ])
    expect(await file("notes/todo.md")).toBe("- buy milk\n- call Ana at noon\n")
    // The tab read the file again when the tool said it wrote it: the person sees the agent's change.
    expect([pane.current.chosen, pane.current.draft, pane.current.changed]).toEqual([Option.some("notes/todo.md"), "- buy milk\n- call Ana at noon\n", false])
    await onWrites.settled()
    expect(onWrites.current.draft).toBe("- buy milk\n- call Ana at noon\n")
    // The status line: the program's own while the tool runs, then the page's when the write is said.
    expect(heard.flatMap((trace) => (trace._tag === "Status" ? [trace.text] : []))).toEqual(["turn 1", "step 1: listFiles", "turn 2", "step 1: readFile", "turn 3", "step 1: editFile"])
    expect(lines()).toEqual(["wrote notes/todo.md"])
    // The chat shows each call with its result, as any tool's.
    expect(rows().slice(-3)).toEqual([
      "agent: Let me work that out.",
      `tool: editFile(${JSON.stringify({ path: "notes/todo.md", find: "call Ana", replace: "call Ana at noon" })}) → ${JSON.stringify({ path: "notes/todo.md", characters: 30 })}`,
      "agent: I changed notes/todo.md: it holds 30 characters now.",
    ])
  })

  test("the limits: a page of 4,000 characters and the message that reads on, a write of at most 4,000, a path that cannot leave the workspace", async () => {
    expect([FILE_PAGE, WRITE_LIMIT, LIST_LIMIT, PATH_LIMIT]).toEqual([4000, 4000, 200, 160])
    expect(LONG.length).toBe(6246)
    const { say, replies, file } = await page()
    await say("Read notes/long.md.", "Read notes/long.md from 4000.")
    expect(replies()).toEqual([
      'I read notes/long.md, characters 0 to 4000 of 6246: "# A long file 1. A line of a long file, there to make it lo…" Say "read notes/long.md from 4000" for the next part.',
      'I read notes/long.md, characters 4000 to 6246 of 6246: "long file, there to make it longer than one page of readFil…"',
    ])
    await say("Read ../secret.txt", `Write big.txt: ${"x".repeat(4001)}`)
    expect(replies().slice(2)).toEqual([
      `The tool answered: readFile failed: ${JSON.stringify('The path "../secret.txt" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no "..", such as notes/todo.md.')}.`,
      `The tool answered: writeFile failed: ${JSON.stringify("The text is 4001 characters long, and one call takes at most 4000. Write a longer file in parts: call writeFile with the first part, then with each next part and append set to true.")}.`,
    ])
    expect(await file("big.txt")).toBeUndefined()
    // An edit whose text is there twice is refused too, and nothing is written.
    await say("In notes/todo.md replace - with *")
    expect(replies().at(-1)).toBe(`The tool answered: editFile failed: ${JSON.stringify("The text to find is in notes/todo.md 2 times, so nothing was changed. Give more of the text around the place to change, so that it is there once.")}.`)
    expect(await file("notes/todo.md")).toBe(TODO)
  })

  test("a list gives at most 200 paths and says how many it left out", async () => {
    const { runtime, say, replies } = await page()
    const files = Option.getOrThrow(runtime.workspace)
    await Effect.runPromise(Effect.forEach(Array.from({ length: 205 }, (_, index) => `many/${String(index).padStart(3, "0")}.txt`), (path) => files.write(at(path), "x"), { concurrency: 1 }))
    await say("List the files.")
    expect(replies()).toEqual(["I see 200 files, and 8 more were left out: docs/guide.md, many/000.txt, many/001.txt and 197 more."])
  })

  test("what the journal holds of a file is the read's result: the file changed in the Files tab, the next prompt still holds what was read", async () => {
    const { say, prompts, personSaves, file, pane } = await page()
    await say("Read notes/todo.md.")
    await personSaves("notes/todo.md", (text) => text.replace("milk", "bread"))
    expect(pane.current.notice).toBe(savedLine("notes/todo.md"))
    expect(await file("notes/todo.md")).toBe("- buy bread\n- call Ana\n")
    await say("Thanks.")
    // The second turn's prompt: the read's result as it was stored, and no word of the change.
    const last = prompts().at(-1)
    expect(last?.turn).toBe(2)
    expect(last?.messages.filter((message) => message.role === "tool").map((message) => message.text)).toEqual([`readFile → ${JSON.stringify({ path: "notes/todo.md", text: TODO, from: 0, to: 22, total: 22 })}`])
    expect(last?.messages.some((message) => message.text.includes("bread"))).toBe(false)
  })

  test("a stale edit: read, the file changed in the Files tab, then an edit of what was read is refused in the kernel's words, and the person's change stands", async () => {
    const { say, replies, personSaves, file, lines } = await page()
    await say("Read notes/todo.md.")
    await personSaves("notes/todo.md", (text) => text.replace("milk", "bread"))
    await say("In notes/todo.md replace milk with eggs.")
    expect(replies().at(-1)).toBe(`The tool answered: editFile failed: ${JSON.stringify("The text to find is not in notes/todo.md, so nothing was changed. Call readFile and copy the text exactly, spaces and line breaks included.")}.`)
    expect(await file("notes/todo.md")).toBe("- buy bread\n- call Ana\n")
    expect(lines()).toEqual(["editFile: nothing written, it failed"])
  })

  test("the Files tab keeps a person's draft when the agent writes the file, says so, and its Save is refused: nothing written, the file shown as it is", async () => {
    const { say, pane, file } = await page()
    await pane.choose("notes/todo.md")
    pane.edit("- buy cheese\n")
    await say("Write notes/todo.md: - buy rice")
    // The agent's write is in the workspace; the tab read it, kept the person's text, and said the file changed.
    expect(await file("notes/todo.md")).toBe("- buy rice")
    expect(pane.current).toMatchObject({ draft: "- buy cheese\n", loaded: TODO, changed: true, notice: changedUnderDraft("notes/todo.md") })
    // Save expects the text the tab loaded: the file holds the agent's, so nothing is written.
    await pane.save()
    expect(await file("notes/todo.md")).toBe("- buy rice")
    expect(pane.current).toMatchObject({ draft: "- buy rice", loaded: "- buy rice", changed: false, notice: saveRefused("notes/todo.md") })
    // A Save on the file as it is now writes.
    pane.edit("- buy cheese\n")
    await pane.save()
    expect(await file("notes/todo.md")).toBe("- buy cheese\n")
  })

  test("the files outlive Rebuild, Stop and Clear context, which change the program and the conversation; a reload starts them over", async () => {
    const { runtime, say, file, replies } = await page()
    await say("Write a.txt: hello")
    expect(replies()).toEqual(["I wrote a.txt: it holds 5 characters now."])
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(await file("a.txt")).toBe("hello")
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    expect(await file("a.txt")).toBe("hello")
    expect(await runtime.clear()).toEqual({ _tag: "Built" })
    expect(await file("a.txt")).toBe("hello")
    // An experiment builds again too: the files are the page's, whatever the code.
    expect(await runtime.start(applied("keep-docs"))).toEqual({ _tag: "Built" })
    expect(await file("a.txt")).toBe("hello")
    await say("Read a.txt")
    expect(replies().at(-1)).toBe('I read a.txt, characters 0 to 5 of 5: "hello"')
    // A reload is a new runtime: a new workspace, from the seed.
    const reloaded = await page()
    expect(await reloaded.file("a.txt")).toBeUndefined()
    expect(await reloaded.paths()).toEqual(["docs/guide.md", "notes/long.md", "notes/todo.md"])
  })

  test("three at once: one turn takes the three messages, and each is a call of its own in one step", async () => {
    const { send, until, replies, file } = await page()
    const done = until((trace): trace is Trace => trace._tag === "Reply")
    for (const text of workspace.three) send(text)
    await done
    expect(replies()).toEqual([
      'I see 3 files: docs/guide.md, notes/long.md, notes/todo.md. I read notes/todo.md, characters 0 to 22 of 22: "- buy milk - call Ana" I wrote scratch/plan.md: it holds 30 characters now.',
    ])
    expect(await file("scratch/plan.md")).toBe("Read the guide, then the list.")
  })

  test("a workspace.ts that throws, or gives no layer, refuses the build in words that name it", async () => {
    const { runtime } = await page()
    expect(await runtime.start({ ...SOURCES, workspace: "const workspace = (files) => { throw new Error(\"no files today\") }" }))
      .toEqual({ _tag: "Refused", message: "workspace.ts did not run: workspace(files) threw: no files today" })
    expect(await runtime.start({ ...SOURCES, workspace: "const workspace = (files) => 42" }))
      .toEqual({ _tag: "Refused", message: "workspace.ts did not run: workspace(files) is not a layer. It should give the page's files, or a layer over them." })
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
  })
})

describe("lesson 15's experiments on the page", () => {
  test("keep-docs: a write under docs/ is declined in the kernel's words, the file is unchanged, and a person can still save it in the Files tab", async () => {
    const { say, replies, file, lines, personSaves, pane } = await page(applied("keep-docs"))
    await say("Write docs/guide.md: gone", "Write notes/new.md: kept")
    expect(replies()).toEqual([
      `The tool answered: writeFile failed: ${JSON.stringify(`The workspace declined this for docs/guide.md: "${DOCS_REASON}". Do not try it again unless the user asks for it.`)}.`,
      "I wrote notes/new.md: it holds 4 characters now.",
    ])
    expect(await file("docs/guide.md")).toBe(SEED["docs/guide.md"])
    expect(lines()).toEqual(["writeFile: nothing written, the workspace declined it", "wrote notes/new.md"])
    // The tab reads and writes the page's own files: the app's rule is for the agent, and a person is not the agent.
    await personSaves("docs/guide.md", (text) => `${text}A line a person added.\n`)
    expect(pane.current.notice).toBe(savedLine("docs/guide.md"))
    expect(await file("docs/guide.md")).toBe(`${SEED["docs/guide.md"]}A line a person added.\n`)
  })

  test("ask-first: a write is asked about by file; Refuse stores the refusal as the call's result, Always is asked once for two writes of a.txt and again for another file", async () => {
    const { ask, answer, say, replies, questions, file, rows, lines, board } = await page(applied("ask-first"))
    // A read is not asked about.
    await say("Read notes/todo.md.")
    expect(questions()).toEqual([])
    const first = await ask("Write a.txt: hello")
    expect(first).toEqual({ _tag: "Asking", id: "question-1", action: "files.write:a.txt", detail: "Let the agent write a.txt." })
    expect(rows().at(-1)).toBe("ask*: Let the agent write a.txt.")
    // Its buttons answer under the question's id, and "Always" names the action it covers: this one file.
    expect(board().rows.at(-1)?.ask).toEqual({ id: "question-1", action: "files.write:a.txt" })
    await answer(first.id, { _tag: "Refused" })
    expect(replies().at(-1)).toBe(`The tool answered: writeFile failed: ${JSON.stringify(APPROVAL_REFUSED)}.`)
    expect(await file("a.txt")).toBeUndefined()
    expect(rows().slice(-3, -1)).toEqual(["note: Refused: Let the agent write a.txt.", `tool: writeFile(${JSON.stringify({ path: "a.txt", text: "hello" })}) failed: ${JSON.stringify(APPROVAL_REFUSED)}`])
    expect(lines()).toEqual(["writeFile: nothing written, you refused it"])
    // Always, for a.txt: written, and the next write of a.txt is not asked about.
    await answer((await ask("Write a.txt: hello")).id, { _tag: "ApprovedAlways" })
    await say("Write a.txt: again")
    expect(await file("a.txt")).toBe("again")
    expect(questions()).toHaveLength(2)
    // The key is the path as workspacePath makes it: ./a.txt is a.txt, already approved for good.
    await say("Write ./a.txt: third")
    expect(questions()).toHaveLength(2)
    expect(await file("a.txt")).toBe("third")
    // Another file is asked about again; a path that is none is not asked about, and the tool refuses it in words.
    const other = await ask("Write b.txt: x")
    expect([other.action, other.detail]).toEqual(["files.write:b.txt", "Let the agent write b.txt."])
    await answer(other.id, { _tag: "Approved" })
    await say("Write ../c.txt: y")
    expect(questions()).toHaveLength(3)
    expect(replies().at(-1)).toContain("is not a path in the workspace")
  })

  test("judge: a write under scratch/ is allowed with nobody asked, and the record says a policy allowed it; any other goes to the person", async () => {
    const { ask, answer, say, rows, questions, file } = await page(applied("judge"))
    await say("Write scratch/a.txt: hello")
    expect(questions()).toEqual([])
    expect(await file("scratch/a.txt")).toBe("hello")
    expect(rows()).toContain("note: Allowed by policy: Let the agent write scratch/a.txt.")
    const asked = await ask("Write notes/plan.md: hello")
    expect([asked.action, asked.detail]).toEqual(["files.write:notes/plan.md", "Let the agent write notes/plan.md."])
    await answer(asked.id, { _tag: "Approved" })
    expect(await file("notes/plan.md")).toBe("hello")
    expect(rows()).toContain("note: Approved: Let the agent write notes/plan.md.")
    // Only a path under scratch/ is allowed: one that holds scratch/ further in is asked about.
    const nested = await ask("Write notes/scratch/b.txt: x")
    expect(nested.action).toBe("files.write:notes/scratch/b.txt")
    await answer(nested.id, { _tag: "Refused" })
  })

  test("the buttons in the page's order: ask-first, then judge on the code it left, builds and judges", async () => {
    const asking = applied("ask-first")
    const both = applied("judge", asking)
    expect(both.agent).toBe(applied("judge").agent)
    const { result, say, questions, file } = await page(both)
    expect(result).toEqual({ _tag: "Built" })
    await say("Write scratch/a.txt: hello")
    expect(questions()).toEqual([])
    expect(await file("scratch/a.txt")).toBe("hello")
  })

  test("slow-writes: Stop between a write and its result leaves the file changed, the call with no result, and the Files tab showing the change", async () => {
    let wrote: () => void = () => {}
    const written = new Promise<void>((resolve) => { wrote = resolve })
    globalThis.workspaceLessonWrote = () => wrote()
    // The experiment's workspace, with one line more for the test: it says when the write is made, before the wait.
    const slow = applied("slow-writes")
    const sources = { ...slow, workspace: (slow.workspace ?? "").replace('Effect.sleep("4 seconds")', 'Effect.andThen(Effect.sync(() => globalThis.workspaceLessonWrote()), Effect.sleep("4 seconds"))') }
    expect(sources.workspace).not.toBe(slow.workspace)
    const { runtime, send, pane, file, say, prompts, lines } = await page(sources)
    await pane.choose("docs/guide.md")
    send("Write late.txt: hello")
    await written
    // The file is written, and nothing has said so: the tool answers after the wait.
    expect(await file("late.txt")).toBe("hello")
    expect(pane.current.paths).not.toContain("late.txt")
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    await pane.settled()
    // The turn ended, stopped: the tab read the workspace again, and lists the file.
    expect(pane.current.paths).toContain("late.txt")
    const journal = await runtime.journal()
    expect(outcomes(journal)).toEqual(["Interrupted"])
    expect(journal.map((event) => String(event.name))).toEqual(["core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended"])
    // The answer's record holds the call, and no record holds its result.
    const asked = journal[2]?.message
    expect(asked?._tag === "Assistant" ? asked.toolCalls.map((call) => [call.name, call.input]) : []).toEqual([["writeFile", { path: "late.txt", text: "hello" }]])
    // No write was said: the tool never got that far, so the status line says nothing of it.
    expect(lines()).toEqual([])
    // The next turn's prompt does not send the call with no result: the message, the answer's words, and the new message.
    await say("Thanks.")
    expect(prompts().at(-1)?.messages.filter((message) => message.role !== "system").map((message) => [message.role, message.text])).toEqual([
      ["user", "Write late.txt: hello"], ["assistant", "Let me work that out."], ["user", "Thanks."],
    ])
  })
})

describe("lesson 15's page, as one walk", () => {
  test("the steps in the page's order on one runtime: the files carry each step's changes into the next", async () => {
    const { runtime, say, send, replies, prompts, pane, personSaves, file, lines } = await page()
    // Step 1: a list, a read, an edit; the Files tab shows the edit, and the status line says the write.
    await say("List the files.", "Read notes/todo.md.", "In notes/todo.md replace call Ana with call Ana at noon.")
    expect(replies()).toEqual([
      "I see 3 files: docs/guide.md, notes/long.md, notes/todo.md.",
      'I read notes/todo.md, characters 0 to 22 of 22: "- buy milk - call Ana"',
      "I changed notes/todo.md: it holds 30 characters now.",
    ])
    await pane.choose("notes/todo.md")
    expect(pane.current.draft).toBe("- buy milk\n- call Ana at noon\n")
    expect(lines()).toEqual(["wrote notes/todo.md"])
    // Step 3: Rebuild runs the program again over the same files.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(await file("notes/todo.md")).toBe("- buy milk\n- call Ana at noon\n")
    // Step 4: a long file a page at a time, and a path that would leave the workspace.
    await say("Read notes/long.md.", "Read notes/long.md from 4000.", "Read ../secret.txt")
    expect(replies().slice(3).map((reply) => reply.split(": ")[0])).toEqual([
      "I read notes/long.md, characters 0 to 4000 of 6246",
      "I read notes/long.md, characters 4000 to 6246 of 6246",
      "The tool answered",
    ])
    expect(replies().at(-1)).toContain('is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \\"..\\", such as notes/todo.md.')
    // Step 5: the read is what the journal holds. The file changed in the Files tab, the next prompt sends what was read.
    await say("Read notes/todo.md.")
    expect(replies().at(-1)).toBe('I read notes/todo.md, characters 0 to 30 of 30: "- buy milk - call Ana at noon"')
    await personSaves("notes/todo.md", (text) => text.replace("milk", "bread"))
    expect(pane.current.notice).toBe("Saved notes/todo.md.")
    await say("Thanks.")
    const read = `readFile → ${JSON.stringify({ path: "notes/todo.md", text: "- buy milk\n- call Ana at noon\n", from: 0, to: 30, total: 30 })}`
    expect(prompts().at(-1)?.messages.at(-3)?.text).toBe(read)
    expect(prompts().at(-1)?.messages.some((message) => message.text.includes("bread"))).toBe(false)
    // The stale edit: the text to find is not there any more, in the kernel's words, and the person's change stands.
    await say("In notes/todo.md replace milk with eggs.")
    expect(replies().at(-1)).toContain("The text to find is not in notes/todo.md, so nothing was changed.")
    expect(await file("notes/todo.md")).toBe("- buy bread\n- call Ana at noon\n")
    expect(lines().at(-1)).toBe("editFile: nothing written, it failed")
    // Step 6: a draft in the Files tab, the agent's write, the draft kept; Save refused, the file shown as it is.
    pane.edit("- buy cheese\n")
    await say("Write notes/todo.md: - buy rice")
    expect(pane.current).toMatchObject({ draft: "- buy cheese\n", changed: true, notice: "notes/todo.md was changed in the workspace while you were editing it. Your text is kept here, and Save will not write over that change." })
    await pane.save()
    expect(pane.current).toMatchObject({ draft: "- buy rice", notice: "notes/todo.md was changed since this pane loaded it, so your text was not saved. It is shown as it is now: make your change again." })
    expect(await file("notes/todo.md")).toBe("- buy rice")
    // Step 8: writes answered late, Stop between a write and its result: the file is changed, the tab lists it.
    let wrote: () => void = () => {}
    const written = new Promise<void>((resolve) => { wrote = resolve })
    globalThis.workspaceLessonWrote = () => wrote()
    const slow = applied("slow-writes")
    expect(await runtime.start({ ...slow, workspace: (slow.workspace ?? "").replace('Effect.sleep("4 seconds")', 'Effect.andThen(Effect.sync(() => globalThis.workspaceLessonWrote()), Effect.sleep("4 seconds"))') })).toEqual({ _tag: "Built" })
    send("Write late.txt: hello")
    await written
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    await pane.settled()
    expect(pane.current.paths).toEqual(["docs/guide.md", "late.txt", "notes/long.md", "notes/todo.md"])
    expect(await file("late.txt")).toBe("hello")
    expect(outcomes(await runtime.journal()).at(-1)).toBe("Interrupted")
    // Reset: the starter code again, over the same files.
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await say("Read late.txt")
    expect(replies().at(-1)).toBe('I read late.txt, characters 0 to 5 of 5: "hello"')
  })
})
