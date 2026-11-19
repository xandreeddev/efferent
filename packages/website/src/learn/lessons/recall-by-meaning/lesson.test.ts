// Lesson 20 on the page's runtime, with Echo and the page's recorded
// embedder: the vectors its own worker made, the world's as the page ships
// them and the lesson's messages as recorded, so every cosine here is one the
// page shows. Before the embedder is loaded recall runs by words alone, the
// turn is answered and the status line says so; once it is loaded nothing is
// rebuilt. Load the world puts the world's vectors in the page's store before
// its memories, so each request after embeds its message alone. The page's
// steps are one walk on one runtime, press by press in the page's order, and
// each experiment starts from a reloaded page, as its text says. Every claim
// of the mdx is pinned here as it is worded.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Option, Result } from "effect"
import { SessionId } from "@xandreed/core/kernel"
import { knowledgeOf, KNOWLEDGE_OWNER, meaningKey, meaningTexts } from "@xandreed/sdk/kernel"
import type { KnowledgeRecalledData } from "@xandreed/sdk/kernel"
import { emptyRecalls, heardRecall, pickedRecall, recallsStartedOver, recallViewOf } from "../../graph-model.ts"
import type { RecallBoard } from "../../graph-model.ts"
import { applyExperiment } from "../../lesson.ts"
import { loadEcho } from "../../models/mock.ts"
import { EMBEDDER_LOADED, EMBEDDER_NOT_LOADED, LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { CONTROLS } from "./config-edit.ts"
import { BIRD, CAPITAL, ORCHID, PET, recallByMeaning, THANKS, WORDS_ALONE } from "./lesson.ts"
import { EMBEDDER_MODEL } from "./shipped.ts"
import { recordedLesson, shippedFile } from "./testing.ts"

// Echo streams a word every 35 ms, and the walk runs many turns, each kept by the curator.
setDefaultTimeout(240_000)

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const SOURCES: Record<string, string> = Object.fromEntries(recallByMeaning.files.map((file) => [file.id, file.defaultText]))
/** The sources as an experiment leaves them. */
const applied = (id: string): Record<string, string> =>
  ({ ...SOURCES, ...Object.fromEntries(Option.getOrThrow(applyExperiment(recallByMeaning.experiments[id]!, (file) => SOURCES[file] ?? ""))) })
/** The sources as a control leaves memory.ts. */
const controlled = (key: string, value: number): Record<string, string> => ({ ...SOURCES, memory: Option.getOrThrow(CONTROLS[key]!.write(SOURCES.memory!, value)) })

/** What Load the world says, after lesson 18's words: the vectors made ahead, put in the page's store first. */
const LOADED = "Stored the world's 654 sentences in one turn on the knowledge session: 557 memories, 97 said again and 3 ended, about 374 new entities, from 554 days, each a source of its own. Put 557 vectors in the page's store, made ahead by the page's embedder, one for each memory's text: a message is the only text turned into numbers when you ask."

/** The page: the runtime on Echo, what it heard, and the Graph tab's recalls as the page folds them. */
const page = async (sources: Record<string, string> = SOURCES) => {
  const runtime = await LessonRuntime.create(recordedLesson)
  opened.push(runtime)
  runtime.setModel(loadEcho())
  const heard: Array<Trace> = []
  let graph: RecallBoard = emptyRecalls(runtime.conversation)
  runtime.onTrace((trace) => { heard.push(trace); graph = heardRecall(graph, trace) })
  const result = await runtime.start(sources)
  /** Send one message, and wait for its turn to be answered and kept. */
  const say = async (text: string) => {
    const kept = new Promise<void>((resolve) => {
      const stop = runtime.onTrace((trace) => { if (trace._tag === "Status" && /^Curated turn \d+: /.test(trace.text)) { stop(); resolve() } })
    })
    runtime.send(text)
    await kept
  }
  const replies = () => heard.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))
  const statuses = () => heard.flatMap((trace) => (trace._tag === "Status" ? [trace.text] : []))
  /** What the embedder made, counted by kind, since the trace at `from`. */
  const embedded = (from: number) => heard.slice(from).flatMap((trace) => (trace._tag === "Embedded" ? [`${trace.as} ${trace.count}`] : []))
  /** The kernel's event for the latest request, and the Graph tab's recall panel for it. */
  const recalled = (): KnowledgeRecalledData => Option.getOrThrow(pickedRecall(graph, { _tag: "Latest" })).recalled
  const panel = () => recallViewOf(recalled(), graph.records)
  /** The note the latest request of the conversation was sent: its lines between the frame's tags. */
  const note = () => {
    const prompt = heard.findLast((trace) => trace._tag === "Prompt" && trace.session === runtime.conversation && trace.purpose === undefined)
    const last = prompt?._tag === "Prompt" ? prompt.messages.at(-1)?.text ?? "" : ""
    return last.includes("<known-memories>") ? last.slice(last.indexOf("<known-memories>\n") + 17, last.indexOf("\n</known-memories>")).split("\n").map((line) => line.replace(/ \(said .*\)$/, "")) : []
  }
  const clear = async () => {
    const built = await runtime.clear()
    graph = recallsStartedOver(graph, runtime.conversation)
    return built
  }
  return { runtime, heard, result, say, replies, statuses, embedded, recalled, panel, note, clear }
}

