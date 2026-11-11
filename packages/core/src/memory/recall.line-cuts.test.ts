import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Schema } from "effect"
import { Failure } from "../domain/failure.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { CurrentAgentRun } from "../loop/stepContext.js"
import type { LogHandle, ToolViews } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { canonicalJson, entryId } from "./memory-log.entity.functions.js"
import { EntryId } from "./memory-log.entity.js"
import type { CompactionAction, LogBody, LogEntry } from "./memory-log.entity.js"
import { noMaintenance, openLogSession, readerOf } from "./memory-session.js"
import type { MemoryPolicy } from "./memory-session.js"
import { cutAfterLineBreak, RECALL_PAGE_CHARS, RECALL_TOOL, recallCapabilityOf, spillPreview } from "./recall.entity.functions.js"

/*
 * The opt-in cut at line breaks (`cutAtLineBreaks`): the rule, the previews
 * it cuts, the pages `recall_context` serves with it, and the guard over
 * both. The texts here are rows of 37 characters, which divides none of the
 * limits (600, 8,000, 16,000), so a cut at a line break is never the cut at
 * the character limit: a test that passes with either cut proves nothing.
 */

const face = "\u{1F600}"
/** Text with no lone surrogate. */
const wellFormed = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

describe("where a cut at a line break falls", () => {
  /** 200 characters with one line break, at `index`. */
  const oneBreakAt = (index: number): string => `${"a".repeat(index)}\n${"b".repeat(199 - index)}`

  test("a line break in the last quarter of the piece is used: the cut falls just after it", () => {
    // The piece asked for is 100 characters from 0, so its last quarter is 25.
    expect(cutAfterLineBreak(oneBreakAt(80), 0, 100)).toBe(81)
    expect(cutAfterLineBreak(oneBreakAt(98), 0, 100)).toBe(99)
    // Exactly a quarter given up is still within it.
    expect(cutAfterLineBreak(oneBreakAt(74), 0, 100)).toBe(75)
    // The last line break before the cut is the one used, not an earlier one.
    expect(cutAfterLineBreak(`${"a".repeat(76)}\n${"b".repeat(9)}\n${"c".repeat(113)}`, 0, 100)).toBe(87)
  })

  test("a line break just outside the last quarter is not used: the cut stays at the character limit", () => {
    expect(cutAfterLineBreak(oneBreakAt(73), 0, 100)).toBe(100)
    expect(cutAfterLineBreak(oneBreakAt(10), 0, 100)).toBe(100)
  })

  test("the quarter is of the piece asked for, from its own start", () => {
    // A piece of 100 characters from 1,000: a line break 25 back is used, one 26 back is not.
    const text = (index: number) => `${"a".repeat(index)}\n${"b".repeat(1_299 - index)}`
    expect(cutAfterLineBreak(text(1_074), 1_000, 1_100)).toBe(1_075)
    expect(cutAfterLineBreak(text(1_073), 1_000, 1_100)).toBe(1_100)
    // The same break is well inside the last quarter of a piece that starts at 0.
    expect(cutAfterLineBreak(text(1_073), 0, 1_100)).toBe(1_074)
  })

  test("a text with no line break is cut at the character limit", () => {
    expect(cutAfterLineBreak("x".repeat(200), 0, 100)).toBe(100)
    expect(cutAfterLineBreak("x".repeat(200), 40, 140)).toBe(140)
  })

  test("a cut that reaches the end of the text stays there, whatever line breaks the text holds", () => {
    expect(cutAfterLineBreak(oneBreakAt(190), 0, 200)).toBe(200)
    expect(cutAfterLineBreak(oneBreakAt(190), 0, 5_000)).toBe(200)
    expect(cutAfterLineBreak("", 0, 100)).toBe(0)
  })

  test("a line break exactly at the limit: the cut already falls after it, and one that is the first character past the limit is not looked at", () => {
    // The break is the last character of the piece: nothing is given up.
    expect(cutAfterLineBreak(oneBreakAt(99), 0, 100)).toBe(100)
    // The break is the first character past the limit. Only breaks before the cut count: with none in the last quarter the character cut stays,
    expect(cutAfterLineBreak(oneBreakAt(100), 0, 100)).toBe(100)
    // and with one, the cut falls after that one.
    expect(cutAfterLineBreak(`${"a".repeat(90)}\n${"b".repeat(9)}\n${"c".repeat(99)}`, 0, 100)).toBe(91)
  })

  test("a carriage return and its line feed stay together when the cut falls after the pair, and a character cut between them is left as it is", () => {
    const text = `${"a".repeat(80)}\r\n${"b".repeat(118)}`
    expect(cutAfterLineBreak(text, 0, 100)).toBe(82)
    expect(text.slice(0, 82).endsWith("\r\n")).toBe(true)
    // The character limit falls between the two, and no line feed is before it: the rule only ever moves a cut to just after a line feed.
    const split = `${"a".repeat(99)}\r\n${"b".repeat(99)}`
    expect(cutAfterLineBreak(split, 0, 100)).toBe(100)
    expect(split.slice(0, 100).endsWith("\r")).toBe(true)
  })

  test("a surrogate pair at the limit is never split, with or without a line break near it", () => {
    // The pair sits across unit 100. No line break: the character cut, one unit earlier.
    const plain = `${"a".repeat(99)}${face}${"b".repeat(99)}`
    expect(cutAfterLineBreak(plain, 0, 100)).toBe(99)
    // A line break in the last quarter: the cut falls after it.
    const broken = `${"a".repeat(79)}\n${"c".repeat(19)}${face}${"b".repeat(99)}`
    expect(cutAfterLineBreak(broken, 0, 100)).toBe(80)
    // A line break right before the pair: the character cut is already there.
    const beside = `${"a".repeat(98)}\n${face}${"b".repeat(99)}`
    expect(cutAfterLineBreak(beside, 0, 100)).toBe(99)
    expect([plain.slice(0, 99), broken.slice(0, 80), beside.slice(0, 99)].every(wellFormed)).toBe(true)
    // What a line break gives up is counted from the character cut, one unit before the limit here: a break 25 back from it is within the quarter of the 100 asked for,
    const within = `${"a".repeat(73)}\n${"c".repeat(25)}${face}${"b".repeat(99)}`
    expect(cutAfterLineBreak(within, 0, 100)).toBe(74)
    // and one 26 back is not, at the limit or again at the cut it left.
    const outside = `${"a".repeat(72)}\n${"c".repeat(26)}${face}${"b".repeat(99)}`
    expect(cutAfterLineBreak(outside, 0, 100)).toBe(99)
    expect(cutAfterLineBreak(outside, 0, 99)).toBe(99)
  })

  test("a piece that would become empty keeps its character cut", () => {
    // The only line break before the cut is the character before the piece: cutting after it would leave nothing.
    const text = `${"a".repeat(49)}\n${"b".repeat(150)}`
    expect(cutAfterLineBreak(text, 50, 60)).toBe(60)
    expect(cutAfterLineBreak(text, 50, 150)).toBe(150)
    // A piece asked for with no length is cut where it starts.
    expect(cutAfterLineBreak(text, 50, 50)).toBe(50)
    expect(cutAfterLineBreak(text, 0, 0)).toBe(0)
    // A piece that starts with a line break keeps more than that one character when the break is outside its last quarter.
    expect(cutAfterLineBreak(`\n${"b".repeat(199)}`, 0, 100)).toBe(100)
    expect(cutAfterLineBreak(`\n${"b".repeat(199)}`, 0, 1)).toBe(1)
    // Asked for with no length, it is cut at its start too: the line break it starts with is not before the cut.
    expect(cutAfterLineBreak(`\n${"b".repeat(199)}`, 0, 0)).toBe(0)
    expect(cutAfterLineBreak(`${"a".repeat(50)}\n${"b".repeat(149)}`, 50, 50)).toBe(50)
  })

  test("cutting again at a position the rule chose returns that position", () => {
    // A seeded generator: the same texts every run.
    const seeded = (seed: number) => () => {
      let state = (seed = (seed + 0x6d2b79f5) | 0)
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state
      return ((state ^ (state >>> 14)) >>> 0) / 4294967296
    }
    const next = seeded(7)
    const pick = (low: number, high: number) => low + Math.floor(next() * (high - low + 1))
    const moved: Array<{ readonly from: number; readonly at: number; readonly first: number; readonly again: number }> = []
    let lineCuts = 0
    let characterCuts = 0
    for (let round = 0; round < 400; round++) {
      // Lines of 1 to 60 units, some holding a pair, and now and then a line longer than any quarter asked for.
      const text = Array.from({ length: pick(1, 30) }, () => pick(1, 8) === 1 ? "w".repeat(pick(200, 400)) : `${"k".repeat(pick(0, 30))}${pick(1, 4) === 1 ? face : ""}${"v".repeat(pick(0, 28))}`).join(pick(1, 5) === 1 ? "\r\n" : "\n")
      const from = pick(0, Math.max(0, text.length - 1))
      const at = from + pick(0, 300)
      const first = cutAfterLineBreak(text, from, at)
      const again = cutAfterLineBreak(text, from, first)
      if (again !== first) moved.push({ from, at, first, again })
      if (first < text.length && first > 0 && text.charAt(first - 1) === "\n" && first < at) lineCuts++
      if (first < text.length && first > 0 && text.charAt(first - 1) !== "\n") characterCuts++
      // Whatever it chose is a whole number of characters within the piece asked for.
      expect(first).toBeLessThanOrEqual(Math.max(from, Math.min(at, text.length)))
      expect(wellFormed(text.slice(0, first))).toBe(true)
    }
    expect(moved).toEqual([])
    // Both kinds of cut were chosen: the property is not held by one of them alone.
    expect(lineCuts).toBeGreaterThan(50)
    expect(characterCuts).toBeGreaterThan(50)
  })
})

