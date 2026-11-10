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
  const recalled = (params: { readonly locator: string; readonly offset?: number }) => Effect.runPromise(Effect.result(recall.handler(params).pipe(
    Effect.provideService(RunContext, RunContext.of({ memory: { resolve: (id: string) => Effect.succeed(Option.some(stored).pipe(Option.filter((entry) => entry.id === id))) } } as never)),
  )))

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
