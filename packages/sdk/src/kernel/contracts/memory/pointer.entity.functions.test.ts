import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { assistantMessage, Seq, toolResult, TurnNumber, userMessage } from "@xandreed/core/kernel"
import type { Message, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens } from "./memory.entity.functions.js"
import { noResultAt, pageOf, pastTheEnd, pointed, pointerText, previewOf, resultText } from "./pointer.entity.functions.js"

/** Drafts as a journal: each at the next place, in turn 1. */
const journalOf = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> =>
  drafts.map((draft, index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(1) }))

const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1} of the article on tides.`).join("\n")
const sent = pointed({ overTokens: 100, previewTokens: 20 })
const said = (record: StoredEvent | undefined): Message | undefined => record === undefined ? undefined : Option.getOrUndefined(sent(record))

describe("a long result sent as a pointer", () => {
  test("the pointer's words are fixed: the start of the result in its frame, then one host note with its length and the call that reads on", () => {
    expect(pointerText(4, "abcdefghij".repeat(50), "abcdefghijabcdefghij")).toBe(
      "<tool-result-preview>\nabcdefghijabcdefghij\n</tool-result-preview>\n[Host note: the result above is cut short: it is 500 characters long and its first 20 are shown. To read on, call readResult with result 4 and from 20.]",
    )
  })

  test("a result over the size is the same call's result, its text the pointer; shorter ones, a user's and the model's messages are as stored", () => {
    const article = lines(40)
    const journal = journalOf([
      userMessage("Look up tides."),
      assistantMessage("", { toolCalls: [{ id: "c1", name: "lookup", params: { topic: "tides" } }] }),
      toolResult({ id: "c1", name: "lookup" }, article),
      toolResult({ id: "c2", name: "lookup" }, "Tides rise and fall twice a day."),
      toolResult({ id: "c3", name: "lookup" }, article, true),
    ])
    expect(said(journal[0])).toEqual({ _tag: "User", text: "Look up tides." })
    expect(said(journal[1])).toMatchObject({ _tag: "Assistant", toolCalls: [{ id: "c1", name: "lookup" }] })
    expect(said(journal[2])).toEqual({ _tag: "ToolResult", id: "c1", name: "lookup", isFailure: false, result: pointerText(3, article, article.slice(0, 80)) } as Message)
    expect(said(journal[3])).toEqual({ _tag: "ToolResult", id: "c2", name: "lookup", isFailure: false, result: "Tides rise and fall twice a day." } as Message)
    // A failed result is pointed like any other, and stays a failure.
    expect(said(journal[4])).toEqual({ _tag: "ToolResult", id: "c3", name: "lookup", isFailure: true, result: pointerText(5, article, article.slice(0, 80)) } as Message)
    // The rule reads the record alone: asked again, it answers the same.
    expect(said(journal[2])).toEqual(said(journal[2]))
  })

  test("three long results are left as stored: one its tool marked whole, a page readResult returned, and one a pointer would not shorten", () => {
    const article = lines(40)
    const page = { text: article, from: 0, to: article.length, total: article.length }
    const barely = "x".repeat(404)
    const journal = journalOf([
      toolResult({ id: "c1", name: "loadSkill" }, article, false, { whole: true }),
      // A loop that stores results itself gives readResult's page no `whole`: its name alone keeps it whole.
      toolResult({ id: "c2", name: "readResult" }, page),
      toolResult({ id: "c3", name: "lookup" }, barely),
    ])
    expect(said(journal[0])).toMatchObject({ result: article, whole: true })
    expect(said(journal[1])).toMatchObject({ result: page })
    // Just over the size, with a preview nearly as long: the preview, its frame and the note together would be
    // longer than the text itself, so the text is sent. A shorter preview points the same result.
    expect(Number(estimateTokens(barely))).toBeGreaterThan(100)
    expect(Option.getOrUndefined(pointed({ overTokens: 100, previewTokens: 90 })(journal[2]!))).toMatchObject({ result: barely })
    expect(said(journal[2])).toMatchObject({ result: pointerText(3, barely, barely.slice(0, 80)) })
  })

  test("a structured result is measured and read as its JSON", () => {
    const rows = { rows: Array.from({ length: 60 }, (_, index) => ({ n: index, square: index * index })) }
    const journal = journalOf([toolResult({ id: "c1", name: "table" }, rows)])
    const text = JSON.stringify(rows)
    expect(resultText(rows)).toBe(text)
    expect(said(journal[0])).toMatchObject({ result: pointerText(1, text, text.slice(0, 80)) })
  })

  test("options that are none are refused where they are written", () => {
    expect(() => pointed({ overTokens: Number.NaN, previewTokens: 20 })).toThrow("pointers need overTokens and previewTokens of at least one token each; they were given overTokens NaN and previewTokens 20")
    expect(() => pointed({ overTokens: 100, previewTokens: 0 })).toThrow("at least one token each")
    expect(() => pointed({ overTokens: 100, previewTokens: Number.POSITIVE_INFINITY })).toThrow("at least one token each")
    expect(() => pointed({ overTokens: 20, previewTokens: 100 })).toThrow("a preview of 100 tokens is not shorter than the results it stands for, those over 20 tokens: give pointers a previewTokens below overTokens")
    // Untyped code that leaves a number out is refused the same way.
    expect(() => pointed({ overTokens: 100 } as never)).toThrow("at least one token each")
  })
})

describe("reading on from a pointer", () => {
  /** Follow a pointer as a model does: the preview, then each page from where the last one ended. */
  const followed = (text: string, preview: number, length: number) => {
    const journal = journalOf([toolResult({ id: "c1", name: "lookup" }, text)])
    const start = previewOf(text, preview)
    const pages: Array<string> = [start]
    for (let from = start.length; from < text.length;) {
      const page = Result.getOrThrow(pageOf(journal, 1, from, length))
      expect(page.from).toBe(from)
      expect(page.total).toBe(text.length)
      expect(page.to).toBeGreaterThan(from)
      pages.push(page.text)
      from = page.to
    }
    return pages
  }
  /** Whether a text holds no half of a character: no surrogate without its pair. */
  const wellFormed = (text: string) => text.isWellFormed()

  test("the preview, then each page from the last one's end, is the whole text, each character once, and no part cuts a character in two", () => {
    const texts = [
      lines(40),
      "🌊".repeat(300),
      `tide 🌊 ${"é".repeat(200)} 🌕 moon ${"𝒳".repeat(150)} end`,
      "a🌊".repeat(250),
    ]
    for (const text of texts) {
      for (const preview of [1, 2, 3, 80, 81]) {
        for (const length of [1, 2, 3, 7, 100, 2000]) {
          const pages = followed(text, preview, length)
          expect(pages.join("")).toBe(text)
          expect(pages.every(wellFormed)).toBe(true)
        }
      }
    }
  })

  test("a start inside a character moves past it, and a page always reads something", () => {
    const journal = journalOf([toolResult({ id: "c1", name: "lookup" }, "a🌊b🌕c")])
    // The wave is two units, at 1 and 2: a start at 2 is inside it.
    expect(Result.getOrThrow(pageOf(journal, 1, 2, 10))).toEqual({ text: "b🌕c", from: 3, to: 7, total: 7 })
    // One unit asked for at the start of a two-unit character: the whole character.
    expect(Result.getOrThrow(pageOf(journal, 1, 1, 1))).toEqual({ text: "🌊", from: 1, to: 3, total: 7 })
  })

  test("a place that holds no tool result is refused, in words that say what to use", () => {
    const journal = journalOf([userMessage("Look up tides."), toolResult({ id: "c1", name: "lookup" }, "short")])
    expect(noResultAt(9)).toBe("No tool result is stored at 9: use the number a cut-short result names.")
    expect(pageOf(journal, 9, 0, 100)).toEqual(Result.fail(noResultAt(9)))
    // A place that holds a record of another kind is no result either.
    expect(pageOf(journal, 1, 0, 100)).toEqual(Result.fail(noResultAt(1)))
  })

  test("a start at or past the end is refused, in words that give the length", () => {
    const journal = journalOf([toolResult({ id: "c1", name: "lookup" }, "short")])
    expect(pastTheEnd(1, 5)).toBe("The result at 1 is 5 characters long: from must be less than 5.")
    expect(pageOf(journal, 1, 5, 100)).toEqual(Result.fail(pastTheEnd(1, 5)))
    expect(Result.getOrThrow(pageOf(journal, 1, 4, 100))).toEqual({ text: "t", from: 4, to: 5, total: 5 })
    // An empty result has one page, nothing, from 0; any later start is past its end.
    const empty = journalOf([toolResult({ id: "c1", name: "lookup" }, "")])
    expect(Result.getOrThrow(pageOf(empty, 1, 0, 100))).toEqual({ text: "", from: 0, to: 0, total: 0 })
    expect(pageOf(empty, 1, 3, 100)).toEqual(Result.fail(pastTheEnd(1, 0)))
  })
})