const ROW = 37
/** `chars` characters of rows of exactly `ROW` characters, each starting with its identifier. */
const table = (chars: number, name = "ledger"): string =>
  Array.from({ length: Math.ceil(chars / ROW) }, (_, index) => `${`R-${String(index).padStart(5, "0")} ${name} entry `.padEnd(ROW - 1, ".")}\n`).join("").slice(0, chars)
/** The end of the last whole row at or before `limit`, in a table that starts at 0. */
const rowEnd = (limit: number): number => Math.floor(limit / ROW) * ROW

const stored = (seq: number, turn: number, view: string): LogEntry => ({
  id: entryId(RunId.make(`run-${turn}`), seq), runId: RunId.make(`run-${turn}`), turn, step: 0, at: seq,
  body: { _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false },
})

/** The same result as a session holds it under `locator`. */
const heldAs = (locator: string, view: string): LogEntry => ({ ...stored(2, 1, view), id: EntryId.make(locator) })

/** The notice a bounded or spilled result ends with, for a head of `chars` characters. */
const preview = (text: string, locator: string, chars: number): string =>
  `${text.slice(0, chars)}\n[… ${text.length - chars} more characters kept out of context; call recall_context with locator "${locator}" and offset ${chars} to read them]`
/** A page from `from` to `to`, with unread text right after it. */
const pageTo = (text: string, locator: string, from: number, to: number): string => to >= text.length ? text.slice(from)
  : `${text.slice(from, to)}\n[… ${text.length - to} more characters; call recall_context with locator "${locator}" and offset ${to}]`

