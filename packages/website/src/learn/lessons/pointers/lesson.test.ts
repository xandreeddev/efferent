// Lesson 8 on the page's runtime, with Echo: a looked-up article is stored
// whole and sent as its start and a pointer, in its own turn and every later
// one; the model reads on with readResult, and what it read is sent whole
// from then on; the sizes the page states; each experiment and control does
// what the page says, a preview `pointed` refuses included.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { toolResultEvent } from "@xandreed/core"
import { ReadResult, readResult } from "@xandreed/sdk"
import { emptyChat, hear } from "../../chat-model.ts"
import { evaluateStatements } from "../../evaluate.ts"
import { loadEcho } from "../../models/mock.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { emptyBoard, record, turnNumbersOf, viewOf } from "../../trace-model.ts"
import type { CallView, PromptRow } from "../../trace-model.ts"
import { DEFAULT_MEMORY as FLAT_MEMORY } from "../tools/memory.source.ts"
import { pointers } from "./lesson.ts"
import { DEFAULT_MEMORY, FLAT_DECLARATION } from "./memory.source.ts"
import { DEFAULT_TOOLS, toolsBodyOf } from "./tools.source.ts"

// Echo streams a word every 35 ms, and these conversations run up to ten turns.
setDefaultTimeout(60_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(pointers.files.map((file) => [file.id, file.defaultText]))
const applied = (id: string, sources = SOURCES) => {
  const experiment = pointers.experiments[id]!
  return { ...sources, [experiment.file]: Option.getOrThrow(experiment.apply(sources[experiment.file] ?? "")) }
}
/** memory.ts with a control set, through the control's own write. */
const withControl = (key: "over" | "preview", value: number, sources = SOURCES) => ({ ...sources, memory: Option.getOrThrow(pointers.controls[key]!.write(sources.memory ?? "", value)) })

/** The articles of the shown tools.ts, read from the text the page runs. */
const articles = evaluateStatements(toolsBodyOf(DEFAULT_TOOLS), "articles", { Effect, Schema, Tool, Toolkit, ReadResult, readResult }) as Record<"tides" | "volcanoes" | "honeybees", string>
const { tides, volcanoes, honeybees } = articles

/** The pointer the model is sent for an article stored at `seq`, with a preview of `shown` characters. */
const pointerTo = (article: string, seq: number, shown = 160) =>
  `<tool-result-preview>\n${article.slice(0, shown)}\n</tool-result-preview>\n[Host note: the result above is cut short: it is ${article.length} characters long and its first ${shown} are shown. To read on, call readResult with result ${seq} and from ${shown}.]`

const LOOKUPS = ["Look up tides.", "Tell me about volcanoes.", "Look up honeybees."]
const STARTS = {
  tides: "Tides are the regular rise and fall of the sea along a coast.",
  volcanoes: "A volcano is an opening in the crust of the Earth where molten rock, ash and gas escape from below.",
  honeybees: "A honeybee colony is a single family of tens of thousands of bees.",
}
const pointed = (start: string, total: number, shown = 160) => `The article starts: "${start}" I was sent the first ${shown} of ${total} characters. Say "read more" for the next part.`
const whole = (start: string, total: number) => `The article is ${total} characters long. It starts: "${start}"`

/** The page: the runtime on Echo, what it heard, and one message at a time, each a turn of its own. */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(pointers)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  const result = await runtime.start(sources)
  const settled = () => new Promise<void>((resolve) => {
    const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Ended") { stop(); resolve() } })
  })
  /** Send these at once, and wait for the one answer, failure or end that follows. */
  const send = async (...texts: ReadonlyArray<string>) => { const done = settled(); texts.forEach((text) => runtime.send(text)); await done }
  /** Send each once the one before is answered. */
  const say = async (...texts: ReadonlyArray<string>) => { for (const text of texts) await send(text) }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const prompts = () => heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace] : []))
  /** The Context tab's model calls, turn by turn, in order. */
  const calls = (): ReadonlyArray<CallView> => {
    const board = heard.reduce((all, trace) => record(all, trace, 0), emptyBoard(runtime.conversation))
    return turnNumbersOf(board).flatMap((turn) => viewOf(board, turn).calls)
  }
  /** What the journal holds for each tool result, in order. */
  const results = async () => (await runtime.journal()).flatMap((event) => (event.name === toolResultEvent.name && event.message?._tag === "ToolResult" ? [{ seq: Number(event.seq), ...event.message }] : []))
  /** The chat's rows, as the page folds them from what it heard. */
  const chat = () => heard.reduce((board, trace) => hear(board, trace, runtime.conversation), emptyChat).rows
  return { runtime, heard, result, send, say, replies, prompts, calls, results, chat }
}
const rowsOf = (call: CallView): ReadonlyArray<PromptRow> => Option.getOrThrow(call.prompt)
const sizes = (calls: ReadonlyArray<CallView>) => calls.map((call) => call.promptTokens)
const reused = (calls: ReadonlyArray<CallView>) => calls.map((call) => call.reusedTokens)
/** Whether each prompt, from the second on, starts with every message of the one before it. */
const startsWithTheOneBefore = (prompts: ReadonlyArray<{ readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }> }>) =>
  prompts.slice(1).map((prompt, index) => {
    const before = prompts[index]!.messages
    return before.every((message, at) => prompt.messages[at]?.role === message.role && prompt.messages[at]?.text === message.text)
  })

