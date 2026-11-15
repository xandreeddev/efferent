// Lesson 7 on the page's runtime, with Echo: the conversation is kept by the
// learner's store in a storage that outlives the page, the chat finds it
// again after a reload and closes the turn the page before left open, and
// every experiment does what the page says. A reload here is a second
// runtime over the same storage, after the first one's view of it was
// closed: a closed page can write nothing more.
import { afterEach, describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { messageOf, toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { KeyValueStore } from "@xandreed/sdk/kernel"
import { chatRowsOf, emptyChat, hear, sent, showing } from "../../chat-model.ts"
import { BEFORE_THIS_PAGE, emptyBoard, record, turnNumbersOf, viewOf } from "../../trace-model.ts"
import { callIds } from "../../models/call-ids.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { keepTheConversation, STORAGE_PREFIX } from "./lesson.ts"

const SOURCES: Record<string, string> = Object.fromEntries(keepTheConversation.files.map((file) => [file.id, file.defaultText]))
const applied = (id: string, sources = SOURCES) => {
  const experiment = keepTheConversation.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}

/** What stands for the browser's storage: strings by key, kept for the whole test. */
const storageOf = (): KeyValueStore & { readonly keys: () => ReadonlyArray<string> } => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    keys: () => Array.from(values.keys()),
  }
}

/** A page's view of the storage, and how the test closes that page: every call of a closed view throws. */
const pageView = (storage: KeyValueStore) => {
  let open = true
  const live = <A>(run: () => A): A => {
    if (!open) throw new Error("this page is closed")
    return run()
  }
  const view: KeyValueStore = {
    get length() { return live(() => storage.length) },
    key: (index) => live(() => storage.key(index)),
    getItem: (key) => live(() => storage.getItem(key)),
    setItem: (key, value) => live(() => storage.setItem(key, value)),
    removeItem: (key) => live(() => storage.removeItem(key)),
  }
  return { view, close: () => { open = false } }
}

const opened: Array<{ readonly runtime: LessonRuntime; readonly close: () => void }> = []
// A closed page's turn cannot store its end: disposing it fails, as nothing of it runs any more in a browser.
afterEach(async () => { await Promise.all(opened.splice(0).map(({ runtime, close }) => { close(); return runtime.dispose().catch(() => undefined) })) })

/** A page over the storage: the runtime, what it heard, and how to close the page as a reload does. */
const page = async (storage: KeyValueStore, sources = SOURCES, model = loadEcho()) => {
  const { view, close } = pageView(storage)
  const runtime = await LessonRuntime.create(keepTheConversation, { storage: view })
  opened.push({ runtime, close })
  runtime.setModel(model)
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  const until = (match: (trace: Trace) => boolean, count = 1) => new Promise<void>((resolve) => {
    let seen = 0
    const stop = runtime.onTrace((trace) => { if (match(trace) && ++seen >= count) { stop(); resolve() } })
  })
  const result = await runtime.start(sources)
  const say = async (text: string) => { const done = until((trace) => trace._tag === "Reply" || trace._tag === "Failed"); runtime.send(text); await done }
  const shown = () => heard.flatMap((trace) => trace._tag === "Showing" ? [trace] : [])
  const replies = () => heard.flatMap((trace) => trace._tag === "Reply" ? [trace.text] : trace._tag === "Failed" ? [`failed: ${trace.message}`] : [])
  return { runtime, heard, result, until, say, shown, replies, close }
}
const outcomes = (events: ReadonlyArray<{ readonly name: string; readonly data: unknown }>) =>
  events.flatMap((event) => event.name === turnEndedEvent.name ? [(event.data as { readonly outcome: { readonly _tag: string } }).outcome._tag] : [])