describe("a preview cut at a line break", () => {
  const held = stored(2, 1, table(4_000))

  test("with cutAtLineBreaks the preview ends after the last whole row within the limit, and its count and its offset are that cut's", () => {
    const view = table(4_000)
    // 600 is 8 characters into the seventeenth row: the head is sixteen rows, 592 characters.
    expect(rowEnd(600)).toBe(592)
    expect(spillPreview(held, view, 600, { cutAtLineBreaks: true })).toBe(`${view.slice(0, 592)}\n[… 3408 more characters kept out of context; call recall_context with locator "run-1:2" and offset 592 to read them]`)
    expect(view.slice(0, 592).endsWith("........\n")).toBe(true)
    // A limit a row ends at exactly gives nothing up.
    expect(spillPreview(held, view, 592, { cutAtLineBreaks: true })).toBe(preview(view, "run-1:2", 592))
    // A text with no line break near the limit is cut at the limit, as without the option.
    expect(spillPreview(held, "x".repeat(4_000), 600, { cutAtLineBreaks: true })).toBe(preview("x".repeat(4_000), "run-1:2", 600))
  })

  test("without the option, or with it off, the same view is cut at the character limit, inside a row", () => {
    const view = table(4_000)
    expect(spillPreview(held, view, 600)).toBe(preview(view, "run-1:2", 600))
    expect(spillPreview(held, view, 600, {})).toBe(preview(view, "run-1:2", 600))
    expect(spillPreview(held, view, 600, { cutAtLineBreaks: false })).toBe(preview(view, "run-1:2", 600))
    expect(view.slice(592, 600)).toBe("R-00016 ")
  })
})

describe("recall_context pages cut at line breaks", () => {
  const offsetIn = (text: string): number => Number(/ and offset (\d+)(?: to read them)?\]$/.exec(text)?.[1])
  const bodyOf = (served: string): string => served.endsWith("]") && served.includes("\n[… ") ? served.slice(0, served.lastIndexOf("\n[… ")) : served
  // The result held is an earlier turn's (the run is in turn 2): its pages are served whatever that turn showed of it.
  const recalledFrom = (held: LogEntry, options?: { readonly cutAtLineBreaks?: boolean }) => (params: { readonly locator: string; readonly offset?: number }) =>
    Effect.runPromise(Effect.result((recallCapabilityOf("example/recall", options).tools[0]!).handler(params).pipe(
      Effect.provideService(RunContext, RunContext.of({ memory: {
        turn: Effect.succeed(2), entries: Effect.succeed([held]),
        resolve: (id: string) => Effect.succeed(Option.some(held).pipe(Option.filter((entry) => entry.id === id))),
      } } as never)),
    ))).then((answered) => answered._tag === "Success" ? String(answered.success) : "refused")

  test("an earlier turn's result comes back in pages that each end after a whole row, and the pages join to the whole view", async () => {
    const view = table(30_000)
    const read = recalledFrom(stored(2, 1, view), { cutAtLineBreaks: true })
    const first = await read({ locator: "run-1:2" })
    // 8,000 is 8 characters into a row: the page is 216 rows, 7,992 characters, and names that offset.
    expect(rowEnd(8_000)).toBe(7_992)
    expect(first).toBe(`${view.slice(0, 7_992)}\n[… 22008 more characters; call recall_context with locator "run-1:2" and offset 7992]`)
    const pages = [first]
    while (Number.isFinite(offsetIn(pages.at(-1) ?? "")) && pages.length < 20) pages.push(await read({ locator: "run-1:2", offset: offsetIn(pages.at(-1) ?? "") }))
    expect(pages.map((page) => bodyOf(page).length)).toEqual([7_992, 7_992, 7_992, 30_000 - 3 * 7_992])
    expect(pages.slice(0, -1).every((page) => bodyOf(page).endsWith("\n"))).toBe(true)
    expect(pages.map(bodyOf).join("")).toBe(view)
    // The pages of an earlier turn's result are served as often as asked, the same each time.
    expect(await read({ locator: "run-1:2" })).toBe(first)
  })

  test("a page asked for from inside a row ends after a whole row all the same, and one that ends the result has no last line", async () => {
    const view = table(30_000)
    const read = recalledFrom(stored(2, 1, view), { cutAtLineBreaks: true })
    // From 20,000, the limit is 28,000: the last row end before it is 27,972.
    expect(rowEnd(28_000)).toBe(27_972)
    expect(await read({ locator: "run-1:2", offset: 20_000 })).toBe(pageTo(view, "run-1:2", 20_000, 27_972))
    expect(await read({ locator: "run-1:2", offset: 27_972 })).toBe(view.slice(27_972))
  })

  test("a result with no line break near a page's end is paged at the character limit", async () => {
    const view = "x".repeat(20_000)
    const read = recalledFrom(stored(2, 1, view), { cutAtLineBreaks: true })
    expect(await read({ locator: "run-1:2" })).toBe(pageTo(view, "run-1:2", 0, RECALL_PAGE_CHARS))
  })

  test("a capability built without the option, or with it off, pages the same view at the character limit", async () => {
    const view = table(30_000)
    expect(await recalledFrom(stored(2, 1, view))({ locator: "run-1:2" })).toBe(pageTo(view, "run-1:2", 0, RECALL_PAGE_CHARS))
    expect(await recalledFrom(stored(2, 1, view), {})({ locator: "run-1:2" })).toBe(pageTo(view, "run-1:2", 0, RECALL_PAGE_CHARS))
    expect(await recalledFrom(stored(2, 1, view), { cutAtLineBreaks: false })({ locator: "run-1:2" })).toBe(pageTo(view, "run-1:2", 0, RECALL_PAGE_CHARS))
  })

  test("the capability is the same but for where its pages are cut: its id, version, tool and description", () => {
    const [plain, cutting] = [recallCapabilityOf("example/recall"), recallCapabilityOf("example/recall", { cutAtLineBreaks: true })]
    const shape = (capability: typeof plain) => ({
      id: capability.id, version: capability.version, skills: capability.skills, promptSections: capability.promptSections,
      tools: capability.tools.map((registered) => ({ name: registered.tool.name, description: registered.tool.description, annotations: registered.annotations, requires: registered.requires })),
    })
    expect(shape(cutting)).toEqual(shape(plain))
    expect(cutting.tools.map((registered) => registered.tool.name)).toEqual([RECALL_TOOL])
  })
})

/*
 * The guard, in the turn that wrote the result, as the step loop makes each
 * call: the call is recorded, the handler runs with the run's memory, and its
 * answer is recorded before the next call. `cutting` says whether the session's
 * policy and its recall tool cut at line breaks; a call can be made with the
 * other tool, as when a host turns the option on or off between two calls.
 */
