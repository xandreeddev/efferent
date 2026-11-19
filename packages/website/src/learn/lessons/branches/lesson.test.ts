// Lesson 15 on the page's runtime, with Echo: a branch is made by the
// learner's branchFrom on the page's own sessions, the row of chats lists it,
// a chat picked is shown and drawn anew, a turn running goes on while a
// branch is made, and every experiment does what the page says. The chat is
// followed as the page follows it (`drawsAnew`, `showing`, `hear`), so a
// claim about what it shows is about the page's own steps. A reload is a
// second runtime over the same storage, after the first one's view of it was
// closed; the tab's storage goes with it, or not, as a reload or a new tab.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Result } from "effect"
import { kernel, Sessions, turnEndedEvent, TurnNumber, userMessageEvent } from "@xandreed/core"
import type { StoredEvent } from "@xandreed/core"
import { sessions, webStorageJournal } from "@xandreed/sdk"
import type { KeyValueStore } from "@xandreed/sdk"
import { branchPoints, chatRowsOf, drawsAnew, emptyChat, hear, sent, showing } from "../../chat-model.ts"
import type { ChatBoard } from "../../chat-model.ts"
import { ignoredLine } from "../../chats.ts"
import { BEFORE_THIS_PAGE, emptyBoard, record, turnNumbersOf, viewOf } from "../../trace-model.ts"
import { loadEcho } from "../../models/mock.ts"
import { CHOSEN_KEY, LessonRuntime, NOT_RUNNING, prefixed } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { branches, STORAGE_PREFIX } from "./lesson.ts"

const SOURCES: Record<string, string> = Object.fromEntries(branches.files.map((file) => [file.id, file.defaultText]))
const applied = (id: string, sources = SOURCES) => {
  const experiment = branches.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}
const turn = (n: number) => TurnNumber.make(n)
const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

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

/** A row as the tests read it: its kind, a star when it has no record behind it, its text. */
const told = (rows: ReadonlyArray<{ readonly kind: string; readonly text: string; readonly seq?: number }>) => rows.map((row) => `${row.kind}${row.seq === undefined ? "*" : ""}: ${row.text}`)

/**
 * A page over the storage and a tab's storage: the runtime, what it heard, and the chat as the page draws it. A
 * `Showing` is drawn anew or taken as the page decides (`drawsAnew`), every other trace heard as the page hears it.
 */
const page = async (storage: KeyValueStore, tab: KeyValueStore = storageOf(), sources = SOURCES) => {
  const { view, close } = pageView(storage)
  const runtime = await LessonRuntime.create(branches, { storage: view, tab })
  opened.push({ runtime, close })
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  let board: ChatBoard = emptyChat
  let shownSession: string | undefined
  runtime.onTrace((trace) => {
    heard.push(trace)
    if (trace._tag === "Showing") {
      board = showing(board, trace.journal, !drawsAnew(board, shownSession, trace))
      shownSession = trace.session
    } else board = hear(board, trace, runtime.conversation)
  })
  const until = (match: (trace: Trace) => boolean, count = 1) => new Promise<void>((resolve) => {
    let seen = 0
    const stop = runtime.onTrace((trace) => { if (match(trace) && ++seen >= count) { stop(); resolve() } })
  })
  const result = await runtime.start(sources)
  /** Send as the page does: the row first, then the message to the queue. */
  const send = (text: string) => { board = sent(board, text); runtime.send(text) }
  const say = async (text: string) => { const done = until((trace) => trace._tag === "Reply" || trace._tag === "Failed"); send(text); await done }
  const shown = () => heard.flatMap((trace) => trace._tag === "Showing" ? [trace] : [])
  const replies = () => heard.flatMap((trace) => trace._tag === "Reply" ? [trace.text] : trace._tag === "Failed" ? [`failed: ${trace.message}`] : [])
  const labels = async () => (await runtime.chats()).map((chat) => `${chat.label}${chat.id === runtime.conversation ? " (shown)" : ""}`)
  return { runtime, heard, result, until, send, say, shown, replies, labels, close, board: () => board }
}

