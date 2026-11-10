import { describe, expect, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId } from "../domain/run.entity.js"
import { RunContext } from "../ports/run-context.port.js"
import { toolParametersSchema } from "../turn/tool-schema.entity.functions.js"
import { entryId } from "./memory-log.entity.functions.js"
import type { LogEntry } from "./memory-log.entity.js"
import { RECALL_PAGE_CHARS, RECALL_TOOL, recallCapabilityOf, recallPage, spillPreview } from "./recall.entity.functions.js"

const result = (seq: number, turn: number, view: string): LogEntry => ({
  id: entryId(RunId.make(`run-${turn}`), seq), runId: RunId.make(`run-${turn}`), turn, step: 0, at: seq,
  body: { _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false },
})

describe("reading a spilled result back", () => {
  const capability = recallCapabilityOf("example/recall")
  const recall = capability.tools[0]!
  const stored = result(2, 1, "x".repeat(RECALL_PAGE_CHARS + 500))
  // The handler declares the one service it reads, the run (of which it uses the memory), and gets it where it runs.
  const recalledFrom = (held: LogEntry) => (params: { readonly locator: string; readonly offset?: number }) => Effect.runPromise(Effect.result(recall.handler(params).pipe(
    Effect.provideService(RunContext, RunContext.of({ memory: { resolve: (id: string) => Effect.succeed(Option.some(held).pipe(Option.filter((entry) => entry.id === id))) } } as never)),
  )))
  const recalled = recalledFrom(stored)

  test("the preview says how many characters it left out and the offset to read them from, never a negative count", () => {
    expect(spillPreview(stored, "abcdef", 4)).toBe(`abcd\n[… 2 more characters kept out of context; call recall_context with locator "run-1:2" and offset 4 to read them]`)
    expect(spillPreview(stored, "abc", 10)).toBe(`abc\n[… 0 more characters kept out of context; call recall_context with locator "run-1:2" and offset 3 to read them]`)
  })

  test("recall_context says what it returns and how to page", () => {
    expect(recall.tool.description).toBe(`Read an earlier result that was shortened to save context, by the locator its shortened form shows. Returns at most ${RECALL_PAGE_CHARS} characters from offset (0 by default); when more remain, the reply ends with the offset to pass next.`)
    expect(toolParametersSchema(recall.tool)).toMatchObject({
      properties: {
        locator: { type: "string", description: "The locator the shortened result shows." },
        offset: { description: "The first character to return; 0 by default." },
      },
      required: ["locator"],
    })
  })

  test("a result comes back a page at a time, each page ending with the offset of the next", async () => {
    expect(recallPage("run-1:2", "abcdef", 2)).toBe("cdef")
    expect(await recalled({ locator: "run-1:2" })).toMatchObject({ _tag: "Success", success: `${"x".repeat(RECALL_PAGE_CHARS)}\n[… 500 more characters; call recall_context with locator "run-1:2" and offset ${RECALL_PAGE_CHARS}]` })
    expect(await recalled({ locator: "run-1:2", offset: RECALL_PAGE_CHARS })).toMatchObject({ _tag: "Success", success: "x".repeat(500) })
    expect(Result.getFailure(await recalled({ locator: "run-1:2", offset: RECALL_PAGE_CHARS + 500 }))).toEqual(Option.some({ error: "OffsetOutOfRange", message: `The result has ${RECALL_PAGE_CHARS + 500} characters; pass an offset below ${RECALL_PAGE_CHARS + 500}` }))
    expect(Result.getFailure(await recalled({ locator: "run-9:9" }))).toEqual(Option.some({ error: "UnknownLocator", message: "No stored result has locator run-9:9; pass a locator exactly as a shortened result shows it" }))
  })

  describe("a cut never splits a surrogate pair", () => {
    // Text with no lone surrogate: each high one is followed by a low one, each low one preceded by a high one.
    const wellFormed = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    const face = "\u{1F600}"
    const offsetIn = (text: string): number => Number(/ and offset (\d+)(?: to read them)?\]$/.exec(text)?.[1])
    // One pair sits across unit 100, where the preview is cut; another across the end of the page read from there.
    const view = `${"a".repeat(99)}${face}${"b".repeat(RECALL_PAGE_CHARS - 3)}${face}${"c".repeat(500)}`
    const held = result(2, 1, view)

    test("a preview cut inside a pair ends before it, and says so in its count and its offset", () => {
      expect(view.slice(0, 100).endsWith(face.charAt(0))).toBe(true)
      expect(wellFormed(view.slice(0, 100))).toBe(false)
      const preview = spillPreview(held, view, 100)
      expect(preview).toBe(`${"a".repeat(99)}\n[… ${view.length - 99} more characters kept out of context; call recall_context with locator "run-1:2" and offset 99 to read them]`)
      expect(wellFormed(preview)).toBe(true)
      // A cut beside a pair, not inside one, stays where it was asked.
      expect(offsetIn(spillPreview(held, view, 99))).toBe(99)
      expect(offsetIn(spillPreview(held, view, 101))).toBe(101)
      expect(wellFormed(spillPreview(held, view, 101))).toBe(true)
    })

    test("the pages read from the preview's offset are well formed and join to the whole view", async () => {
      const preview = spillPreview(held, view, 100)
      const read = recalledFrom(held)
      const pageOf = (page: Awaited<ReturnType<typeof read>>): string => page._tag === "Success" ? String(page.success) : "refused"
      const first = pageOf(await read({ locator: "run-1:2", offset: offsetIn(preview) }))
      // The page would end at unit 99 + RECALL_PAGE_CHARS, inside the second pair: it ends one unit earlier and prints that offset.
      const firstEnd = 99 + RECALL_PAGE_CHARS - 1
      expect(first).toBe(`${view.slice(99, firstEnd)}\n[… ${view.length - firstEnd} more characters; call recall_context with locator "run-1:2" and offset ${firstEnd}]`)
      expect(wellFormed(first)).toBe(true)
      const second = pageOf(await read({ locator: "run-1:2", offset: offsetIn(first) }))
      expect(second).toBe(view.slice(firstEnd))
      const body = (text: string) => text.slice(0, text.lastIndexOf("\n["))
      expect(`${body(preview)}${body(first)}${second}`).toBe(view)
    })

    test("an offset given inside a pair starts at the pair's first unit", () => {
      expect(recallPage("run-1:2", `a${face}b`, 2)).toBe(`${face}b`)
      expect(recallPage("run-1:2", `a${face}b`, 1)).toBe(`${face}b`)
      expect(recallPage("run-1:2", `a${face}b`, 3)).toBe("b")
    })
  })

  test("recall_context declares the run it reads the memory of, and a call without one fails with requires.missing", async () => {
    expect(recall.requires).toEqual([RunContext.key])
    expect(await Effect.runPromise(Effect.result(recall.handler({ locator: "run-1:2" })))).toMatchObject({ _tag: "Failure", failure: { code: "requires.missing" } })
  })

  test("the capability has the id it is given, version 1, the one read-only tool and its always-on skill", () => {
    expect<unknown>({
      id: capability.id, version: capability.version,
      tools: capability.tools.map((registered) => ({ name: registered.tool.name, annotations: registered.annotations })),
      skills: capability.skills, promptSections: capability.promptSections,
    }).toEqual({
      id: "example/recall", version: "1",
      tools: [{ name: "recall_context", annotations: { readOnly: true, pollable: false, pinned: false, permissions: [], maxCallsPerRun: Option.none(), labels: {}, stage: Option.none() } }],
      skills: [{ id: "memory.recall", version: "1", summary: "Read shortened earlier results in full.", instructions: "", tools: ["recall_context"], always: true, permissions: [], references: [] }],
      promptSections: [],
    })
    expect<string>(RECALL_TOOL).toBe("recall_context")
    expect<string>(recallCapabilityOf("another/recall").id).toBe("another/recall")
  })
})