/** A panel's row as the tests read it: whether it was sent, its text, and its places in the lists. */
const rowsOf = (rows: ReadonlyArray<{ readonly sent: boolean; readonly text: string; readonly how: ReadonlyArray<string> }>, count: number) =>
  rows.slice(0, count).map((row) => `${row.sent ? "sent" : "not sent"}: ${row.text} [${row.how.join(" · ")}]`)

describe("lesson 20 on the page", () => {
  test("the shipped vectors are one for each text recall by meaning ranks over the world, under the kernel's key for it, made by the page's embedder", async () => {
    const file = shippedFile()
    expect([file.model, file.dimension]).toEqual([EMBEDDER_MODEL, 384])
    const { runtime } = await page()
    await runtime.loadWorld()
    const id = SessionId.make((await runtime.list()).find((header) => header.owner === KNOWLEDGE_OWNER)!.id)
    const texts = meaningTexts(knowledgeOf(await runtime.journal(id)))
    // Every memory the world keeps, the three ended as changed among them, and nothing else.
    expect(texts).toHaveLength(557)
    expect(Object.keys(file.passages).toSorted()).toEqual([...texts].toSorted())
    expect(texts.every((text) => Result.isSuccess(meaningKey(EMBEDDER_MODEL, text)))).toBe(true)
  })

  test("before the embedder is loaded, a question is answered by recall by words alone, as lesson 18's, and the status line says so; once it is loaded, with nothing rebuilt, the next is ranked by meaning too", async () => {
    const { runtime, result, say, replies, statuses, recalled, panel, note, embedded, heard } = await page()
    expect(result).toEqual({ _tag: "Built" })
    expect(Result.getOrThrow(await runtime.loadWorld())).toBe(LOADED)
    await say(ORCHID)
    // The turn is answered: never a failed turn.
    expect(replies()).toEqual(["From what I know: João Reis leads Project Orchid. João Reis lives in Porto. João Reis enjoys pottery."])
    expect(heard.some((trace) => trace._tag === "Failed")).toBe(false)
    expect(statuses().at(-1)).toBe(`Curated turn 1: 0 new, 0 said again, 0 ended; 1 dropped ${WORDS_ALONE}`)
    // The kernel skipped the list by meaning and said why: no memory has a place in it, and what was sent is what lesson
    // 18's recall by words sends.
    expect(recalled().meaning?.skipped).toBe(EMBEDDER_NOT_LOADED)
    expect(recalled().memories.every((memory) => memory.meaning === null)).toBe(true)
    expect(Option.getOrThrow(panel().byMeaning)).toBe(`Nothing was ranked by meaning. ${EMBEDDER_NOT_LOADED} Recall used the other lists.`)
    const byWords = note()
    const lesson18 = await page()
    await lesson18.runtime.loadEmbedder()
    expect(await lesson18.runtime.start(applied("meaning-off"))).toEqual({ _tag: "Built" })
    await lesson18.runtime.loadWorld()
    await lesson18.say(ORCHID)
    expect(byWords).toEqual(lesson18.note())
    expect(byWords).toHaveLength(11)
    // Loaded: nothing is rebuilt, and the next question is ranked by meaning, its message the one text embedded.
    expect(Result.getOrThrow(await runtime.loadEmbedder())).toBe(EMBEDDER_LOADED)
    expect(runtime.embedderLoaded).toBe(true)
    const from = heard.length
    await say(BIRD)
    expect(heard.slice(from).some((trace) => trace._tag === "Built" || trace._tag === "Ended")).toBe(false)
    expect(recalled().meaning?.skipped).toBe(null)
    expect(embedded(from)).toEqual(["query 1"])
    expect(statuses().at(-1)).toBe("Curated turn 2: 0 new, 0 said again, 0 ended; 0 dropped")
  })

  test("the page's steps 3 to 7 on one runtime: the bird question reaches the parrot by meaning, fresh and straight after the Orchid question; the three lists side by side; meaning alone would be wrong about Rui Reis's pet; an ended memory gives its place to what replaced it; a greeting is sent eight memories it has nothing to do with", async () => {
    const { runtime, say, replies, statuses, recalled, panel, note, embedded, heard, clear } = await page()
    // Step 2: the embedder; step 3: the world, its vectors first.
    expect(Result.getOrThrow(await runtime.loadEmbedder())).toBe(EMBEDDER_LOADED)
    expect(Result.getOrThrow(await runtime.loadWorld())).toBe(LOADED)

    // Step 3: "Who keeps a bird?" on a fresh conversation. Only the message is turned into numbers: the world's were shipped.
    let from = heard.length
    await say(BIRD)
    expect(embedded(from)).toEqual(["query 1"])
    expect(replies().at(-1)).toBe("From what I know: Ana Silva has parrot Pip.")
    expect(recalled().meaning).toEqual({ model: EMBEDDER_MODEL, pool: 50, floor: null, skipped: null })
    expect(panel().options).toBe("limit: 8 · walk: 3 · pool: 50 · weights: seed 1, words 0.5, meaning 1.5 · vectors of Xenova/e5-small-v2")
    expect(panel().lists).toBe("Memories about the seeds, those your words reach, and those nearest your message in meaning, fused")
    expect(panel().seeds).toEqual(["Nothing: your message and the turn before it named no entity kept, and held none of your words for yourself."])
    expect(rowsOf(panel().ranked, 9)).toEqual([
      "sent: Ana Silva has parrot Pip. [1st by meaning (cosine 0.787)]",
      "sent: Sven Tavares has parrot Rex. [2nd by meaning (cosine 0.781)]",
      "sent: Omar Moreau has parrot Pepper. [3rd by meaning (cosine 0.779)]",
      "sent: Rui Reis has parrot Coco. [4th by meaning (cosine 0.778)]",
      "sent: Paula Zimmer has parrot Milo. [5th by meaning (cosine 0.775)]",
      "sent: Marco Alves leads Project Sparrow II. [6th by meaning (cosine 0.774)]",
      "sent: Nina Oliveira has hamster Simba. [7th by meaning (cosine 0.766)]",
      "sent: Tara Ferreira has goal learn the piano by March 2027. [8th by meaning (cosine 0.762)]",
      "not sent: Bruno Xu has parrot Bean. [9th by meaning (cosine 0.760)]",
    ])
    expect(note()).toEqual([
      "Ana Silva has parrot Pip.", "Sven Tavares has parrot Rex.", "Omar Moreau has parrot Pepper.", "Rui Reis has parrot Coco.", "Paula Zimmer has parrot Milo.",
      "Marco Alves leads Project Sparrow II.", "Nina Oliveira has hamster Simba.", "Tara Ferreira has goal learn the piano by March 2027.",
    ])
    expect(panel().sent).toBe("Sent 8 memories, in a note of about 179 tokens. Sending every standing memory, all 554, would take about 7,374 tokens.")

    // Step 4: the Orchid question, each of the three lists reaching its answer; then the bird question straight after it.
    await say(ORCHID)
    expect(replies().at(-1)).toBe("From what I know: João Reis leads Project Orchid. João Reis lives in Porto. João Reis enjoys pottery.")
    expect(rowsOf(panel().ranked, 3)).toEqual([
      "sent: João Reis leads Project Orchid. [1st about a seed (Project Orchid) · 1st by your words (leads, project, orchid) · 1st by meaning (cosine 0.839)]",
      "sent: Project Orchid belongs to Initech. [2nd about a seed (Project Orchid) · 2nd by your words (project, orchid) · 2nd by meaning (cosine 0.811)]",
      "sent: Nina Moreau leads Project Pebble. [4th by your words (leads, project) · 4th by meaning (cosine 0.753)]",
    ])
    await say(BIRD)
    expect(panel().seeds).toEqual([
      "Porto, named in the turn before: your message named nobody", "João Reis, named in the turn before: your message named nobody", "Project Orchid, named in the turn before: your message named nobody",
    ])
    expect(rowsOf(panel().ranked, 7)).toEqual([
      "sent: Ana Silva has parrot Pip. [1st by meaning (cosine 0.787)]",
      "sent: Sven Tavares has parrot Rex. [2nd by meaning (cosine 0.781)]",
      "sent: Omar Moreau has parrot Pepper. [3rd by meaning (cosine 0.779)]",
      "sent: Rui Reis has parrot Coco. [4th by meaning (cosine 0.778)]",
      "sent: Paula Zimmer has parrot Milo. [5th by meaning (cosine 0.775)]",
      "sent: Carla Novak lives in Porto. [1st about a seed (Porto)]",
      "sent: Marco Alves leads Project Sparrow II. [6th by meaning (cosine 0.774)]",
    ])
    // The fused scores: first by meaning adds 1.5 / 10, first about a seed 1 / 10.
    const fused = recalled().memories.filter((memory) => memory.text === "Ana Silva has parrot Pip." || memory.text === "Carla Novak lives in Porto.").map((memory) => `${memory.text} ${memory.fused.toFixed(3)}`)
    expect(fused).toEqual(["Ana Silva has parrot Pip. 0.150", "Carla Novak lives in Porto. 0.100"])
    expect(replies().at(-1)).toBe("From what I know: Ana Silva has parrot Pip.")

    // Step 5: by meaning alone, another Reis's dog comes first; about a seed and by the words, Rui Reis's parrot.
    await say(PET)
    expect(replies().at(-1)).toBe("From what I know: Rui Reis has parrot Coco.")
    expect(rowsOf(panel().ranked, 5)).toEqual([
      "sent: Rui Reis has parrot Coco. [1st about a seed (Rui Reis) · 1st by your words (rui, reis) · 4th by meaning (cosine 0.807)]",
      "sent: Rui Reis works at Virtucon. [2nd about a seed (Rui Reis) · 2nd by your words (rui, reis) · 3rd by meaning (cosine 0.810)]",
      "sent: Marco Ferreira met Rui Reis. [3rd about a seed (Rui Reis) · 3rd by your words (rui, reis) · 6th by meaning (cosine 0.792)]",
      "sent: João Reis has dog Luna. [37th by your words (reis) · 1st by meaning (cosine 0.816)]",
      "sent: Bruno Reis has dog Rex. [38th by your words (reis) · 2nd by meaning (cosine 0.815)]",
    ])

    // Step 6: a new conversation, and a question that names nobody and shares no word with "Bruno Reis lives in Madrid.",
    // which ended when he moved: it ranks 5th by meaning, and gives its place to what replaced it.
    expect(await clear()).toEqual({ _tag: "Built" })
    await say(CAPITAL)
    expect(panel().seeds).toEqual(["Nothing: your message and the turn before it named no entity kept, and held none of your words for yourself."])
    const bruno = panel().ranked.find((row) => row.text === "Bruno Reis lives in Lisbon.")
    expect(bruno).toEqual({
      id: bruno?.id ?? "", text: "Bruno Reis lives in Lisbon.", sent: true, how: ["5th by meaning (cosine 0.755), for what replaced it (Bruno Reis lives in Madrid. ranked there)"],
      why: "sent: among the first 8 of the fused list", before: ["Bruno Reis lives in Madrid."],
    })
    // 6th of the fused list: sent, two places inside the limit.
    expect(panel().ranked.findIndex((row) => row.text === "Bruno Reis lives in Lisbon.")).toBe(5)
    // The memory that ended shares no word with the question: it is in no list but the one by meaning.
    const madrid = recalled().memories.find((memory) => memory.text === "Bruno Reis lives in Lisbon.")
    expect([madrid?.seed, madrid?.words]).toEqual([null, null])
    expect(note()).toContain("Bruno Reis lives in Lisbon.")
    expect(note()).toContain("  before that: Bruno Reis lives in Madrid.")
    expect(replies().at(-1)).toBe("From what I know: Rosa Zimmer lives in Madrid. Jonas Jansen lives in Madrid. Sven Santos lives in Madrid.")

    // Step 7: a new conversation, and a greeting: nothing named, no word met, eight memories by meaning, each a little
    // less like it than the parrot was like the bird question, and more like it than Bruno Reis's was like step 6's.
    expect(await clear()).toEqual({ _tag: "Built" })
    from = heard.length
    await say(THANKS)
    expect(replies().at(-1)).toBe("You're welcome.")
    expect(note()).toHaveLength(8)
    expect(rowsOf(panel().ranked, 9)).toEqual([
      "sent: Eva Kowalski met Wen Dias. [1st by meaning (cosine 0.761)]",
      "sent: Jonas Lopes plays go. [2nd by meaning (cosine 0.759)]",
      "sent: Farid Haddad works at Initech. [3rd by meaning (cosine 0.759)]",
      "sent: Omar Jansen plays go. [4th by meaning (cosine 0.759)]",
      "sent: Ines Kowalski works at Blue Sun. [5th by meaning (cosine 0.757)]",
      "sent: Yusuf Zimmer works at Massive Dynamic. [6th by meaning (cosine 0.757)]",
      "sent: Wen Castro met Ines Kowalski. [7th by meaning (cosine 0.757)]",
      "sent: Wen Dias met Yusuf Gomes. [8th by meaning (cosine 0.757)]",
      "not sent: Farid Novak works at Oscorp. [9th by meaning (cosine 0.755)]",
    ])
    expect(statuses().at(-1)).toBe("Curated turn 1: 0 new, 0 said again, 0 ended; 0 dropped")
    expect(embedded(from)).toEqual(["query 1"])
  })

  test("experiment, the list by meaning off: lesson 18's recall, nothing embedded, and the bird question is sent nothing", async () => {
    const { runtime, say, replies, panel, embedded, heard, note } = await page(applied("meaning-off"))
    await runtime.loadEmbedder()
    await runtime.loadWorld()
    const from = heard.length
    await say(BIRD)
    expect(replies().at(-1)).toBe('You said: "Who keeps a bird?". This is the start of the conversation.')
    expect(note()).toEqual([])
    expect(embedded(from)).toEqual([])
    expect(Option.getOrThrow(panel().byMeaning)).toBe("The list by meaning is off: its weight is 0, so nothing was turned into numbers.")
  })

  test("experiment, the words list off: Rui Reis's work comes before his parrot", async () => {
    const { runtime, say, replies, panel } = await page(applied("words-off"))
    await runtime.loadEmbedder()
    await runtime.loadWorld()
    await say(PET)
    expect(replies().at(-1)).toBe("From what I know: Rui Reis works at Virtucon.")
    expect(rowsOf(panel().ranked, 2)).toEqual([
      "sent: Rui Reis works at Virtucon. [2nd about a seed (Rui Reis) · 3rd by meaning (cosine 0.810)]",
      "sent: Rui Reis has parrot Coco. [1st about a seed (Rui Reis) · 4th by meaning (cosine 0.807)]",
    ])
  })

  test("experiment, a floor of 0.77: the greeting is sent nothing, step 6's question loses Bruno Reis, and the bird question keeps its parrots", async () => {
    const { runtime, say, replies, panel, note } = await page(applied("floor"))
    await runtime.loadEmbedder()
    await runtime.loadWorld()
    await say(THANKS)
    expect(note()).toEqual([])
    expect(replies().at(-1)).toBe('You said: "Thanks!". This is the start of the conversation.')
    expect(panel().options).toBe("limit: 8 · walk: 3 · pool: 50 · weights: seed 1, words 0.5, meaning 1.5 · floor: 0.77 · vectors of Xenova/e5-small-v2")
    await say(CAPITAL)
    expect(note().some((line) => line.includes("Bruno Reis"))).toBe(false)
    await say(BIRD)
    expect(note().slice(0, 5)).toEqual(["Ana Silva has parrot Pip.", "Sven Tavares has parrot Rex.", "Omar Moreau has parrot Pepper.", "Rui Reis has parrot Coco.", "Paula Zimmer has parrot Milo."])
    expect(replies().at(-1)).toBe("From what I know: Ana Silva has parrot Pip.")
  })

  test("the meaning control: at 0.5 the bird question straight after the Orchid question is sent no parrot; at 1 the parrot is sent second", async () => {
    for (const [weight, place] of [[0.5, -1], [1, 1]] as const) {
      const { runtime, say, note } = await page(controlled("meaning", weight))
      await runtime.loadEmbedder()
      await runtime.loadWorld()
      await say(ORCHID)
      await say(BIRD)
      expect({ weight, place: note().indexOf("Ana Silva has parrot Pip.") }).toEqual({ weight, place })
      expect(note()[0]).toBe("Carla Novak lives in Porto.")
    }
  })

  test("Rebuild and Clear context keep the embedder and the store: the next request embeds its message alone", async () => {
    const { runtime, say, embedded, heard, clear } = await page()
    await runtime.loadEmbedder()
    await runtime.loadWorld()
    expect(await runtime.start(SOURCES)).toEqual({ _tag: "Built" })
    let from = heard.length
    await say(BIRD)
    expect(embedded(from)).toEqual(["query 1"])
    expect(await clear()).toEqual({ _tag: "Built" })
    from = heard.length
    await say(BIRD)
    expect(embedded(from)).toEqual(["query 1"])
    expect(runtime.embedderLoaded).toBe(true)
  })

  test("the kernel's event names the model and the pool, and the list by meaning ranks no more than the pool", async () => {
    const { runtime, say, recalled } = await page(controlled("pool", 3))
    await runtime.loadEmbedder()
    await runtime.loadWorld()
    await say(BIRD)
    expect(recalled().meaning).toEqual({ model: EMBEDDER_MODEL, pool: 3, floor: null, skipped: null })
    expect(recalled().memories.filter((memory) => memory.meaning !== null).map((memory) => memory.meaning?.place)).toEqual([1, 2, 3])
  })
})