describe("lesson 7 on the page (the kernel, Echo)", () => {
  test("the conversation outlives the page: the next page shows the same session, draws what was stored, and the agent still knows it", async () => {
    const storage = storageOf()
    const first = await page(storage)
    expect(first.result).toEqual({ _tag: "Built" })
    await first.say("My name is Ana.")
    const before = await first.runtime.journal()
    first.close()

    const second = await page(storage)
    expect(second.result).toEqual({ _tag: "Built" })
    expect(second.shown().map((trace) => trace.session)).toEqual([first.runtime.conversation])
    expect(second.runtime.conversation).toBe(first.runtime.conversation)
    // What the page draws when it loads is the journal the page before it wrote, record for record.
    expect(second.shown()[0]?.journal).toEqual(before)
    expect(chatRowsOf(second.shown()[0]?.journal ?? []).map((row) => `${row.kind}: ${row.text}`)).toEqual(["user: My name is Ana.", `agent: ${first.replies()[0]}`])
    await second.say("What did I say earlier?")
    expect(second.replies()).toEqual(['Earlier you said: "My name is Ana.".'])
    // The Context tab: the turn from before the reload is there with what it stored, and says its prompt was not; the new one has its own.
    const board = second.heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(second.runtime.conversation))
    expect(turnNumbersOf(board)).toEqual([1, 2])
    const [old, fresh] = [viewOf(board, 1), viewOf(board, 2)]
    expect([old.restored, fresh.restored]).toEqual([true, false])
    expect(old.steps.map((step) => [step.id, step.state])).toEqual([
      ["opened", "done"], ["stored-message", "done"], ["context-1", "skipped"], ["prompt-1", "skipped"], ["streamed-1", "done"], ["stored-answer-1", "done"], ["closed", "done"],
    ])
    expect(old.steps.find((step) => step.id === "prompt-1")?.detail).toBe(BEFORE_THIS_PAGE)
    expect(old.steps.find((step) => step.id === "stored-answer-1")?.code).toBe("stored before this page loaded")
    expect(Option.isNone(old.calls[0]!.prompt) && Option.isSome(fresh.calls[0]!.prompt)).toBe(true)
    expect(fresh.steps.find((step) => step.id === "stored-answer-1")?.code).toBe("modelAnswer(stream, session)")
    expect((await second.runtime.journal()).filter((record) => record.name === userMessageEvent.name).map((record) => Number(record.turn))).toEqual([1, 2])
    // Every key is under the lesson's prefix, then the program's own.
    expect(storage.keys().every((key) => key.startsWith(`${STORAGE_PREFIX}agent:`))).toBe(true)
    expect(outcomes(await second.runtime.journal())).toEqual(["Completed", "Completed"])
  }, 20_000)

  test("a reload while a tool runs: the next page closes the turn as abandoned, draws its line, and goes on without the unanswered call", async () => {
    const storage = storageOf()
    const first = await page(storage, applied("slow-calculator"))
    const running = first.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    first.runtime.send("What is 6 * 7?")
    await running
    first.close()

    const second = await page(storage)
    const journal = second.shown()[0]?.journal ?? []
    expect(outcomes(journal)).toEqual(["Abandoned"])
    expect(journal.at(-1)?.name).toBe(turnEndedEvent.name)
    expect(chatRowsOf(journal).map((row) => `${row.kind}: ${row.text}`)).toEqual([
      "user: What is 6 * 7?",
      "agent: Let me work that out.",
      "note: Turn 1 was left open by a page that closed, and was closed when the next one started. What it stored stays in the journal.",
    ])
    await second.say("Hello again.")
    expect(second.replies()).toHaveLength(1)
    expect(outcomes(await second.runtime.journal())).toEqual(["Abandoned", "Completed"])
    // The call the closed page never answered is in the journal and not in the prompt: a provider would refuse it.
    const prompt = second.heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : [])).at(-1)!
    expect(prompt.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"])
    expect(prompt.messages[2]?.callIds).toEqual([])
    expect((await second.runtime.journal()).filter((record) => record.name === toolResultEvent.name)).toEqual([])
  }, 30_000)

  test("a call id that starts again with the page: the call the closed page left open is still not sent once the same id was asked again and answered", async () => {
    // A model that numbers its calls starts from one on every page: both pages mint the same ids.
    const sameIds = () => loadEcho(callIds("echo-call", "page"))
    const storage = storageOf()
    const first = await page(storage, applied("slow-calculator"), sameIds())
    const running = first.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    first.runtime.send("What is 6 * 7?")
    await running
    first.close()

    const second = await page(storage, SOURCES, sameIds())
    await second.say("What is 2 + 2?")
    expect(second.replies()).toEqual(["The tool answered: calculator says 4."])
    const stored = (await second.runtime.journal()).flatMap((record) => Option.toArray(messageOf(record)))
    const ids = stored.flatMap((message) => message._tag === "Assistant" ? message.toolCalls.map((call) => String(call.id)) : message._tag === "ToolResult" ? [String(message.id)] : [])
    // The journal holds the open call, the call after the reload and its result, all under one id.
    expect(ids).toEqual(["echo-call-page-1", "echo-call-page-1", "echo-call-page-1"])
    // The last prompt sends the answered call with its result, and the first turn's answer without its call.
    const prompt = second.heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : [])).at(-1)!
    expect(prompt.messages.map((message) => `${message.role} ${(message.callIds ?? []).length}`)).toEqual(["system 0", "user 0", "assistant 0", "user 0", "assistant 1", "tool 0"])
    // The chat drawn from that journal names each result's own call, though three records share the id.
    expect(chatRowsOf(await second.runtime.journal()).map((row) => `${row.kind}: ${row.text}`)).toEqual([
      "user: What is 6 * 7?",
      "agent: Let me work that out.",
      "note: Turn 1 was left open by a page that closed, and was closed when the next one started. What it stored stays in the journal.",
      "user: What is 2 + 2?",
      "agent: Let me work that out.",
      "tool: calculator({\"a\":2,\"op\":\"+\",\"b\":2}) → 4",
      "agent: The tool answered: calculator says 4.",
    ])
  }, 30_000)

  test("without recover in chat.ts the conversation is found and stays busy: the message fails, and says what to call", async () => {
    const storage = storageOf()
    const first = await page(storage, applied("slow-calculator"))
    const running = first.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    first.runtime.send("What is 6 * 7?")
    await running
    first.close()

    const second = await page(storage, applied("no-recover"))
    expect(second.runtime.conversation).toBe(first.runtime.conversation)
    expect(outcomes(second.shown()[0]?.journal ?? [])).toEqual([])
    let board = showing(emptyChat, second.shown()[0]?.journal ?? [], false)
    second.runtime.onTrace((trace) => { board = hear(board, trace, second.runtime.conversation) })
    board = sent(board, "Hello again.")
    await second.say("Hello again.")
    // In the chat: the message was taken and never stored, and the program's failure follows it.
    expect(board.rows.slice(-2).map((row) => [row.kind, row.text, row.dropped ?? ""])).toEqual([
      ["user", "Hello again.", "not stored: its turn ended before it was"],
      ["error", "turn 1 is still open: if the writer that opened it is gone, close it with `Sessions.recover`", ""],
    ])
    expect(second.replies()).toEqual(["failed: turn 1 is still open: if the writer that opened it is gone, close it with `Sessions.recover`"])
    // Nothing was stored for the refused message.
    expect((await second.runtime.journal()).filter((record) => record.name === userMessageEvent.name)).toHaveLength(1)
  }, 30_000)

  test("Run the kit: the store as written passes every check, a second handle on the same storage included", async () => {
    const { runtime } = await page(storageOf())
    const ran = Result.getOrThrow(await runtime.runKit("store", SOURCES))
    expect(ran.map((check) => [check.id, check.passed])).toEqual([["create", true], ["append", true], ["conflict", true], ["read-from", true], ["missing", true], ["list", true], ["reopens", true]])
  })

  test("a store with no place check fails the kit's check of a conflict, which says what it saw", async () => {
    const { runtime } = await page(storageOf())
    const ran = Result.getOrThrow(await runtime.runKit("store", applied("no-place-check")))
    expect(ran.filter((check) => !check.passed).map((check) => check.id)).toEqual(["conflict", "reopens"])
    expect(ran.find((check) => check.id === "conflict")?.message).toBe("an append behind the journal was accepted, not refused with SeqConflict")
  })

  test("a store that keeps its events in the page's memory works until the page is gone: the kit's reopening fails, and the next page finds the conversation empty", async () => {
    const storage = storageOf()
    const forgetful = applied("forgets-events")
    const first = await page(storage, forgetful)
    await first.say("My name is Ana.")
    expect(await first.runtime.journal()).toHaveLength(4)
    const ran = Result.getOrThrow(await first.runtime.runKit("store", forgetful))
    expect(ran.filter((check) => !check.passed).map((check) => check.id)).toEqual(["reopens"])
    first.close()

    const second = await page(storage, forgetful)
    expect(second.runtime.conversation).toBe(first.runtime.conversation)
    expect(second.shown()[0]?.journal).toEqual([])
    await second.say("What did I say earlier?")
    expect(second.replies()[0]).not.toContain("Ana")
  }, 20_000)

  test("the store changed under a conversation with history: the same session has another journal, and the chat is drawn from that one", async () => {
    const storage = storageOf()
    const first = await page(storage)
    await first.say("My name is Ana.")
    let board = emptyChat
    // The page's own step for a conversation named again: the same session every time here.
    const follow = (trace: Trace) => { board = trace._tag === "Showing" ? showing(board, trace.journal, true) : hear(board, trace, first.runtime.conversation) }
    first.heard.forEach(follow)
    first.runtime.onTrace(follow)
    // The forgetful store finds the session's header and none of its events: the journal starts again at 1.
    expect(await first.runtime.start(applied("forgets-events"))).toEqual({ _tag: "Built" })
    expect(first.shown().map((trace) => trace.journal.length)).toEqual([0, 0])
    board = sent(board, "What did I say earlier?")
    await first.say("What did I say earlier?")
    const told = (rows: ReadonlyArray<{ readonly kind: string; readonly text: string; readonly seq?: number }>) => rows.map((row) => `${row.kind}${row.seq === undefined ? "*" : ""}: ${row.text}`)
    expect(told(board.rows)).toEqual(told(chatRowsOf(await first.runtime.journal())))
    expect(board.rows).toHaveLength(2)
    // And back: the store as written again holds the first journal, which is what the chat shows.
    expect(await first.runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(told(board.rows)).toEqual(told(chatRowsOf(await first.runtime.journal())))
    expect(board.rows.map((row) => row.text)[0]).toBe("My name is Ana.")
  }, 20_000)

  test("a store with no place check still runs a conversation: one writer, in order, never needs the check", async () => {
    const { say, replies } = await page(storageOf(), applied("no-place-check"))
    await say("My name is Ana.")
    await say("What did I say earlier?")
    expect(replies().at(-1)).toBe('Earlier you said: "My name is Ana.".')
  }, 20_000)

  test("Clear context adds one session to the store, the one shown from then on, and a reload shows it again", async () => {
    const storage = storageOf()
    const first = await page(storage)
    await first.say("My name is Ana.")
    const old = first.runtime.conversation
    // Two sessions created in the same millisecond are listed by id: a learner's click comes later than that.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await first.runtime.clear()).toEqual({ _tag: "Built" })
    const listed = await first.runtime.list()
    expect(listed.map((header) => [header.id === old, header.owner, header.parent])).toEqual([[true, "learner", undefined], [false, "learner", undefined]])
    expect(first.runtime.conversation).toBe(listed[1]!.id as typeof old)
    expect(first.shown().map((trace) => trace.session)).toEqual([old, listed[1]!.id])
    expect(first.shown()[1]?.journal).toEqual([])
    await first.say("What did I say earlier?")
    expect(first.replies().at(-1)).not.toContain("Ana")
    first.close()

    const second = await page(storage)
    expect(second.runtime.conversation).toBe(listed[1]!.id as typeof old)
    expect((await second.runtime.list()).length).toBe(2)
  }, 20_000)

  test("a conversation this kernel cannot read is left where it is: the next page starts a new one, and both are listed", async () => {
    const storage = storageOf()
    const first = await page(storage)
    await first.say("My name is Ana.")
    const old = first.runtime.conversation
    first.close()
    // As a later kernel would have written it.
    const key = `${STORAGE_PREFIX}agent:${old}:header`
    storage.setItem(key, (storage.getItem(key) ?? "").replace(/"format":\d+/, '"format":99'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    const second = await page(storage)
    expect(second.result).toEqual({ _tag: "Built" })
    expect(second.runtime.conversation).not.toBe(old)
    expect((await second.runtime.list()).map((header) => header.format)).toEqual([99, 2])
    await second.say("Hello.")
    expect(second.replies()).toHaveLength(1)
  }, 20_000)

  test("a rebuild keeps the conversation and a message that waited: it is answered in the same session, and nothing is drawn twice", async () => {
    const storage = storageOf()
    const first = await page(storage)
    await first.say("My name is Ana.")
    let board = first.heard.reduce((now, trace) => trace._tag === "Showing" ? showing(now, trace.journal, false) : hear(now, trace, first.runtime.conversation), emptyChat)
    first.runtime.onTrace((trace) => { board = trace._tag === "Showing" ? showing(board, trace.journal, true) : hear(board, trace, first.runtime.conversation) })
    const done = first.until((trace) => trace._tag === "Reply")
    board = sent(board, "What did I say earlier?")
    first.runtime.send("What did I say earlier?")
    expect(await first.runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await done
    expect(first.shown().map((trace) => trace.session)).toEqual([first.runtime.conversation, first.runtime.conversation])
    expect(board.rows.map((row) => `${row.kind}${row.seq === undefined ? "*" : ""}: ${row.text}`)).toEqual(chatRowsOf(await first.runtime.journal()).map((row) => `${row.kind}: ${row.text}`))
    expect(board.rows.filter((row) => row.kind === "user").map((row) => row.text)).toEqual(["My name is Ana.", "What did I say earlier?"])
  }, 20_000)

  test("Stop in the middle of a turn, then the program starts again: its chat finds the conversation free, and the next message is answered", async () => {
    const { runtime, say, until, shown, replies } = await page(storageOf(), applied("slow-calculator"))
    const running = until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    runtime.send("What is 6 * 7?")
    await running
    expect((await runtime.stop()).result).toEqual({ _tag: "Built" })
    // The stopped turn was closed by the page that opened it: there is nothing for recover to do, and it refuses nothing.
    expect(outcomes(shown().at(-1)?.journal ?? [])).toEqual(["Interrupted"])
    await say("Hello again.")
    expect(replies()).toHaveLength(1)
    expect(outcomes(await runtime.journal())).toEqual(["Interrupted", "Completed"])
  }, 30_000)

  test("every experiment and control finds its line in the starter code", () => {
    expect(Object.keys(keepTheConversation.experiments)).toEqual(["slow-calculator", "no-recover", "no-place-check", "forgets-events"])
    for (const [id, experiment] of Object.entries(keepTheConversation.experiments)) {
      const source = SOURCES[experiment.file] ?? ""
      const next = experiment.apply(source)
      expect([id, Option.isSome(next) && next.value !== source]).toEqual([id, true])
    }
    const control = keepTheConversation.controls.system!
    expect(Option.flatMap(control.write(SOURCES.agent ?? "", "You are a pirate."), control.read)).toEqual(Option.some("You are a pirate."))
  })
})