const outcomes = (events: ReadonlyArray<{ readonly name: string; readonly data: unknown }>) =>
  events.flatMap((event) => event.name === turnEndedEvent.name ? [(event.data as { readonly outcome: { readonly _tag: string } }).outcome._tag] : [])

/** A store of the kernel's own over the same storage and prefix as the page's program: how a test puts a session there the page did not make. */
const sideStore = (storage: KeyValueStore) =>
  sessions().pipe(Layer.provideMerge(webStorageJournal(prefixed(storage, STORAGE_PREFIX), { prefix: "agent:" })), Layer.provideMerge(kernel()))

/** Two turns in a chat: a name, then a sum. */
const twoTurns = async (one: Awaited<ReturnType<typeof page>>) => {
  await one.say("My name is Ana.")
  await one.say("What is 12 * 3?")
}

describe("lesson 15 on the page (the kernel, Echo)", () => {
  test("the page's steps 1, 3 and 6 as one walk: two messages, a branch after turn 1 shown and asked, its copied turn in Context, then Chat 1 again and a branch after the sum", async () => {
    const one = await page(storageOf())
    // Step 1.
    await one.say("My name is Ana.")
    await one.say("What is 12 * 3?")
    const chat = one.runtime.conversation
    const at = (board: ChatBoard) => [...branchPoints(board)].map(([id, n]) => `${Number(n)}: ${board.rows.find((row) => row.id === id)?.text}`)
    expect(at(one.board())).toEqual([`1: ${one.replies()[0]}`, "2: The tool answered: calculator says 36."])
    const first = Result.getOrThrow(await one.runtime.branch(turn(1)))
    expect(await one.labels()).toEqual(["Chat 1 (shown)", "Chat 1, branch after turn 1"])
    await one.runtime.choose(first)
    expect(told(one.board().rows)).toEqual(["user: My name is Ana.", `agent: ${one.replies()[0]}`])
    await one.say("What did I say earlier?")
    expect(one.replies().at(-1)).toBe('Earlier you said: "My name is Ana.".')
    // Step 3: the branch's header, and its first turn in Context.
    expect(one.shown().at(-1)?.branch).toEqual({ of: chat, through: 4, label: "Chat 1" })
    const from = one.heard.findLastIndex((trace) => trace._tag === "Showing")
    const board = one.heard.slice(from).reduce((all, trace) => record(all, trace, 0), emptyBoard(first))
    expect([viewOf(board, 1).readBack.head, viewOf(board, 2).restored]).toEqual(["copied from Chat 1", false])
    // Step 6: Chat 1 again, a branch after the sum, shown, and a message there.
    await one.runtime.choose(chat)
    expect(told(one.board().rows)).toHaveLength(6)
    await pause()
    const second = Result.getOrThrow(await one.runtime.branch(turn(2)))
    expect(await one.labels()).toEqual(["Chat 1 (shown)", "Chat 1, branch after turn 1", "Chat 1, branch after turn 2"])
    await one.runtime.choose(second)
    await one.say("Thanks.")
    const prompt = one.heard.flatMap((trace) => trace._tag === "Prompt" ? [trace] : []).at(-1)!
    expect(prompt.messages.slice(3, 6).map((message) => `${message.role} ${(message.callIds ?? []).length}: ${message.text}`)).toEqual([
      "user 0: What is 12 * 3?", 'assistant 1: Let me work that out. · calls calculator({"a":12,"op":"*","b":3})', "tool 0: calculator → 36",
    ])
  }, 30_000)

  test("a branch after a turn stopped while the slow calculator worked: the message, the words before the call and the stopped line are copied; the call with no result is never sent, and Echo answers the new message alone", async () => {
    const one = await page(storageOf(), storageOf(), applied("slow-calculator"))
    await one.say("My name is Ana.")
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    one.send("What is 6 * 7?")
    await running
    await one.runtime.stop()
    const branch = Result.getOrThrow(await one.runtime.branch(turn(2)))
    await one.runtime.choose(branch)
    expect(told(one.board().rows).slice(2)).toEqual(["user: What is 6 * 7?", "agent: Let me work that out.", "note: Turn 2 was stopped. Your message stays in the journal."])
    await one.say("Hello.")
    expect(one.replies().at(-1)).toBe("Hello! I'm Echo, a scripted stand-in model. Ask me what you said earlier and I'll answer from the messages I was sent.")
    const prompt = one.heard.flatMap((trace) => trace._tag === "Prompt" ? [trace] : []).at(-1)!
    expect(prompt.messages.map((message) => `${message.role} ${(message.callIds ?? []).length}`)).toEqual(["system 0", "user 0", "assistant 0", "user 0", "assistant 0", "user 0"])
  }, 30_000)

  test("Branch after turn 1 makes a branch with the learner's branchFrom: the row of chats lists it, the chat shown stays, and its journal is the chat's up to that turn", async () => {
    const storage = storageOf()
    const one = await page(storage)
    expect(one.result).toEqual({ _tag: "Built" })
    await twoTurns(one)
    const chat = one.runtime.conversation
    expect(await one.labels()).toEqual(["Chat 1 (shown)"])
    const made = await one.runtime.branch(turn(1))
    expect(Result.isSuccess(made)).toBe(true)
    // Nothing switched: the same chat is shown, by the same program, and it is now the one asked for.
    expect(one.runtime.conversation).toBe(chat)
    expect(one.shown().map((trace) => trace.session)).toEqual([chat])
    expect(one.runtime.chosen).toEqual(Option.some(chat))
    expect(await one.labels()).toEqual(["Chat 1 (shown)", "Chat 1, branch after turn 1"])
    // The branch is the chat's journal up to the end of turn 1, record for record; the chat is unchanged.
    const all = await one.runtime.journal()
    const branchId = Result.getOrThrow(made)
    expect(await one.runtime.chats().then((chats) => chats[1]?.id)).toBe(branchId)
    expect(outcomes(all)).toEqual(["Completed", "Completed"])
    // Two chats, the branch made with no turn of its own.
    expect((await one.runtime.list()).map((header) => [header.id === chat, header.owner, header.parent])).toEqual([[true, "learner", undefined], [false, "learner", undefined]])
  }, 20_000)

  test("the branch holds the chat's first turn and nothing after it: picked, it is drawn anew from its journal, and Echo answers from the copied message", async () => {
    const one = await page(storageOf())
    await twoTurns(one)
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    const before = await one.runtime.journal()
    await pause()
    const { dropped, result } = await one.runtime.choose(branch)
    expect([dropped, result]).toEqual([[], { _tag: "Built" }])
    expect(one.runtime.conversation).toBe(branch)
    const copied = one.shown().at(-1)!
    expect(copied.journal).toEqual(before.slice(0, 4))
    expect(copied.branch).toEqual({ of: chat, through: 4, label: "Chat 1" })
    expect(told(one.board().rows)).toEqual(["user: My name is Ana.", `agent: ${one.replies()[0]}`])
    expect(await one.labels()).toEqual(["Chat 1", "Chat 1, branch after turn 1 (shown)"])
    await one.say("What did I say earlier?")
    expect(one.replies().at(-1)).toBe('Earlier you said: "My name is Ana.".')
  }, 20_000)

  test("a branch after the sum carries the calculator's call and result: the branch's next prompt sends them, as the chat's would", async () => {
    const one = await page(storageOf())
    await twoTurns(one)
    const branch = Result.getOrThrow(await one.runtime.branch(turn(2)))
    await one.runtime.choose(branch)
    await one.say("Thanks.")
    const prompt = one.heard.flatMap((trace) => trace._tag === "Prompt" ? [trace] : []).at(-1)!
    expect(prompt.messages.slice(3).map((message) => `${message.role} ${(message.callIds ?? []).length}: ${message.text}`)).toEqual([
      "user 0: What is 12 * 3?", 'assistant 1: Let me work that out. · calls calculator({"a":12,"op":"*","b":3})', "tool 0: calculator → 36", "assistant 0: The tool answered: calculator says 36.", "user 0: Thanks.",
    ])
  }, 20_000)

  test("ask the same thing two ways: a name and a sum, a branch after turn 1, then the sum asked another way in the branch; each chat keeps its own turn 2", async () => {
    const one = await page(storageOf())
    await one.say("My name is Ana.")
    await one.say("What is 12 * 3?")
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    await one.runtime.choose(branch)
    await one.say("What is 3 * 12?")
    const asked = (events: ReadonlyArray<StoredEvent>) => events.flatMap((event) => event.name === userMessageEvent.name && event.message?._tag === "User" ? [`${event.turn}: ${event.message.text}`] : [])
    expect(asked(await one.runtime.journal())).toEqual(["1: My name is Ana.", "2: What is 3 * 12?"])
    expect(one.replies().slice(1)).toEqual(["The tool answered: calculator says 36.", "The tool answered: calculator says 36."])
    await one.runtime.choose(chat)
    expect(asked(await one.runtime.journal())).toEqual(["1: My name is Ana.", "2: What is 12 * 3?"])
  }, 20_000)

  test("a long chat, its shorter branch, a message there, and back: each switch draws the chat shown from its own journal, the new rows in and the old ones gone", async () => {
    const one = await page(storageOf())
    await one.say("My name is Ana.")
    await one.say("What is 12 * 3?")
    await one.say("Remember to buy milk.")
    const chat = one.runtime.conversation
    const long = told(one.board().rows)
    expect(long).toEqual(told(chatRowsOf(await one.runtime.journal())))
    expect(long).toHaveLength(10)
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    await one.runtime.choose(branch)
    // The branch: the chat's first turn alone, drawn anew though its records hold the chat's places and times.
    expect(told(one.board().rows)).toEqual(long.slice(0, 2))
    await one.say("What did I say earlier?")
    const short = told(one.board().rows)
    expect(short).toEqual(told(chatRowsOf(await one.runtime.journal())))
    expect(short.slice(2)).toEqual(["user: What did I say earlier?", 'agent: Earlier you said: "My name is Ana.".'])
    // Back: the long chat as it was, and none of the branch's new rows.
    await one.runtime.choose(chat)
    expect(told(one.board().rows)).toEqual(long)
    // And to the branch again: its own turn 2 is there, the long chat's turns 2 and 3 are not.
    await one.runtime.choose(branch)
    expect(told(one.board().rows)).toEqual(short)
    // Each switch was a Showing the page drew anew, each of another session.
    expect(one.shown().map((trace) => trace.session)).toEqual([chat, branch, chat, branch])
  }, 30_000)

  test("Branch after turn N sits at the last stored row of each closed turn: not on a turn still open, and on rows drawn from the journal after a reload", async () => {
    const storage = storageOf()
    const tab = storageOf()
    const one = await page(storage, tab, applied("slow-calculator"))
    await one.say("My name is Ana.")
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    one.send("What is 6 * 7?")
    await running
    const points = (board: ChatBoard) => [...branchPoints(board)].map(([id, n]) => [board.rows.find((row) => row.id === id)?.text, Number(n)])
    // Turn 2 is open: only turn 1 has the button, at its answer.
    expect(points(one.board())).toEqual([[one.replies()[0], 1]])
    await one.until((trace) => trace._tag === "Reply")
    expect(points(one.board())).toEqual([[one.replies()[0], 1], ["The tool answered: calculator says 42.", 2]])
    one.close()

    const two = await page(storage, tab)
    expect(points(two.board())).toEqual([[one.replies()[0], 1], ["The tool answered: calculator says 42.", 2]])
    expect(two.board().rows.map((row) => row.turn)).toEqual([1, 1, 2, 2, 2, 2])
  }, 30_000)

  test("branch while a turn runs: the branch is cut at the last closed turn, and the turn in the chat shown goes on, unbroken", async () => {
    const one = await page(storageOf(), storageOf(), applied("slow-calculator"))
    await one.say("My name is Ana.")
    const chat = one.runtime.conversation
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    const answered = one.until((trace) => trace._tag === "Reply")
    one.send("What is 6 * 7?")
    await running
    expect(one.runtime.busy).toBe(true)
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    // Still running in the chat shown: no build, no switch.
    expect(one.runtime.busy).toBe(true)
    expect(one.shown()).toHaveLength(1)
    await answered
    expect(one.replies().at(-1)).toBe("The tool answered: calculator says 42.")
    expect(outcomes(await one.runtime.journal())).toEqual(["Completed", "Completed"])
    expect(one.runtime.conversation).toBe(chat)
    await one.runtime.choose(branch)
    expect(one.shown().at(-1)?.journal.map((event) => Number(event.turn))).toEqual([1, 1, 1, 1])
  }, 30_000)

  test("latest: branchFrom names no turn, so the cut is at the last closed turn whichever button is pressed; the same name twice is numbered", async () => {
    const one = await page(storageOf(), storageOf(), applied("latest"))
    await twoTurns(one)
    const first = Result.getOrThrow(await one.runtime.branch(turn(1)))
    // Two sessions made in one millisecond are listed by id: a second press comes later than that.
    await pause()
    const second = Result.getOrThrow(await one.runtime.branch(turn(1)))
    const chats = await one.runtime.chats()
    expect(chats.map((chat) => chat.label)).toEqual(["Chat 1", "Chat 1, branch after turn 2", "Chat 1, branch after turn 2 (2)"])
    expect(chats.slice(1).map((chat) => chat.id)).toEqual([first, second])
  }, 20_000)

  test("latest while a turn runs: the cut is at the turn before it, and the turn goes on", async () => {
    const one = await page(storageOf(), storageOf(), applied("latest", applied("slow-calculator")))
    await twoTurns(one)
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    const answered = one.until((trace) => trace._tag === "Reply")
    one.send("What is 6 * 7?")
    await running
    const during = Result.getOrThrow(await one.runtime.branch(turn(1)))
    await answered
    expect((await one.runtime.chats()).find((chat) => chat.id === during)?.label).toBe("Chat 1, branch after turn 2")
    expect(outcomes(await one.runtime.journal())).toEqual(["Completed", "Completed", "Completed"])
  }, 30_000)

  test("open-turn: branchFrom asks for the turn after the one pressed; the kernel refuses it, NoClosedTurn, in words, whether that turn never was or is open, and nothing is made", async () => {
    const one = await page(storageOf(), storageOf(), applied("open-turn", applied("slow-calculator")))
    await one.say("My name is Ana.")
    const chat = one.runtime.conversation
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail(`branch.ts made no branch: turn 2 of session ${chat} is not closed: a branch is cut at the end of a closed turn`))
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    one.send("What is 6 * 7?")
    await running
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail(`branch.ts made no branch: turn 2 of session ${chat} is not closed: a branch is cut at the end of a closed turn`))
    expect(await one.labels()).toEqual(["Chat 1 (shown)"])
  }, 30_000)

  test("resume-ignores: resume goes back to lesson 7's rule, the latest chat, which after a branch is the branch: picking Chat 1 shows the branch, and the page says resume ignored the pick", async () => {
    const one = await page(storageOf())
    await one.say("My name is Ana.")
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    const ignoring = applied("resume-ignores")
    expect(await one.runtime.start(ignoring)).toEqual({ _tag: "Built" })
    // The build shows the latest: the branch, though Chat 1 is the one asked for.
    expect([one.runtime.conversation, one.runtime.chosen]).toEqual([branch, Option.some(chat)])
    expect(ignoredLine(one.runtime.chosen, one.shown().at(-1)!.session, await one.runtime.chats())).toEqual(Option.some(
      "The page asked for Chat 1, and the resume in chat.ts showed Chat 1, branch after turn 1: it decides which chat is shown, and it did not take the one asked for.",
    ))
    await one.runtime.choose(chat)
    expect(one.shown().at(-1)?.session).toBe(branch)
    // As written, resume takes the pick: no word from the page.
    await one.runtime.start(SOURCES)
    expect(one.runtime.conversation).toBe(chat)
    expect(ignoredLine(one.runtime.chosen, one.shown().at(-1)!.session, await one.runtime.chats())).toEqual(Option.none())
  }, 30_000)

  test("a rebuild and Stop after a branch stay on the chat shown, not on the branch, which is the latest", async () => {
    const one = await page(storageOf())
    await twoTurns(one)
    const chat = one.runtime.conversation
    await one.runtime.branch(turn(1))
    expect(await one.runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    expect(one.runtime.conversation).toBe(chat)
    expect((await one.runtime.stop()).result).toEqual({ _tag: "Built" })
    expect(one.runtime.conversation).toBe(chat)
  }, 20_000)

  test("switching chats drops the messages waiting, which were written for the chat that was shown, and stops a turn running there", async () => {
    const one = await page(storageOf(), storageOf(), applied("slow-calculator"))
    await one.say("My name is Ana.")
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    const running = one.until((trace) => trace._tag === "Status" && trace.text.startsWith("step 1"))
    one.send("What is 6 * 7?")
    await running
    // Sent while the calculator works, it waits for the turn's next step, which the switch never lets come.
    one.send("Hello.")
    const { dropped } = await one.runtime.choose(branch)
    expect(dropped).toEqual(["Hello."])
    expect(outcomes(await (async () => { await one.runtime.choose(chat); return one.runtime.journal() })())).toEqual(["Completed", "Interrupted"])
  }, 30_000)

  test("Clear context with a chat picked: the pick is reset first, so the new chat, the latest, is the one shown", async () => {
    const tab = storageOf()
    const one = await page(storageOf(), tab)
    await twoTurns(one)
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    await one.runtime.choose(branch)
    expect(tab.getItem(`${STORAGE_PREFIX}${CHOSEN_KEY}`)).toBe(branch)
    await pause()
    expect(await one.runtime.clear()).toEqual({ _tag: "Built" })
    expect(one.runtime.chosen).toEqual(Option.none())
    expect(tab.getItem(`${STORAGE_PREFIX}${CHOSEN_KEY}`)).toBeNull()
    expect([chat, branch]).not.toContain(one.runtime.conversation)
    expect(await one.labels()).toEqual(["Chat 1", "Chat 1, branch after turn 1", "Chat 2 (shown)"])
    expect(one.board().rows).toEqual([])
  }, 20_000)

  test("a reload keeps the chat picked in the tab's storage and shows it again; a new tab shows the latest", async () => {
    const storage = storageOf()
    const tab = storageOf()
    const one = await page(storage, tab)
    await twoTurns(one)
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    one.close()

    // A reload: the same tab, so Chat 1, asked for when the branch was made, though the branch is the latest.
    const two = await page(storage, tab)
    expect(two.runtime.conversation).toBe(chat)
    await two.runtime.choose(branch)
    two.close()
    const three = await page(storage, tab)
    expect(three.runtime.conversation).toBe(branch)
    three.close()

    // Another tab has nothing kept: lesson 7's rule, the latest.
    const fresh = storageOf()
    await three.runtime.dispose().catch(() => undefined)
    const four = await page(storage, fresh)
    expect([four.runtime.conversation, four.runtime.chosen]).toEqual([branch, Option.none()])
    await four.runtime.choose(chat)
    expect(four.runtime.conversation).toBe(chat)
  }, 30_000)

  test("the row of chats lists the learner's own: not a helper, which has a parent, nor a session of another owner or another format", async () => {
    const storage = storageOf()
    const one = await page(storage)
    await one.say("My name is Ana.")
    const chat = one.runtime.conversation
    await pause()
    const key = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      yield* all.create({ owner: "learner", parent: chat })
      yield* all.create({ owner: "someone" })
      return yield* all.create({ owner: "learner" })
    }).pipe(Effect.provide(sideStore(storage))))
    const headerKey = `${STORAGE_PREFIX}agent:${key}:header`
    storage.setItem(headerKey, (storage.getItem(headerKey) ?? "").replace(/"format":\d+/, '"format":99'))
    expect((await one.runtime.list()).length).toBe(4)
    expect(await one.labels()).toEqual(["Chat 1 (shown)"])
  }, 20_000)

  test("with no program running there is no store to branch in: a first build refused, and one refused after a build that ran, say so in words", async () => {
    const storage = storageOf()
    const broken = { ...SOURCES, agent: "const main = 42" }
    const never = await page(storage, storageOf(), broken)
    expect(never.result._tag).toBe("Refused")
    expect(await never.runtime.branch(turn(1))).toEqual(Result.fail(NOT_RUNNING))
    expect(NOT_RUNNING).toBe("your program is not running, so no store is open to make a branch in. Fix it, then press Rebuild.")
    never.close()

    const once = await page(storageOf())
    await once.say("My name is Ana.")
    expect((await once.runtime.start(broken))._tag).toBe("Refused")
    expect(await once.runtime.branch(turn(1))).toEqual(Result.fail(NOT_RUNNING))
    expect(await once.labels()).toEqual(["Chat 1 (shown)"])
  }, 20_000)

  test("a branchFrom that gives no Effect, or an Effect of no session's id, is refused when pressed, in words that name it", async () => {
    const one = await page(storageOf(), storageOf(), { ...SOURCES, branch: "const branchFrom = () => 42" })
    await one.say("My name is Ana.")
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail("branch.ts made no branch: branchFrom did not give an Effect. It should give the branch, as sessions.fork does."))
    expect(await one.runtime.start({ ...SOURCES, branch: "const branchFrom = () => Effect.succeed(42)" })).toEqual({ _tag: "Built" })
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail("branch.ts made no branch: branchFrom gave no conversation's id: it gave 42."))
    expect(await one.runtime.start({ ...SOURCES, branch: 'const branchFrom = () => { throw new Error("no") }' })).toEqual({ _tag: "Built" })
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail("branch.ts made no branch: no"))
  }, 20_000)

  test("the Context tab: a branch's copied turns say they were copied from Chat 1, a chat shown again says so, and a reload reads as lesson 7's", async () => {
    const storage = storageOf()
    const tab = storageOf()
    const one = await page(storage, tab)
    await twoTurns(one)
    const chat = one.runtime.conversation
    const branch = Result.getOrThrow(await one.runtime.branch(turn(1)))
    /** The board the Context tab holds once the last `Showing` drew it anew: what was heard from it on. */
    const lastBoard = (runtime: LessonRuntime, heard: ReadonlyArray<Trace>) => {
      const from = heard.findLastIndex((trace) => trace._tag === "Showing")
      return heard.slice(from).reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation))
    }
    await one.runtime.choose(branch)
    await one.say("What did I say earlier?")
    const copied = lastBoard(one.runtime, one.heard)
    expect(turnNumbersOf(copied)).toEqual([1, 2])
    const [first, second] = [viewOf(copied, 1), viewOf(copied, 2)]
    expect([first.restored, second.restored]).toEqual([true, false])
    expect(first.readBack).toEqual({
      head: "copied from Chat 1",
      detail: "This turn was copied from Chat 1 when the branch was made, record for record. Its contexts and prompts were built for one call each and never stored: what is left is what it stored.",
      code: "copied from Chat 1",
    })
    expect(first.steps.find((step) => step.id === "stored-answer-1")?.code).toBe("copied from Chat 1")
    expect(second.steps.find((step) => step.id === "stored-answer-1")?.code).toBe("modelAnswer(stream, session)")

    await one.runtime.choose(chat)
    const again = lastBoard(one.runtime, one.heard)
    expect(viewOf(again, 2).readBack.head).toBe("before this chat was shown again")
    expect(viewOf(again, 2).steps.find((step) => step.id === "prompt-1")?.detail).toBe("This turn ran before you switched back to this chat. Its contexts and prompts were built for one call each and never stored: what is left is what it stored.")
    one.close()

    // A reload shows the branch's copied turn as copied, and its own as before the page loaded, in lesson 7's words.
    tab.setItem(`${STORAGE_PREFIX}${CHOSEN_KEY}`, branch)
    const two = await page(storage, tab)
    const reloaded = lastBoard(two.runtime, two.heard)
    expect(viewOf(reloaded, 1).readBack.code).toBe("copied from Chat 1")
    expect(viewOf(reloaded, 2).readBack).toEqual({ head: "before this page loaded", detail: BEFORE_THIS_PAGE, code: "stored before this page loaded" })
  }, 30_000)

  test("a branch after a stopped turn carries its unanswered message, which Echo answers with the next one", async () => {
    const one = await page(storageOf())
    await one.say("My name is Ana.")
    // Stopped as Echo writes its answer, word by word: the message is stored, the answer never is.
    const writing = one.until((trace) => trace._tag === "Piece")
    one.send("What did I say earlier?")
    await writing
    await one.runtime.stop()
    expect(outcomes(await one.runtime.journal())).toEqual(["Completed", "Interrupted"])
    const branch = Result.getOrThrow(await one.runtime.branch(turn(2)))
    await one.runtime.choose(branch)
    await one.say("Hello.")
    // The branch's chat: the copied stopped turn, its message and its note, then the new turn, which took both.
    expect(told(one.board().rows).slice(2)).toEqual([
      "user: What did I say earlier?", "note: Turn 2 was stopped. Your message stays in the journal.",
      "user: Hello.", 'agent: You sent 2 messages: "What did I say earlier?", "Hello.". I can also see 2 earlier messages.',
    ])
    // The model was sent the unanswered message, then the new one.
    const prompt = one.heard.flatMap((trace) => trace._tag === "Prompt" ? [trace] : []).at(-1)!
    expect(prompt.messages.map((message) => `${message.role}: ${message.text}`).slice(3)).toEqual(["user: What did I say earlier?", "user: Hello."])
  }, 30_000)

  test("the first message has no turn before it: a chat with no closed turn is refused, so asking it another way is a new chat", async () => {
    const one = await page(storageOf(), storageOf(), applied("latest"))
    expect(await one.runtime.branch(turn(1))).toEqual(Result.fail(`branch.ts made no branch: session ${one.runtime.conversation} has no closed turn to branch from`))
    expect(await one.labels()).toEqual(["Chat 1 (shown)"])
  }, 20_000)

  test("every experiment finds its line in the starter code", () => {
    expect(Object.keys(branches.experiments)).toEqual(["latest", "open-turn", "slow-calculator", "resume-ignores"])
    // The slow calculator takes four seconds, as its text says.
    expect(Option.getOrThrow(branches.experiments["slow-calculator"]!.apply(SOURCES.tools ?? ""))).toContain('.pipe(Effect.delay("4 seconds"))')
    for (const [id, experiment] of Object.entries(branches.experiments)) {
      const source = SOURCES[experiment.file] ?? ""
      const next = experiment.apply(source)
      expect([id, Option.isSome(next) && next.value !== source]).toEqual([id, true])
    }
  })
})