describe("the guard over previews and pages cut at line breaks", () => {
  const BOUND = 16_000
  const RUN = RunId.make("run-1")
  const views: ToolViews = {
    view: (_tool, encoded) => Effect.succeed({ text: typeof encoded === "string" ? encoded : canonicalJson(encoded), version: "raw", subjects: [], artifacts: [], pinned: false }),
    compact: () => Effect.succeed(Option.none()),
    digest: () => Effect.succeed(Option.none()),
  }
  const policyOf = (cutting: boolean): MemoryPolicy => ({
    strategy: { id: "test", version: "1" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
    digestOnWrite: Option.none(), boundOnWriteChars: BOUND,
    ...(cutting ? { cutAtLineBreaks: true } : {}),
    maintain: () => Effect.succeed(noMaintenance),
  })
  const headShown = { error: "ResultShown", message: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none." }
  const pageRead = (next: number) => ({ error: "AlreadyRecalled", message: `The text from that offset is in a page you already read, shown above. To read on, pass offset ${next}.` })
  const lastPageRead = { error: "AlreadyRecalled", message: "The text from that offset is in a page you already read, shown above. That page ends the result." }
  const bodyOf = (served: string): string => served.endsWith("]") && served.includes("\n[… ") ? served.slice(0, served.lastIndexOf("\n[… ")) : served
  /** The offset a served page or a notice names to read on from. */
  const offsetIn = (text: unknown): Option.Option<number> => Option.map(Option.fromNullishOr(/ and offset (\d+)(?: to read them)?\]$/.exec(typeof text === "string" ? text : "")?.[1]), Number)

  type Params = { readonly locator: string; readonly offset?: number }
  interface Turn {
    readonly begin: (text: string) => Effect.Effect<void, unknown>
    /** A `lookup` call and its result: the result's locator. */
    readonly returned: (text: string) => Effect.Effect<string, unknown>
    /** What the tool answers a call now, nothing recorded. `cut` picks the tool: the session's own when it is left out. */
    readonly answer: (params: Params, cut?: boolean) => Effect.Effect<unknown, unknown>
    /** A `recall_context` call, recorded with its answer: its page, or the failure it returned. */
    readonly ask: (params: Params, cut?: boolean) => Effect.Effect<unknown, unknown>
    /** One of the strategy's own compactions, recorded as `maintain` records a decision. */
    readonly compacted: (action: CompactionAction) => Effect.Effect<void, unknown>
    /** What the next request shows for each tool result, in order. */
    readonly shown: Effect.Effect<ReadonlyArray<string>, unknown>
  }

  const inSession = <A>(cutting: boolean, body: (turn: Turn) => Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(Effect.gen(function* () {
    const recallWith = (cut: boolean) => recallCapabilityOf("example/recall", cut ? { cutAtLineBreaks: true } : undefined).tools[0]!
    const strategy = policyOf(cutting)
    const kept = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(kept), append: (entries) => Ref.update(kept, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, strategy, { runId: RUN })
    const steps = yield* Ref.make(0)
    const run = RunOrdinal.make(0)
    const exchange = (toolName: string, input: unknown, answer: Effect.Effect<{ readonly output: unknown; readonly isError: boolean }, unknown>) => Effect.gen(function* () {
      const step = yield* Ref.updateAndGet(steps, (count) => count + 1)
      const toolCallId = ToolCallId.make(`c${step}`)
      yield* session.recordTail([{ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] }], views, step, run)
      const { output, isError } = yield* answer
      const recorded = yield* session.recordTail([{ role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output, isError }] }], views, step, run)
      return { answer: output, locator: String(recorded[0]?.id) }
    })
    const record = (body: LogBody) => session.record([body], 0).pipe(Effect.asVoid)
    const answered = (params: Params, cut = cutting) => Effect.gen(function* () {
      const reply = yield* Effect.result(recallWith(cut).handler(params).pipe(
        Effect.provideService(RunContext, RunContext.of({ memory: readerOf(session) } as never)),
        Effect.provideService(CurrentAgentRun, Option.some({ id: RUN, turn: yield* session.turn, ordinal: run })),
      ))
      return reply._tag === "Success" ? { output: reply.success as unknown, isError: false } : { output: reply.failure as unknown, isError: true }
    })
    return yield* body({
      begin: (text) => record({ _tag: "TurnStarted", userMessage: new UserMessage({ text }) }),
      returned: (text) => exchange("lookup", {}, Effect.succeed({ output: text, isError: false })).pipe(Effect.map((made) => made.locator)),
      answer: (params, cut) => answered(params, cut).pipe(Effect.map((made) => made.output)),
      ask: (params, cut) => exchange(RECALL_TOOL, params, answered(params, cut)).pipe(Effect.map((made) => made.answer)),
      compacted: (action) => record({ _tag: "Compaction", strategy: strategy.strategy.id, version: strategy.strategy.version, action }),
      shown: session.build({ stepContext: "none", run }).pipe(Effect.map((built) => built.messages.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.output)) : []))),
    })
  }))

  /** Follow each reply's offset from `from` until a page names none: every page served, in order. */
  const readOn = (turn: Turn, locator: string, from: number): Effect.Effect<ReadonlyArray<string>, unknown> => Effect.gen(function* () {
    const pages: Array<string> = []
    let offset = Option.some(from)
    while (Option.isSome(offset) && pages.length < 40) {
      const reply = yield* turn.ask({ locator, offset: offset.value })
      if (typeof reply !== "string") break
      pages.push(reply)
      offset = offsetIn(reply)
    }
    return pages
  })

  test("a bounded head ends after its last whole row and its notice names that offset; an offset inside the head is refused, and the notice's offset is served", async () => {
    const text = table(40_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      const shown = yield* turn.shown
      // The head's first character, its last one, and the offset its notice prints.
      return { locator, shown, start: yield* turn.ask({ locator }), last: yield* turn.ask({ locator, offset: 15_983 }), next: yield* turn.ask({ locator, offset: 15_984 }) }
    }))
    // 16,000 is 16 characters into a row: the head is 432 rows, 15,984 characters.
    expect(rowEnd(BOUND)).toBe(15_984)
    expect(seen.shown).toEqual([`${text.slice(0, 15_984)}\n[… 24016 more characters kept out of context; call recall_context with locator "${seen.locator}" and offset 15984 to read them]`])
    expect(text.slice(0, 15_984).endsWith("\n")).toBe(true)
    expect(seen.start).toEqual(headShown)
    expect(seen.last).toEqual(headShown)
    // The page from the notice's offset ends after a whole row too: 15,984 + 8,000 is 8 characters into one.
    expect(rowEnd(15_984 + RECALL_PAGE_CHARS)).toBe(23_976)
    expect(seen.next).toBe(`${text.slice(15_984, 23_976)}\n[… 16024 more characters; call recall_context with locator "${seen.locator}" and offset 23976]`)
  })

  test("the pages read on from a bounded head each end after a whole row, and join with the head to the whole view", async () => {
    const text = table(60_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      const [head] = yield* turn.shown
      const pages = yield* readOn(turn, locator, Option.getOrElse(offsetIn(head), () => -1))
      return { locator, head: head ?? "", pages }
    }))
    expect(seen.pages.length).toBe(6)
    // Every page but the last ends with a line break, holds whole rows only and is shorter than the character limit.
    expect(seen.pages.slice(0, -1).map((page) => ({ rows: bodyOf(page).length % ROW, short: bodyOf(page).length < RECALL_PAGE_CHARS, ended: bodyOf(page).endsWith("\n") })))
      .toEqual(seen.pages.slice(0, -1).map(() => ({ rows: 0, short: true, ended: true })))
    expect(`${bodyOf(seen.head)}${seen.pages.map(bodyOf).join("")}`).toBe(text)
    // No row is split between two of them: each starts with a row's identifier.
    expect(seen.pages.every((page) => /^R-\d{5} /.test(page))).toBe(true)
  })

  test("a page already read is refused with the offset its own last line names, from its start and from inside it", async () => {
    const text = table(60_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      const first = yield* turn.ask({ locator, offset: 15_984 })
      const again = yield* Effect.forEach([15_984, 15_985, 20_000, 23_975], (offset) => turn.ask({ locator, offset }), { concurrency: 1 })
      // The offset the page and its refusals name is unread text: a page of its own.
      const second = yield* turn.ask({ locator, offset: 23_976 })
      // With two pages read one after the other, an offset in the first is sent past the second.
      const chained = yield* turn.ask({ locator, offset: 16_000 })
      return { locator, first, again, second, chained }
    }))
    expect(offsetIn(seen.first)).toEqual(Option.some(23_976))
    expect(seen.again).toEqual([pageRead(23_976), pageRead(23_976), pageRead(23_976), pageRead(23_976)])
    expect(rowEnd(23_976 + RECALL_PAGE_CHARS)).toBe(31_968)
    expect(seen.second).toBe(pageTo(text, seen.locator, 23_976, 31_968))
    expect(seen.chained).toEqual(pageRead(31_968))
  })

  test("the last page read again is refused as the result's end, though it is shorter than a page", async () => {
    const text = table(30_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      const pages = yield* readOn(turn, locator, 15_984)
      return { locator, pages, again: yield* turn.ask({ locator, offset: 23_976 }), inside: yield* turn.ask({ locator, offset: 29_999 }), first: yield* turn.ask({ locator, offset: 16_000 }) }
    }))
    expect(seen.pages).toEqual([pageTo(text, seen.locator, 15_984, 23_976), text.slice(23_976)])
    expect(seen.again).toEqual(lastPageRead)
    expect(seen.inside).toEqual(lastPageRead)
    // An offset in the first page: the page after it holds the rest.
    expect(seen.first).toEqual({ error: "AlreadyRecalled", message: "The text from that offset to the result's end is in pages you already read, shown above." })
  })

  test("a page cut where a page already read starts ends there, inside a row, as without the option", async () => {
    const text = table(60_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      // The model read ahead first, from an offset inside a row.
      const ahead = yield* turn.ask({ locator, offset: 20_000 })
      // A whole page from the notice's offset would run to 23,976: it stops at 20,000, where the page already read starts.
      const before = yield* turn.ask({ locator, offset: 15_984 })
      return { locator, ahead, before, inside: yield* turn.ask({ locator, offset: 19_999 }), shown: yield* turn.shown }
    }))
    expect(seen.ahead).toBe(pageTo(text, seen.locator, 20_000, 27_972))
    expect(20_000 % ROW).not.toBe(0)
    expect(seen.before).toBe(`${text.slice(15_984, 20_000)}\n[… the next 7972 characters are in text you already read, shown above; 32028 more characters after them; call recall_context with locator "${seen.locator}" and offset 27972]`)
    // The cut page and the page it stops at follow on from one another: one reply for an offset in either, the offset the cut page's last line names.
    expect(seen.inside).toEqual(pageRead(27_972))
    // The request holds every character from 0 to 27,972 once.
    expect(`${bodyOf(seen.shown[0] ?? "")}${bodyOf(seen.shown[2] ?? "")}${bodyOf(seen.shown[1] ?? "")}`).toBe(text.slice(0, 27_972))
  })

  test("a preview recorded with a character cut is read back as a shown head when the option is on", async () => {
    const text = table(40_000)
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      // A spill recorded before the option was turned on, or by an earlier release: its head ends at the character limit, 8 characters into a row.
      // The rule applied to the offset it prints would give 592, so a check that cuts again at that offset reads no head back.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(locator), preview: preview(text, locator, 600) })
      const shown = yield* turn.shown
      return { locator, shown, start: yield* turn.ask({ locator }), last: yield* turn.ask({ locator, offset: 599 }), next: yield* turn.ask({ locator, offset: 600 }) }
    }))
    expect(cutAfterLineBreak(text, 0, 600)).toBe(592)
    expect(seen.shown).toEqual([preview(text, seen.locator, 600)])
    expect(seen.start).toEqual(headShown)
    expect(seen.last).toEqual(headShown)
    // The page from the head's end is cut as the session now cuts: after the last whole row before 8,600.
    expect(rowEnd(8_600)).toBe(8_584)
    expect(seen.next).toBe(pageTo(text, seen.locator, 600, 8_584))
  })

  test("a preview cut at a line break is read back as a shown head when the option is off", async () => {
    const text = table(40_000)
    const seen = await inSession(false, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      // What a session with the option on recorded: a head of sixteen whole rows.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(locator), preview: spillPreview(heldAs(locator, text), text, 600, { cutAtLineBreaks: true }) })
      const shown = yield* turn.shown
      return { locator, shown, last: yield* turn.ask({ locator, offset: 591 }), next: yield* turn.ask({ locator, offset: 592 }) }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, 592)])
    expect(seen.last).toEqual(headShown)
    // With the option off the page is 8,000 characters from there.
    expect(seen.next).toBe(pageTo(text, seen.locator, 592, 8_592))
  })

  test("a preview whose head is not the view's start, or whose offset is inside a surrogate pair, is still no shown head", async () => {
    const text = `${"a".repeat(599)}${face}\n${table(30_000)}`
    const seen = await inSession(true, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const altered = yield* turn.returned(text)
      const split = yield* turn.returned(text)
      // Core's notice over a head that is not the view's.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(altered), preview: preview(`${"z".repeat(600)}${text.slice(600)}`, altered, 600) })
      // A head that ends between the two units of a pair: no cut of core's falls there.
      yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(split), preview: preview(text, split, 600) })
      return { locators: { altered, split }, shown: yield* turn.shown, altered: yield* turn.answer({ locator: altered }), split: yield* turn.answer({ locator: split }) }
    }))
    expect(seen.shown[1]).toBe(preview(text, seen.locators.split, 600))
    expect(wellFormed(text.slice(0, 600))).toBe(false)
    // Neither says how much of the view it shows, so each is served from its start: a page that ends after a whole row.
    const end = 602 + rowEnd(RECALL_PAGE_CHARS - 602)
    expect(seen.altered).toBe(pageTo(text, seen.locators.altered, 0, end))
    expect(seen.split).toBe(pageTo(text, seen.locators.split, 0, end))
  })

  test.each([
    { started: "on", cutting: true, head: 15_984, ends: [23_984, 31_968, 39_968, 47_952, 55_952, 63_936] },
    { started: "off", cutting: false, head: 16_000, ends: [23_976, 31_976, 39_960, 47_960, 55_944, 63_944] },
  ])("pages read under one rule and then the other in one turn serve no character twice and skip none (the option $started when the result was written)", async ({ cutting, head, ends }) => {
    const text = table(70_000)
    const seen = await inSession(cutting, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      const [shown] = yield* turn.shown
      // The host turns the option on or off between two calls: each page is cut by the rule of the call that served it, and read on from the offset it names.
      const pages: Array<string> = []
      for (let call = 0, offset = offsetIn(shown); Option.isSome(offset) && call < 40; call++) {
        const reply = yield* turn.ask({ locator, offset: offset.value }, call % 2 === 0 ? !cutting : cutting)
        if (typeof reply !== "string") break
        pages.push(reply)
        offset = offsetIn(reply)
      }
      // Every page is read back whichever rule the asking call runs under: an offset inside the first one is told that the rest is read.
      const again = yield* Effect.forEach([true, false], (cut) => turn.answer({ locator, offset: head + 100 }, cut), { concurrency: 1 })
      return { shown: shown ?? "", pages, again }
    }))
    expect(bodyOf(seen.shown).length).toBe(head)
    // Where each page ended: 8,000 characters on under the character rule, after the last whole row within that under the other.
    expect(seen.pages.slice(0, -1).map((page) => Option.getOrElse(offsetIn(page), () => -1))).toEqual([...ends])
    expect(ends.map((end) => end % ROW === 0)).toEqual(cutting ? [false, true, false, true, false, true] : [true, false, true, false, true, false])
    expect(`${bodyOf(seen.shown)}${seen.pages.map(bodyOf).join("")}`).toBe(text)
    const readToEnd = { error: "AlreadyRecalled", message: "The text from that offset to the result's end is in pages you already read, shown above." }
    expect(seen.again).toEqual([readToEnd, readToEnd])
  })

  test("without the option the same result is bounded and paged at the character limits, inside rows", async () => {
    const text = table(40_000)
    const seen = await inSession(false, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the ledger")
      const locator = yield* turn.returned(text)
      return { locator, shown: yield* turn.shown, next: yield* turn.ask({ locator, offset: BOUND }) }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND)])
    expect(seen.next).toBe(pageTo(text, seen.locator, BOUND, BOUND + RECALL_PAGE_CHARS))
    expect([BOUND % ROW, (BOUND + RECALL_PAGE_CHARS) % ROW]).toEqual([16, 24])
  })

  describe("a row that starts with an identifier", () => {
    const ID = 20
    /** A row of `total` characters: its identifier, a space, text, a line break. */
    const rowOf = (index: number, total: number): string => `ID-${String(index).padStart(6, "0")}-${((index * 2_654_435_761) >>> 0).toString(16).padStart(8, "0")}-x ${"w".repeat(total - ID - 2)}\n`
    // Short rows up to 15,990, so the row that follows starts there and the bound's character limit falls 10 characters into its identifier.
    const short = [61, 23, 140, 37, 96, 29, 211, 48, 75, 33, 118, 52]
    const lead: Array<number> = []
    while (lead.reduce((sum, width) => sum + width, 0) + 400 < 15_990) lead.push(short[lead.length % short.length] ?? 61)
    lead.push(15_990 - lead.reduce((sum, width) => sum + width, 0))
    // Then rows of every size: shorter than a quarter of a page, longer than one (2,000), longer than a quarter of the bound (4,000), longer than a page.
    const mixed = [44, 2_600, 31, 9_500, 88, 57, 4_300, 120, 26, 8_050, 39, 2_050, 71, 12_400, 35, 160, 3_100, 49, 66, 1_990, 93, 6_500, 28, 410, 17_000, 58, 77]
    const widths = [...lead, ...mixed, ...mixed.map((width) => width + 7)]
    const text = widths.map((width, index) => rowOf(index, width)).join("")
    /** Where each row's identifier starts and ends. */
    const identifiers = widths.reduce<ReadonlyArray<{ readonly from: number; readonly to: number }>>((spans, width) => {
      const from = (spans.at(-1)?.from ?? 0) + (spans.length === 0 ? 0 : widths[spans.length - 1] ?? 0)
      return [...spans, { from, to: from + ID }]
    }, [])
    /** The cuts that fall inside an identifier: after its first character and before its last. */
    const splitting = (cuts: ReadonlyArray<number>): ReadonlyArray<number> => cuts.filter((cut) => identifiers.some((span) => span.from < cut && cut < span.to))
    /** Read the result as a model does: its bounded head, then every page from the offset each reply names. Where each piece ended. */
    const cutsOf = (cutting: boolean) => inSession(cutting, (turn) => Effect.gen(function* () {
      yield* turn.begin("read the table")
      const locator = yield* turn.returned(text)
      const [head] = yield* turn.shown
      const pages = yield* readOn(turn, locator, Option.getOrElse(offsetIn(head), () => -1))
      const pieces = [bodyOf(head ?? ""), ...pages.map(bodyOf)]
      const ends = pieces.reduce<ReadonlyArray<number>>((all, piece) => [...all, (all.at(-1) ?? 0) + piece.length], [])
      // And where the preview of a spill under pressure would end, at 600 characters.
      return { joined: pieces.join(""), ends, pressure: Option.getOrElse(offsetIn(spillPreview(heldAs(locator, text), text, 600, cutting ? { cutAtLineBreaks: true } : undefined)), () => -1) }
    }))

    test("is never split inside its identifier, whether its row is shorter than a quarter of the piece or longer than a page", async () => {
      expect(identifiers.every((span) => /^ID-\d{6}-[0-9a-f]{8}-x$/.test(text.slice(span.from, span.to)))).toBe(true)
      expect(identifiers.some((span) => span.from === 15_990)).toBe(true)
      const read = await cutsOf(true)
      expect(read.joined).toBe(text)
      const cuts = read.ends.slice(0, -1)
      expect(splitting([...cuts, read.pressure])).toEqual([])
      // The head gives up the ten characters of the identifier the limit fell in, and ends after the row before it.
      expect(cuts[0]).toBe(15_990)
      // Cuts of both kinds were made: after a whole row, short of the limit; and inside a long row's text, where the last quarter of the piece held no line break.
      const starts = [0, ...cuts]
      const kinds = cuts.map((cut, index) => {
        const from = starts[index] ?? 0
        const limit = index === 0 ? BOUND : RECALL_PAGE_CHARS
        return text.charAt(cut - 1) === "\n" ? { after: "row" as const, short: from + limit - cut } : { after: "text" as const, short: from + limit - cut, breaks: text.slice(cut - limit / 4, cut).includes("\n") }
      })
      expect(kinds.filter((kind) => kind.after === "row" && kind.short > 0).length).toBeGreaterThan(3)
      expect(kinds.filter((kind) => kind.after === "text").length).toBeGreaterThan(3)
      // A cut inside a row's text is at the character limit, and nothing is given up for it.
      expect(kinds.filter((kind) => kind.after === "text" && (kind.short !== 0 || kind.breaks))).toEqual([])
      // No piece gives up more than a quarter of what was asked for.
      expect(kinds.filter((kind, index) => kind.short > (index === 0 ? BOUND : RECALL_PAGE_CHARS) / 4)).toEqual([])
    })

    test("is split inside its identifier by the character cuts, without the option: the same result, the same reads", async () => {
      const read = await cutsOf(false)
      expect(read.joined).toBe(text)
      // The bound's limit falls ten characters into an identifier, and the model is shown half of it in each of two results.
      expect(read.ends[0]).toBe(BOUND)
      expect(splitting(read.ends.slice(0, -1))).toContain(BOUND)
    })
  })

  test("whatever order a model asks in, pages cut at line breaks serve no character twice, leave none unread, and end after a line break wherever the last quarter holds one", async () => {
    // A seeded generator: the same sequences every run.
    const seeded = (seed: number) => () => {
      let state = (seed = (seed + 0x6d2b79f5) | 0)
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state
      return ((state ^ (state >>> 14)) >>> 0) / 4294967296
    }
    /** The offset a served page or a refusal names to read on from; none when it names none. */
    const namedBy = (reply: unknown): Option.Option<number> => typeof reply === "string"
      ? Option.map(Option.fromNullishOr(/ and offset (\d+)\]$/.exec(reply)?.[1]), Number)
      : Option.map(Option.fromNullishOr(/To read on, pass offset (\d+)\.$/.exec(Schema.is(Failure)(reply) ? reply.message : "")?.[1]), Number)
    /** Whether a served page's last line is the plain one: unread text follows it, so its end is the tool's own cut, not the start of a page already read. */
    const endsPlain = (reply: string): boolean => / more characters; call recall_context with locator "[^"]*" and offset \d+\]$/.test(reply) && !reply.includes("characters are in text you already read")
    const outcomes = await Effect.runPromise(Effect.forEach(Array.from({ length: 40 }, (_, index) => index + 1), (seed) => Effect.promise(() => inSession(true, (turn) => Effect.gen(function* () {
      const next = seeded(seed)
      const pick = (low: number, high: number) => low + Math.floor(next() * (high - low + 1))
      // Lines of many lengths: most far shorter than a quarter of a page, some longer than one, a few longer than a page; some hold a pair, none a bracket.
      const length = pick(1, 10) === 1 ? pick(1, 9_000) : pick(17_000, 70_000)
      const line = (index: number): string => {
        const kind = pick(1, 120)
        const words = kind === 1 ? "w".repeat(pick(8_100, 9_500)) : kind <= 5 ? "v".repeat(pick(2_001, 3_000)) : "u".repeat(pick(0, 90))
        return `row ${String(index).padStart(5, "0")} ${pick(1, 6) === 1 ? `${face} ` : ""}${words}${pick(1, 12) === 1 ? "\r" : ""}\n`
      }
      const lines: Array<string> = []
      for (let total = 0, index = 0; total < length; index++) { const made = line(index); lines.push(made); total += made.length }
      const text = lines.join("")
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      /** The first unit of the pair an offset falls inside, else the offset: where the tool starts a page. */
      const startOf = (offset: number): number => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) ? offset - 1 : offset
      const served: Array<{ readonly from: number; readonly body: string; readonly plain: boolean }> = []
      const ask = (offset: number) => turn.ask({ locator, offset }).pipe(Effect.tap((reply) => Effect.sync(() => {
        if (typeof reply === "string") served.push({ from: startOf(offset), body: bodyOf(reply), plain: endsPlain(reply) })
      })))
      // Any order: anywhere in the text, just below or inside a page already served, at a page's edges.
      const spillAt = pick(1, 3) === 1 ? pick(0, 14) : -1
      for (let step = 0; step < 16; step++) {
        // Under pressure the result is spilled again: by this session, at a line break, or as a session without the option wrote it, at the character limit.
        if (step === spillAt && text.length > 2_000) yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(locator), preview: pick(1, 2) === 1 ? spillPreview(heldAs(locator, text), text, 600, { cutAtLineBreaks: true }) : preview(text, locator, startOf(600)) })
        const last = served.at(-1)
        const offset = last === undefined || pick(1, 3) === 1 ? pick(0, text.length - 1)
          : Math.min(text.length - 1, Math.max(0, pick(1, 2) === 1 ? last.from - pick(1, 9_000) : last.from + pick(-2, last.body.length + 2)))
        yield* ask(offset)
      }
      // Then a model that follows every reply, from the result's start.
      const shownNow = (yield* turn.shown)[0] ?? ""
      const head = shownNow === text ? text.length : Number(/ and offset (\d+) to read them\]$/.exec(shownNow)?.[1])
      const walk = (offset: number, steps: number, named: boolean, refusedAfter: number): Effect.Effect<{ readonly steps: number; readonly refusedAfter: number }, unknown> => steps > 400 ? Effect.succeed({ steps, refusedAfter }) : ask(offset).pipe(
        Effect.flatMap((reply) => {
          const shownHead = Schema.is(Failure)(reply) && reply.error === "ResultShown"
          const chained = refusedAfter + (named && Schema.is(Failure)(reply) && reply.error === "AlreadyRecalled" ? 1 : 0)
          return Option.match(shownHead ? Option.filter(Option.some(head), (shown) => shown < text.length) : namedBy(reply), {
            onNone: () => Effect.succeed({ steps, refusedAfter: chained }), onSome: (to) => walk(to, steps + 1, !shownHead, chained),
          })
        }))
      const { steps, refusedAfter } = yield* walk(0, 0, false, 0)
      // What the request holds of the result: its shown start, and every page served.
      const held = new Uint8Array(text.length)
      held.fill(1, 0, head)
      const quarter = RECALL_PAGE_CHARS / 4
      const parts = served.map((part) => {
        const end = part.from + part.body.length
        const limit = startOf(Math.min(part.from + RECALL_PAGE_CHARS, text.length))
        const afterBreak = end > 0 && text.charAt(end - 1) === "\n"
        return {
          ...part, end, matches: text.slice(part.from, end) === part.body, whole: wellFormed(part.body), empty: part.body.length === 0 && text.length > 0,
          // The tool's own cut, short of the result's end: after the last line break before the limit when one is within a quarter of the page, else at the limit.
          offLine: part.plain && (afterBreak ? text.slice(end, limit).includes("\n") || limit - end > quarter : end !== limit || text.slice(Math.max(part.from, end - quarter - 1), end).includes("\n")),
          atLine: part.plain && afterBreak && end < limit, atLimit: part.plain && !afterBreak,
        }
      })
      for (const part of parts) for (let at = part.from; at < part.end; at++) held[at] = (held[at] ?? 0) + 1
      return {
        seed, steps, refusedAfter, pages: parts.length,
        wrongText: parts.filter((part) => !part.matches).length, halfCharacters: parts.filter((part) => !part.whole).length, emptyPages: parts.filter((part) => part.empty).length,
        offLine: parts.filter((part) => part.offLine).length, atLine: parts.filter((part) => part.atLine).length, atLimit: parts.filter((part) => part.atLimit).length,
        twice: held.reduce((count, times) => count + (times > 1 ? 1 : 0), 0), never: held.reduce((count, times) => count + (times === 0 ? 1 : 0), 0),
      }
    }))), { concurrency: 1 }))
    // Every page is the text at its offset, whole characters only, never empty; no character of a result is held twice, and none is left unread.
    expect(outcomes.filter((outcome) => outcome.wrongText + outcome.halfCharacters + outcome.emptyPages + outcome.twice + outcome.never > 0)).toEqual([])
    expect(outcomes.every((outcome) => outcome.steps <= 400)).toBe(true)
    // An offset a page's last line or an AlreadyRecalled reply names is unread text: following one never leads to a second refusal.
    expect(outcomes.filter((outcome) => outcome.refusedAfter > 0)).toEqual([])
    // Every page that the tool cut itself ends after the last line break within its last quarter, or at the character limit when that quarter holds none.
    expect(outcomes.filter((outcome) => outcome.offLine > 0)).toEqual([])
    // The sequences did read pages, and cut them both ways: the properties are not held by refusals or by one kind of cut alone.
    expect(outcomes.reduce((sum, outcome) => sum + outcome.pages, 0)).toBeGreaterThan(200)
    expect(outcomes.reduce((sum, outcome) => sum + outcome.atLine, 0)).toBeGreaterThan(40)
    expect(outcomes.reduce((sum, outcome) => sum + outcome.atLimit, 0)).toBeGreaterThan(15)
  }, 60_000)
})
