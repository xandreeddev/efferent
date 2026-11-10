import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Result } from "effect"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { LogHandle, ToolViews } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { toolParametersSchema } from "../turn/tool-schema.entity.functions.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { canonicalJson, entryId } from "./memory-log.entity.functions.js"
import { EntryId } from "./memory-log.entity.js"
import type { CompactionAction, LogBody, LogEntry } from "./memory-log.entity.js"
import { noMaintenance, openLogSession, readerOf } from "./memory-session.js"
import type { MemoryPolicy } from "./memory-session.js"
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
  // The result held is an earlier turn's (the run is in turn 2), so its pages are served whatever that turn showed of it.
  const recalledFrom = (held: LogEntry) => (params: { readonly locator: string; readonly offset?: number }) => Effect.runPromise(Effect.result(recall.handler(params).pipe(
    Effect.provideService(RunContext, RunContext.of({ memory: {
      turn: Effect.succeed(2), entries: Effect.succeed([held]),
      resolve: (id: string) => Effect.succeed(Option.some(held).pipe(Option.filter((entry) => entry.id === id))),
    } } as never)),
  )))
  const recalled = recalledFrom(stored)

  test("the preview says how many characters it left out and the offset to read them from, never a negative count", () => {
    expect(spillPreview(stored, "abcdef", 4)).toBe(`abcd\n[… 2 more characters kept out of context; call recall_context with locator "run-1:2" and offset 4 to read them]`)
    expect(spillPreview(stored, "abc", 10)).toBe(`abc\n[… 0 more characters kept out of context; call recall_context with locator "run-1:2" and offset 3 to read them]`)
  })

  test("recall_context says what it returns and how to page", () => {
    expect(recall.tool.description).toBe("Read on in a tool result that is shown shortened, by the locator its shortened form shows. Returns at most 8000 characters from offset (0 by default); when more remains, the reply ends with the offset to pass next. Text still shown in this turn is not returned again: the reply names the offset to read from.")
    expect(RECALL_PAGE_CHARS).toBe(8_000)
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

/*
 * The guard, in the turn that wrote the result. Each call is made as the step
 * loop makes one: the call is recorded, the handler runs with the run's
 * memory, and its answer is recorded before the next call. The session is a
 * real one, so a refusal is checked against what its next request shows.
 */
describe("recall_context in the turn that wrote the result", () => {
  const recall = recallCapabilityOf("example/recall").tools[0]!
  const BOUND = 16_000
  // No tool has a view here: a result is shown as its text, a returned failure as its JSON.
  const views: ToolViews = {
    view: (_tool, encoded) => Effect.succeed({ text: typeof encoded === "string" ? encoded : canonicalJson(encoded), version: "raw", subjects: [], artifacts: [], pinned: false }),
    compact: () => Effect.succeed(Option.none()),
    digest: () => Effect.succeed(Option.none()),
  }
  const policy: MemoryPolicy = {
    strategy: { id: "test", version: "1" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
    digestOnWrite: Option.none(), boundOnWriteChars: BOUND,
    maintain: () => Effect.succeed(noMaintenance),
  }
  /** Numbered lines of 20 characters, so every page of a text differs from every other. */
  const lines = (chars: number, name = "text"): string => Array.from({ length: Math.ceil(chars / 20) }, (_, index) => `line ${String(index).padStart(6, "0")} of ${name}\n`).join("").slice(0, chars)
  /** The notice core ends a bounded or spilled result with. */
  const preview = (text: string, locator: string, chars: number): string =>
    `${text.slice(0, chars)}\n[… ${text.length - chars} more characters kept out of context; call recall_context with locator "${locator}" and offset ${chars} to read them]`
  const page = (text: string, locator: string, from: number): string => from + RECALL_PAGE_CHARS >= text.length ? text.slice(from)
    : `${text.slice(from, from + RECALL_PAGE_CHARS)}\n[… ${text.length - from - RECALL_PAGE_CHARS} more characters; call recall_context with locator "${locator}" and offset ${from + RECALL_PAGE_CHARS}]`
  const shownInFull = { error: "ResultShown", message: "This result is shown in full above; nothing of it was left out." }

  interface Turn {
    /** Start the next turn. */
    readonly begin: (text: string) => Effect.Effect<void, unknown>
    /** A `lookup` call and its result: the result's locator. */
    readonly returned: (text: string) => Effect.Effect<string, unknown>
    /** A `recall_context` call: its page or the failure it returned, and the locator of that answer. */
    readonly asked: (params: { readonly locator: string; readonly offset?: number }) => Effect.Effect<{ readonly answer: unknown; readonly locator: string }, unknown>
    /** A `recall_context` call: its page, or the failure it returned. */
    readonly ask: (params: { readonly locator: string; readonly offset?: number }) => Effect.Effect<unknown, unknown>
    /** One of the strategy's own compactions, recorded as `maintain` records a decision. */
    readonly compacted: (action: CompactionAction) => Effect.Effect<void, unknown>
    /** A digest of a result, recorded as the session records one. */
    readonly digested: (locator: string, text: string) => Effect.Effect<void, unknown>
    /** What the next request shows for each tool result, in order. */
    readonly shown: Effect.Effect<ReadonlyArray<string>, unknown>
  }

  const inSession = <A>(body: (turn: Turn) => Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, policy, { runId: RunId.make("run-1") })
    const steps = yield* Ref.make(0)
    const exchange = (toolName: string, input: unknown, answer: Effect.Effect<{ readonly output: unknown; readonly isError: boolean }, unknown>) => Effect.gen(function* () {
      const step = yield* Ref.updateAndGet(steps, (count) => count + 1)
      const toolCallId = ToolCallId.make(`c${step}`)
      yield* session.recordTail([{ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] }], views, step)
      const { output, isError } = yield* answer
      const recorded = yield* session.recordTail([{ role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output, isError }] }], views, step)
      return { answer: output, locator: String(recorded[0]?.id) }
    })
    const record = (body: LogBody) => session.record([body], 0).pipe(Effect.asVoid)
    const asked: Turn["asked"] = (params) => exchange(RECALL_TOOL, params, Effect.result(recall.handler(params).pipe(
      Effect.provideService(RunContext, RunContext.of({ memory: readerOf(session) } as never)),
    )).pipe(Effect.map((answered) => answered._tag === "Success" ? { output: answered.success, isError: false } : { output: answered.failure, isError: true })))
    return yield* body({
      begin: (text) => record({ _tag: "TurnStarted", userMessage: new UserMessage({ text }) }),
      returned: (text) => exchange("lookup", {}, Effect.succeed({ output: text, isError: false })).pipe(Effect.map((made) => made.locator)),
      asked,
      ask: (params) => asked(params).pipe(Effect.map((made) => made.answer)),
      compacted: (action) => record({ _tag: "Compaction", strategy: policy.strategy.id, version: policy.strategy.version, action }),
      digested: (locator, text) => record({ _tag: "ToolDigest", entry: EntryId.make(locator), version: "1", mode: "summarize", keep: [], text, digester: "test@1", trigger: "compaction" }),
      shown: session.build({ stepContext: "none", run: RunOrdinal.make(0) }).pipe(Effect.map((built) => built.messages.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.output)) : []))),
    })
  }))

  describe("text still shown is refused, with the offset to read from", () => {
    test("a bounded result is refused anywhere in its head, with the shown length as the offset to pass", async () => {
      const text = lines(40_000)
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read the record")
        const locator = yield* turn.returned(text)
        const shown = yield* turn.shown
        const start = yield* turn.ask({ locator })
        const inside = yield* turn.ask({ locator, offset: BOUND - 1 })
        const next = yield* turn.ask({ locator, offset: BOUND })
        return { locator, shown, start, inside, next }
      }))
      // The request shows the first 16,000 characters and the notice, whose offset the refusal repeats.
      expect(seen.shown).toEqual([preview(text, seen.locator, BOUND)])
      const refusal = { error: "ResultShown", message: "The first 16000 characters of this result are shown above. To read on, pass offset 16000." }
      expect(seen.start).toEqual(refusal)
      expect(seen.inside).toEqual(refusal)
      expect(seen.next).toBe(page(text, seen.locator, BOUND))
    })

    test("a result shown whole is refused at every offset: nothing of it was left out", async () => {
      const text = lines(2_000)
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read the record")
        const locator = yield* turn.returned(text)
        const shown = yield* turn.shown
        const start = yield* turn.ask({ locator })
        const last = yield* turn.ask({ locator, offset: 1_999 })
        const past = yield* turn.ask({ locator, offset: 2_000 })
        return { shown, start, last, past }
      }))
      expect(seen.shown).toEqual([text])
      expect(seen.start).toEqual(shownInFull)
      expect(seen.last).toEqual(shownInFull)
      // An offset past the end is still told the result's length.
      expect(seen.past).toEqual({ error: "OffsetOutOfRange", message: "The result has 2000 characters; pass an offset below 2000" })
    })
  })

  test("a page already read in this turn is refused, with the next offset", async () => {
    const text = lines(40_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const first = yield* turn.ask({ locator, offset: BOUND })
      const again = yield* turn.ask({ locator, offset: BOUND })
      // A refused call is not a page read: the third call is refused for the page the first one read.
      const third = yield* turn.ask({ locator, offset: BOUND })
      return { locator, first, again, third, shown: yield* turn.shown }
    }))
    const refusal = { error: "AlreadyRecalled", message: "You already read this page in this turn and it is shown above. To read on, pass offset 24000." }
    expect(seen.first).toBe(page(text, seen.locator, BOUND))
    expect(seen.again).toEqual(refusal)
    expect(seen.third).toEqual(refusal)
    // The page is in the request, whole, and the offset the refusal names is the one that page ends with.
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND), page(text, seen.locator, BOUND), canonicalJson(refusal), canonicalJson(refusal)])
  })

  test("the last page read again is refused as the end", async () => {
    const text = lines(30_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const last = yield* turn.ask({ locator, offset: 24_000 })
      const again = yield* turn.ask({ locator, offset: 24_000 })
      return { last, again }
    }))
    expect(seen.last).toBe(text.slice(24_000))
    expect(seen.again).toEqual({ error: "AlreadyRecalled", message: "You already read this page in this turn and it is shown above. It ends the result." })
  })

  test("the next page, and a page of an earlier turn, are served", async () => {
    const text = lines(40_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const second = yield* turn.ask({ locator, offset: BOUND })
      const third = yield* turn.ask({ locator, offset: BOUND + RECALL_PAGE_CHARS })
      yield* turn.begin("and what follows?")
      // The result is now an earlier turn's: the guard is this turn's only, so every page of it is served, as often as asked.
      const head = yield* turn.ask({ locator })
      const earlier = yield* turn.ask({ locator, offset: BOUND })
      const repeated = yield* turn.ask({ locator, offset: BOUND })
      return { locator, second, third, head, earlier, repeated }
    }))
    expect(seen.second).toBe(page(text, seen.locator, BOUND))
    expect(seen.third).toBe(page(text, seen.locator, BOUND + RECALL_PAGE_CHARS))
    expect(seen.head).toBe(page(text, seen.locator, 0))
    expect(seen.earlier).toBe(page(text, seen.locator, BOUND))
    expect(seen.repeated).toBe(page(text, seen.locator, BOUND))
  })

  test("only the same result from the same start is a repeat: a new offset is a page", async () => {
    const [north, south] = [lines(40_000, "north"), lines(40_000, "south")]
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read both records")
      const first = yield* turn.returned(north)
      const second = yield* turn.returned(south)
      const read = yield* turn.ask({ locator: first, offset: BOUND })
      const other = yield* turn.ask({ locator: second, offset: BOUND })
      const overlapping = yield* turn.ask({ locator: first, offset: BOUND + 1 })
      return { first, second, read, other, overlapping }
    }))
    expect(seen.read).toBe(page(north, seen.first, BOUND))
    expect(seen.other).toBe(page(south, seen.second, BOUND))
    expect(seen.overlapping).toBe(page(north, seen.first, BOUND + 1))
  })

  test("a result spilled under pressure after it was first shown: the guard follows what is shown now", async () => {
    const [short, long] = [lines(12_000, "short"), lines(40_000, "long")]
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read both records")
      const whole = yield* turn.returned(short)
      const bounded = yield* turn.returned(long)
      const before = { whole: yield* turn.ask({ locator: whole, offset: 4_000 }), bounded: yield* turn.ask({ locator: bounded, offset: 4_000 }) }
      // Under pressure the strategy spills both to its shorter preview: the one shown whole, and the one bounded as it was written.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(whole), preview: preview(short, whole, 600) })
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(bounded), preview: preview(long, bounded, 600) })
      const shown = yield* turn.shown
      const after = {
        whole: yield* turn.ask({ locator: whole }), wholeOn: yield* turn.ask({ locator: whole, offset: 4_000 }),
        bounded: yield* turn.ask({ locator: bounded, offset: 599 }), boundedOn: yield* turn.ask({ locator: bounded, offset: 4_000 }),
      }
      return { whole, bounded, before, shown, after }
    }))
    expect(seen.before).toEqual({ whole: shownInFull, bounded: { error: "ResultShown", message: "The first 16000 characters of this result are shown above. To read on, pass offset 16000." } })
    expect(seen.shown.slice(0, 2)).toEqual([preview(short, seen.whole, 600), preview(long, seen.bounded, 600)])
    const refusal = { error: "ResultShown", message: "The first 600 characters of this result are shown above. To read on, pass offset 600." }
    expect(seen.after.whole).toEqual(refusal)
    expect(seen.after.bounded).toEqual(refusal)
    // The text the spill took out of the request is served from where it was refused before.
    expect(seen.after.wholeOn).toBe(page(short, seen.whole, 4_000))
    expect(seen.after.boundedOn).toBe(page(long, seen.bounded, 4_000))
  })

  test("a bound that falls inside a surrogate pair shows one unit less, and both numbers of the refusal are that length", async () => {
    const text = `${"a".repeat(BOUND - 1)}\u{1F600}${lines(20_000)}`
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const shown = yield* turn.shown
      const start = yield* turn.ask({ locator })
      const next = yield* turn.ask({ locator, offset: BOUND - 1 })
      // An offset inside the pair starts at the pair's first unit: the page just read.
      const inside = yield* turn.ask({ locator, offset: BOUND })
      return { locator, shown, start, next, inside }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND - 1)])
    expect(seen.start).toEqual({ error: "ResultShown", message: "The first 15999 characters of this result are shown above. To read on, pass offset 15999." })
    expect(seen.next).toBe(page(text, seen.locator, BOUND - 1))
    expect(seen.inside).toEqual({ error: "AlreadyRecalled", message: "You already read this page in this turn and it is shown above. To read on, pass offset 23999." })
  })

  test("a result shown through a compact view, a digest or a preview core did not write is served from its start", async () => {
    const names = ["compact", "digest", "own", "altered", "both"] as const
    const texts = names.map((name) => lines(2_000, name))
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the records")
      const [compact, digest, own, altered, both] = yield* Effect.forEach(texts, turn.returned, { concurrency: 1 })
      yield* turn.compacted({ _tag: "CompactViews", entries: [EntryId.make(compact ?? "")], texts: ["a compact view"] })
      yield* turn.digested(digest ?? "", "a digest")
      // A custom strategy's preview is its own text: nothing says how much of the view it shows.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(own ?? ""), preview: "the strategy's own words" })
      // A preview that ends with core's notice over a head that is not the view's.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(altered ?? ""), preview: preview(`${"z".repeat(600)}${texts[3]?.slice(600) ?? ""}`, altered ?? "", 600) })
      // A digest and then core's preview: the preview is what the request shows, as in the render.
      yield* turn.digested(both ?? "", "a digest")
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(both ?? ""), preview: preview(texts[4] ?? "", both ?? "", 600) })
      const shown = yield* turn.shown
      const served = yield* Effect.forEach([compact, digest, own, altered, both], (locator) => turn.ask({ locator: locator ?? "" }), { concurrency: 1 })
      return { altered, both, shown, served }
    }))
    expect(seen.shown).toEqual(["a compact view", "a digest", "the strategy's own words", `${"z".repeat(600)}\n[… 1400 more characters kept out of context; call recall_context with locator "${seen.altered}" and offset 600 to read them]`, preview(texts[4] ?? "", seen.both ?? "", 600)])
    expect(seen.served).toEqual([texts[0], texts[1], texts[2], texts[3], { error: "ResultShown", message: "The first 600 characters of this result are shown above. To read on, pass offset 600." }])
  })

  test("a page read earlier that is no longer shown whole is served again", async () => {
    const text = lines(40_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const read = yield* turn.asked({ locator, offset: BOUND })
      // A strategy that shortens a recalled page (none of core's does) takes the page out of the request.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(read.locator), preview: preview(String(read.answer), read.locator, 600) })
      const shown = yield* turn.shown
      return { locator, read, shown, again: yield* turn.ask({ locator, offset: BOUND }) }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND), preview(page(text, seen.locator, BOUND), seen.read.locator, 600)])
    expect(seen.again).toBe(page(text, seen.locator, BOUND))
  })
})