describe("lesson 8 on the page (the kernel, Echo)", () => {
  test("a looked-up article is stored whole, at its place in the journal, and the model is sent its start and a pointer to that place", async () => {
    const { say, replies, prompts, results, calls, chat, result } = await page()
    expect(result).toEqual({ _tag: "Built" })
    await say("Look up tides.")
    expect(replies()).toEqual([pointed(STARTS.tides, 2347)])
    // The journal: the article, whole, at place 4.
    expect(await results()).toEqual([{ seq: 4, _tag: "ToolResult", id: expect.stringMatching(/^echo-call-/), name: "lookup", result: tides, isFailure: false }])
    expect(tides.length).toBe(2347)
    // The model's second call: the first 160 characters and the note naming place 4. No message holds what follows them.
    expect(prompts()[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"])
    expect(prompts()[1]?.messages.at(-1)?.text).toBe(`lookup → ${JSON.stringify(pointerTo(tides, 4))}`)
    expect(prompts().flatMap((prompt) => prompt.messages).some((message) => message.text.includes("sailors planned their voyages"))).toBe(false)
    // The Context tab: 27 tokens before the lookup, 135 after it; the result's row is 94 of them and says the journal keeps 587.
    expect(sizes(calls())).toEqual([27, 135])
    const row = rowsOf(calls()[1]!).at(-1)!
    expect([row.role, Option.getOrNull(row.seq), row.tokens, Option.getOrNull(row.pointer)]).toEqual(["tool", 4, 94, 587])
    // The chat is drawn from the journal: its row for the tool's result holds the article whole.
    expect(chat().find((one) => one.kind === "tool")?.text).toBe(`lookup({"topic":"tides"}) → ${JSON.stringify(tides)}`)
    // The tools offered with the prompt: lookup, and the kernel's readResult.
    expect(prompts()[1]?.tools).toEqual(["lookup", "readResult"])
  })

  test("the page's own path: look tides up, read on twice, look volcanoes up; every prompt holds all of the one before it", async () => {
    const { say, replies, prompts, calls } = await page()
    await say("Look up tides.", "Read more.", "Read more.", "Tell me about volcanoes.")
    expect(replies()).toEqual([
      pointed(STARTS.tides, 2347),
      'Characters 160 to 560 of 2347: "The pattern has been recorded for thousands of years, and sailors planned their voyages around it long before anyone could explain it." Say "read more" for the next part.',
      'Characters 560 to 960 of 2347: "The far bulge is there because the moon pulls the solid Earth away from the water behind it." Say "read more" for the next part.',
      pointed(STARTS.volcanoes, 2396),
    ])
    // Two prompts a turn. Turn 4's first is 551 tokens, and the 505 of the prompt before it are its start.
    expect(sizes(calls())).toEqual([27, 135, 179, 315, 369, 505, 551, 661])
    expect(reused(calls())).toEqual([0, 27, 135, 179, 315, 369, 505, 551])
    // What each result costs in the last prompt: the two pointers, and the two parts read, which are sent as stored.
    expect(rowsOf(calls().at(-1)!).filter((row) => row.role === "tool").map((row) => [Option.getOrNull(row.seq), row.tokens, Option.getOrNull(row.pointer)])).toEqual([[4, 94, 587], [10, 116, null], [16, 116, null], [22, 95, 599]])
    expect(startsWithTheOneBefore(prompts())).toEqual(prompts().slice(1).map(() => true))
  })

  test("three lookups with pointers: the prompts stay small, each starts with the one before it, and the journal holds each article whole", async () => {
    const { say, replies, prompts, results, calls } = await page()
    await say(...LOOKUPS)
    expect(replies()).toEqual([pointed(STARTS.tides, 2347), pointed(STARTS.volcanoes, 2396), pointed(STARTS.honeybees, 2336)])
    expect((await results()).map((one) => [one.seq, one.result])).toEqual([[4, tides], [10, volcanoes], [16, honeybees]])
    // Each prompt's size, two a turn: 458 tokens after the third lookup.
    expect(sizes(calls())).toEqual([27, 135, 182, 292, 348, 458])
    // Every prompt starts with the one before it: all of the prompt before is the same, in the turn that fetched a result and in the next.
    expect(startsWithTheOneBefore(prompts())).toEqual([true, true, true, true, true])
    expect(reused(calls())).toEqual([0, 27, 135, 182, 292, 348])
    // The last prompt's three results are pointers, each to its record; what the journal keeps of each: 587, 599 and 584 tokens.
    const rows = rowsOf(calls().at(-1)!).filter((row) => row.role === "tool")
    expect(rows.map((row) => [Option.getOrNull(row.seq), row.tokens, Option.getOrNull(row.pointer)])).toEqual([[4, 94, 587], [10, 95, 599], [16, 95, 584]])
    expect(prompts().at(-1)?.messages.filter((message) => message.role === "tool").map((message) => message.text)).toEqual([
      `lookup → ${JSON.stringify(pointerTo(tides, 4))}`, `lookup → ${JSON.stringify(pointerTo(volcanoes, 10))}`, `lookup → ${JSON.stringify(pointerTo(honeybees, 16))}`,
    ])
  })

  test("without pointers (the first experiment), the same three lookups put every article in every later prompt: 1952 tokens where there were 458", async () => {
    const { say, replies, prompts, calls } = await page(applied("no-pointers"))
    await say(...LOOKUPS)
    // Echo was sent each article whole, and says so.
    expect(replies()).toEqual([whole(STARTS.tides, 2347), whole(STARTS.volcanoes, 2396), whole(STARTS.honeybees, 2336)])
    expect(sizes(calls())).toEqual([27, 639, 673, 1299, 1342, 1952])
    const last = prompts().at(-1)!.messages.filter((message) => message.role === "tool").map((message) => message.text)
    expect(last).toEqual([`lookup → ${JSON.stringify(tides)}`, `lookup → ${JSON.stringify(volcanoes)}`, `lookup → ${JSON.stringify(honeybees)}`])
    expect(rowsOf(calls().at(-1)!).map((row) => Option.getOrNull(row.pointer)).filter((kept) => kept !== null)).toEqual([])
    // A prompt still starts with the one before it: a flat memory changes nothing it sent. It costs its length every time.
    expect(startsWithTheOneBefore(prompts())).toEqual([true, true, true, true, true])
    // Nothing was cut short, so there is nothing to read on from.
    await say("Read more.")
    expect(replies().at(-1)).toBe("There is nothing to read on from: look something up first.")
  })

  test("\"read more\" reads on from the latest pointer with readResult, 400 characters a call; each part is stored, marked whole, and sent whole from then on", async () => {
    const { say, replies, prompts, results, calls } = await page()
    await say(...LOOKUPS, "Read more.", "Read more.")
    expect(replies().slice(3)).toEqual([
      'Characters 160 to 560 of 2336: "No bee can live for long alone: the colony feeds, builds, defends and reproduces as one body, and beekeepers often speak of the hive, not the bee, as the animal." Say "read more" for the next part.',
      'Characters 560 to 960 of 2336: "An egg that she fertilises becomes a female, and one that she does not becomes a drone." Say "read more" for the next part.',
    ])
    // The parts are of the honeybee article, the last one looked up: record 16, from where its pointer stopped, then from where the first part did.
    const parts = (await results()).filter((one) => one.name === "readResult")
    expect(parts.map((one) => [one.seq, one.result, one.whole])).toEqual([
      [22, { text: honeybees.slice(160, 560), from: 160, to: 560, total: 2336 }, true],
      [28, { text: honeybees.slice(560, 960), from: 560, to: 960, total: 2336 }, true],
    ])
    const asked = prompts().flatMap((prompt) => prompt.messages).filter((message) => message.role === "assistant" && message.text.includes("readResult")).map((message) => message.text)
    expect(new Set(asked)).toEqual(new Set(['Let me work that out. · calls readResult({"result":16,"from":160,"length":400})', 'Let me work that out. · calls readResult({"result":16,"from":560,"length":400})']))
    // The prompts of the two turns that read on: 458 tokens before, 639 after the first part, 836 after the second.
    expect(sizes(calls()).slice(6)).toEqual([503, 639, 700, 836])
    // A part is sent as it is stored, never as a pointer: 116 tokens each, in this prompt and every later one.
    const last = rowsOf(calls().at(-1)!).filter((row) => row.role === "tool")
    expect(last.map((row) => [Option.getOrNull(row.seq), row.tokens, Option.getOrNull(row.pointer)])).toEqual([[4, 94, 587], [10, 95, 599], [16, 95, 584], [22, 116, null], [28, 116, null]])
    expect(startsWithTheOneBefore(prompts())).toEqual(prompts().slice(1).map(() => true))
  })

  test("an article is read to its end in six parts, and \"read more\" then says it was the end", async () => {
    const { say, replies, results } = await page()
    await say("Look up tides.", ...Array.from({ length: 8 }, () => "Read more."))
    const parts = (await results()).filter((one) => one.name === "readResult").map((one) => one.result as { readonly text: string; readonly from: number; readonly to: number })
    expect(parts.map((part) => [part.from, part.to])).toEqual([[160, 560], [560, 960], [960, 1360], [1360, 1760], [1760, 2160], [2160, 2347]])
    // The pointer's start and the parts, one after another, are the article: each character once.
    expect(`${tides.slice(0, 160)}${parts.map((part) => part.text).join("")}`).toBe(tides)
    expect(replies().at(-3)).toBe('Characters 2160 to 2347 of 2347: "The tides also slow the spin of the Earth: a day is about two thousandths of a second longer than it was a century ago." That is the end.')
    expect(replies().slice(-2)).toEqual(["That was the end of it.", "That was the end of it."])
  })

  test("pointing only older turns (an experiment): the model sees the whole article in its own turn, and the next turn's prompt no longer starts with the one before", async () => {
    const older = await page(applied("older-turns"))
    await older.say("Look up tides.", "Tell me about volcanoes.")
    // In its own turn the result is sent whole, and Echo says so; the next turn sends the same record as a pointer.
    expect(older.replies()).toEqual([whole(STARTS.tides, 2347), whole(STARTS.volcanoes, 2396)])
    expect(older.prompts()[1]?.messages.at(-1)?.text).toBe(`lookup → ${JSON.stringify(tides)}`)
    expect(older.prompts()[2]?.messages[3]?.text).toBe(`lookup → ${JSON.stringify(pointerTo(tides, 4))}`)
    expect(sizes(older.calls())).toEqual([27, 639, 169, 795])
    // Turn 2's first prompt shares 41 tokens with the 639 before it: the system text, the message and the call. The result's row changed.
    expect(startsWithTheOneBefore(older.prompts())).toEqual([true, false, true])
    expect(reused(older.calls())).toEqual([0, 27, 41, 169])
    expect(rowsOf(older.calls()[2]!).map((row) => [row.role, row.reused])).toEqual([["system", true], ["user", true], ["assistant", true], ["tool", false], ["assistant", false], ["user", false]])
    // As the lesson starts: the same two turns, and every token of the prompt before is in the next.
    const ours = await page()
    await ours.say("Look up tides.", "Tell me about volcanoes.")
    expect(sizes(ours.calls())).toEqual([27, 135, 182, 292])
    expect(reused(ours.calls())).toEqual([0, 27, 135, 182])
    expect(rowsOf(ours.calls()[2]!).map((row) => [row.role, row.reused])).toEqual([["system", true], ["user", true], ["assistant", true], ["tool", true], ["assistant", false], ["user", false]])
  })

  test("a preview of five tokens (an experiment): the prompt is smaller, and the model is sent twenty characters", async () => {
    const { say, replies, calls, prompts } = await page(applied("tiny-preview"))
    await say("Look up tides.", "Read more.")
    expect(replies()).toEqual([
      'The article starts: "Tides are the regula" I was sent the first 20 of 2347 characters. Say "read more" for the next part.',
      'Characters 20 to 420 of 2347: "Most shores see two high waters and two low waters in a little under 25 hours, so each high tide comes about 50 minutes later than the one the day before." Say "read more" for the next part.',
    ])
    expect(prompts()[1]?.messages.at(-1)?.text).toBe(`lookup → ${JSON.stringify(pointerTo(tides, 4, 20))}`)
    // 100 tokens after the lookup where the lesson's 40-token preview gave 135.
    expect(sizes(calls()).slice(0, 2)).toEqual([27, 100])
  })

  test("without ReadResult in tools.ts (an experiment), the pointer still names readResult, and Echo says it has no tool to read on", async () => {
    const { say, replies, prompts, results } = await page(applied("no-read-result"))
    await say("Look up tides.", "Read more.")
    expect(replies()).toEqual([pointed(STARTS.tides, 2347), "I have no tool to read on: readResult is not among my tools."])
    expect(prompts().map((prompt) => prompt.tools)).toEqual([["lookup"], ["lookup"], ["lookup"]])
    expect(prompts().at(-1)?.messages[3]?.text).toContain("To read on, call readResult with result 4 and from 160.")
    expect((await results()).map((one) => one.name)).toEqual(["lookup"])
  })

  test("a preview not shorter than the size refuses the build in the kernel's words: nothing is stored, the chat is untouched, and a number that fits builds again", async () => {
    const WORDS = "a preview of 400 tokens is not shorter than the results it stands for, those over 150 tokens: give pointers a previewTokens below overTokens"
    // The control writes the number as asked: what is wrong with it is the kernel's to say, where the rule is written.
    const refused = await page(withControl("preview", 400))
    expect(refused.result).toEqual({ _tag: "Refused", message: `memory.ts did not run: ${WORDS}` })
    // No program runs, nothing was heard, and the conversation is empty.
    expect(refused.runtime.running).toBe(false)
    expect([await refused.runtime.journal(), refused.chat(), refused.heard]).toEqual([[], [], []])
    // A preview equal to the size, and a size lowered to the preview, are refused the same way.
    for (const [sources, words] of [
      [withControl("preview", 150), "a preview of 150 tokens is not shorter than the results it stands for, those over 150 tokens: give pointers a previewTokens below overTokens"],
      [withControl("over", 40), "a preview of 40 tokens is not shorter than the results it stands for, those over 40 tokens: give pointers a previewTokens below overTokens"],
    ] as const) {
      expect((await page(sources)).result).toEqual({ _tag: "Refused", message: `memory.ts did not run: ${words}` })
    }
    // A number that fits builds, and one "Look up tides." is answered once.
    expect(await refused.runtime.start(withControl("preview", 40))).toEqual({ _tag: "Built" })
    await refused.say("Look up tides.")
    expect(refused.replies()).toEqual([pointed(STARTS.tides, 2347)])
    expect((await refused.results()).map((one) => [one.seq, one.name])).toEqual([[4, "lookup"]])

    // On a page whose program is running: the refused build stops it, and none takes its place until a build passes.
    const running = await page()
    await running.say("Look up tides.")
    const [journal, heard, rows] = [await running.runtime.journal(), running.heard.length, running.chat()]
    expect(await running.runtime.start(withControl("preview", 400))).toEqual({ _tag: "Refused", message: `memory.ts did not run: ${WORDS}` })
    expect(running.runtime.running).toBe(false)
    // The conversation is as it was: no record, no trace, no row.
    expect([await running.runtime.journal(), running.heard.length, running.chat()]).toEqual([journal, heard, rows])
    // Built again, the program goes on with the same conversation: the pointer to tides is still the place to read on from.
    expect(await running.runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    await running.say("Read more.")
    expect(running.replies().at(-1)).toBe('Characters 160 to 560 of 2347: "The pattern has been recorded for thousands of years, and sailors planned their voyages around it long before anyone could explain it." Say "read more" for the next part.')
  })

  test("the two controls read and write memory.ts's numbers, and a size over the longest article points nothing", async () => {
    const { over, preview } = pointers.controls
    expect([over!.read(DEFAULT_MEMORY), preview!.read(DEFAULT_MEMORY)]).toEqual([Option.some(150), Option.some(40)])
    expect(Option.flatMap(over!.write(DEFAULT_MEMORY, 600), over!.read)).toEqual(Option.some(600))
    expect(Option.flatMap(preview!.write(DEFAULT_MEMORY, 5), preview!.read)).toEqual(Option.some(5))
    // Each writes its own number and leaves the other.
    expect(Option.flatMap(over!.write(DEFAULT_MEMORY, 600), preview!.read)).toEqual(Option.some(40))
    expect(Option.getOrThrow(preview!.write(DEFAULT_MEMORY, 5))).toContain("\nconst sent = pointed({ overTokens: 150, previewTokens: 5 })\n")
    // A number under one, or one that is not whole, is not written: a field emptied while typing reads as zero.
    expect([preview!.write(DEFAULT_MEMORY, 0), over!.write(DEFAULT_MEMORY, 0), preview!.write(DEFAULT_MEMORY, 2.5), over!.write(DEFAULT_MEMORY, -3)]).toEqual([Option.none(), Option.none(), Option.none(), Option.none()])
    // The first experiment leaves lesson 2's memory, whatever the two numbers were, and the controls then find no line.
    const flat = Option.getOrThrow(pointers.experiments["no-pointers"]!.apply(DEFAULT_MEMORY))
    expect(flat).toBe(`${FLAT_DECLARATION}${FLAT_MEMORY}`)
    expect(Option.flatMap(preview!.write(DEFAULT_MEMORY, 400), pointers.experiments["no-pointers"]!.apply)).toEqual(Option.some(flat))
    expect([over!.read(flat), preview!.read(flat), over!.write(flat, 600)]).toEqual([Option.none(), Option.none(), Option.none()])
    // With the rule gone, numbers it would refuse refuse nothing: the build passes.
    expect((await page({ ...SOURCES, memory: Option.getOrThrow(Option.flatMap(preview!.write(DEFAULT_MEMORY, 400), pointers.experiments["no-pointers"]!.apply)) })).result).toEqual({ _tag: "Built" })
    // A line the learner rewrote is left alone, by a control and by an experiment.
    const rewritten = DEFAULT_MEMORY.replace("pointed({ overTokens: 150, previewTokens: 40 })", "pointed(options)")
    expect([over!.read(rewritten), over!.write(rewritten, 600), preview!.write(rewritten, 5), pointers.experiments["tiny-preview"]!.apply(rewritten)]).toEqual([Option.none(), Option.none(), Option.none(), Option.none()])
    const reworded = DEFAULT_MEMORY.replace("Option.toArray(sent(record))", "Option.toArray(read(record))")
    expect([pointers.experiments["no-pointers"]!.apply(reworded), pointers.experiments["older-turns"]!.apply(reworded)]).toEqual([Option.none(), Option.none()])
    expect(pointers.experiments["no-read-result"]!.apply(DEFAULT_TOOLS.replace("Toolkit.make(lookup, ReadResult)", "Toolkit.make(ReadResult, lookup)"))).toEqual(Option.none())
    // Every experiment finds its line in the starter text, and changes it.
    for (const [id, experiment] of Object.entries(pointers.experiments)) {
      const source = SOURCES[experiment.file]!
      expect({ id, changed: Option.exists(experiment.apply(source), (next) => next !== source) }).toEqual({ id, changed: true })
    }
    // The longest article is the one on volcanoes, 599 tokens: at a size of 599 it is sent whole, at 598 as a pointer.
    const at599 = await page(withControl("over", 599))
    await at599.say("Tell me about volcanoes.")
    expect(at599.replies()).toEqual([whole(STARTS.volcanoes, 2396)])
    const at598 = await page(withControl("over", 598))
    await at598.say("Tell me about volcanoes.", "Look up tides.")
    expect(at598.replies()).toEqual([pointed(STARTS.volcanoes, 2396), whole(STARTS.tides, 2347)])
  })

  test("\"Send three at once\" is one turn: the three articles are looked up in one step, and the prompt after holds three pointers", async () => {
    expect(pointers.three).toEqual(["Look up tides.", "Look up volcanoes.", "Look up honeybees."])
    const three = await page()
    await three.send(...pointers.three)
    // One answer for the three messages: none is left unanswered.
    expect(three.replies()).toEqual([`${pointed(STARTS.tides, 2347)} ${pointed(STARTS.volcanoes, 2396)} ${pointed(STARTS.honeybees, 2336)}`])
    expect((await three.results()).map((one) => [one.seq, one.result])).toEqual([[6, tides], [7, volcanoes], [8, honeybees]])
    // 352 tokens in the prompt after the lookups; with every result read as stored (the first experiment), 1874.
    expect(sizes(three.calls())).toEqual([37, 352])
    const flat = await page(applied("no-pointers"))
    await flat.send(...pointers.three)
    expect(sizes(flat.calls())).toEqual([37, 1874])
    // The chips keep "Read more.", and no button of the page sends anything but the three.
    expect(pointers.chips).toContain("Read more.")
    expect(pointers.fill).toEqual(pointers.three)
  })
})
