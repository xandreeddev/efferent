import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Result, Schema } from "effect"
import { Failure } from "../domain/failure.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { CurrentAgentRun } from "../loop/stepContext.js"
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
    expect(recall.tool.description).toBe("Read on in a tool result that is shown shortened, by the locator its shortened form shows. Returns at most 8000 characters from offset (0 by default); when more remains, the reply ends with the offset to pass next. For a result of this turn, a call for text still shown above (an offset inside its shown part, or inside a page already read) can return no text: the reply then says where to read on, or that nothing is left.")
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
 * real one, so a refusal is checked against what its next request shows, and
 * against what a later request shows once memory has shortened the result
 * again.
 */
describe("recall_context in the turn that wrote the result", () => {
  const recall = recallCapabilityOf("example/recall").tools[0]!
  const BOUND = 16_000
  const RUN = RunId.make("run-1")
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
  // The four refusals, as the model reads them.
  const headShown = { error: "ResultShown", message: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none." }
  const shownInFull = { error: "ResultShown", message: "This result was shown in full when you asked: nothing of it was left out. If it is shown shortened now, pass the offset its shortened form shows, or offset 0 if it shows none." }
  const pageRead = (next: number) => ({ error: "AlreadyRecalled", message: `The text from that offset is in a page you already read, shown above. To read on, pass offset ${next}.` })
  const lastPageRead = { error: "AlreadyRecalled", message: "The text from that offset is in a page you already read, shown above. That page ends the result." }

  /**
   * The offset a model that follows a refusal passes next, reading it beside
   * what the result of `view` shows now: the offset the reply names; else,
   * when the reply sends it to the result's shortened form, the offset in
   * the notice that form shows, or 0 when it shows none. A reply that says
   * the result was shown in full sends it there only if the result is shown
   * shortened now. None when the reply gives nothing to pass.
   */
  const following = (reply: unknown, shownNow: string, view: string): Option.Option<number> => {
    const message = Schema.is(Failure)(reply) ? reply.message : ""
    const named = /To read on, pass offset (\d+)\.$/.exec(message)?.[1]
    if (named !== undefined) return Option.some(Number(named))
    if (!message.includes("its shortened form shows") || (message.includes("If it is shown shortened now") && shownNow === view)) return Option.none()
    return Option.orElse(Option.map(Option.fromNullishOr(/ and offset (\d+) to read them\]$/.exec(shownNow)?.[1]), Number), () => Option.some(0))
  }

  type Params = { readonly locator: string; readonly offset?: number }

  interface Turn {
    /** Start the next turn. */
    readonly begin: (text: string) => Effect.Effect<void, unknown>
    /** A `lookup` call and its result: the result's locator. Made by `run` when one is given, else by no run of a loop. */
    readonly returned: (text: string, run?: RunOrdinal) => Effect.Effect<string, unknown>
    /** What the tool answers a call now, nothing recorded: its page, or the failure it returned. The call is `run`'s when one is given. */
    readonly answer: (params: Params, run?: RunOrdinal) => Effect.Effect<{ readonly output: unknown; readonly isError: boolean }, unknown>
    /** A `recall_context` call: its page or the failure it returned, and the locator of that answer. */
    readonly asked: (params: Params, run?: RunOrdinal) => Effect.Effect<{ readonly answer: unknown; readonly locator: string }, unknown>
    /** A `recall_context` call: its page, or the failure it returned. */
    readonly ask: (params: Params, run?: RunOrdinal) => Effect.Effect<unknown, unknown>
    /** A response of `run` and the results of its calls that have returned; a call given no output is still running. */
    readonly responded: (run: RunOrdinal, calls: ReadonlyArray<{ readonly id: string; readonly toolName: string; readonly input: unknown; readonly output?: unknown }>) => Effect.Effect<void, unknown>
    /** One of the strategy's own compactions, recorded as `maintain` records a decision. */
    readonly compacted: (action: CompactionAction) => Effect.Effect<void, unknown>
    /** A digest of a result, recorded as the session records one. */
    readonly digested: (locator: string, text: string) => Effect.Effect<void, unknown>
    /** What the next request shows for each tool result, in order. */
    readonly shown: Effect.Effect<ReadonlyArray<string>, unknown>
    /** What the next request of `run` shows for each tool result, in order. */
    readonly shownTo: (run: RunOrdinal) => Effect.Effect<ReadonlyArray<string>, unknown>
  }

  const inSession = <A>(body: (turn: Turn) => Effect.Effect<A, unknown>, strategy: MemoryPolicy = policy): Promise<A> => Effect.runPromise(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, strategy, { runId: RUN })
    const steps = yield* Ref.make(0)
    const exchange = (toolName: string, input: unknown, answer: Effect.Effect<{ readonly output: unknown; readonly isError: boolean }, unknown>, run?: RunOrdinal) => Effect.gen(function* () {
      const step = yield* Ref.updateAndGet(steps, (count) => count + 1)
      const toolCallId = ToolCallId.make(`c${step}`)
      yield* session.recordTail([{ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] }], views, step, run)
      const { output, isError } = yield* answer
      const recorded = yield* session.recordTail([{ role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output, isError }] }], views, step, run)
      return { answer: output, locator: String(recorded[0]?.id) }
    })
    const record = (body: LogBody) => session.record([body], 0).pipe(Effect.asVoid)
    // The handler runs where the loop calls it: with the run's memory, and with the loop's run when the call is one's.
    const answer: Turn["answer"] = (params, run) => Effect.gen(function* () {
      const asking = run === undefined ? Option.none() : Option.some({ id: RUN, turn: yield* session.turn, ordinal: run })
      const answered = yield* Effect.result(recall.handler(params).pipe(
        Effect.provideService(RunContext, RunContext.of({ memory: readerOf(session) } as never)),
        Effect.provideService(CurrentAgentRun, asking),
      ))
      return answered._tag === "Success" ? { output: answered.success, isError: false } : { output: answered.failure, isError: true }
    })
    const asked: Turn["asked"] = (params, run) => exchange(RECALL_TOOL, params, answer(params, run), run)
    const shownTo: Turn["shownTo"] = (run) => session.build({ stepContext: "none", run }).pipe(Effect.map((built) => built.messages.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.output)) : [])))
    return yield* body({
      begin: (text) => record({ _tag: "TurnStarted", userMessage: new UserMessage({ text }) }),
      returned: (text, run) => exchange("lookup", {}, Effect.succeed({ output: text, isError: false }), run).pipe(Effect.map((made) => made.locator)),
      answer,
      asked,
      ask: (params, run) => asked(params, run).pipe(Effect.map((made) => made.answer)),
      responded: (run, calls) => Effect.gen(function* () {
        const step = yield* Ref.updateAndGet(steps, (count) => count + 1)
        yield* session.recordTail([{ role: "assistant", content: calls.map((call) => ({ type: "tool-call" as const, toolCallId: ToolCallId.make(call.id), toolName: call.toolName, input: call.input })) }], views, step, run)
        yield* Effect.forEach(calls.filter((call) => call.output !== undefined), (call) =>
          session.recordTail([{ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make(call.id), toolName: call.toolName, output: call.output, isError: false }] }], views, step, run), { concurrency: 1 })
      }),
      compacted: (action) => record({ _tag: "Compaction", strategy: strategy.strategy.id, version: strategy.strategy.version, action }),
      digested: (locator, text) => record({ _tag: "ToolDigest", entry: EntryId.make(locator), version: "1", mode: "summarize", keep: [], text, digester: "test@1", trigger: "compaction" }),
      shown: shownTo(RunOrdinal.make(0)),
      shownTo,
    })
  }))

  describe("text still shown is refused, and the reply says where to read on", () => {
    test("a bounded result is refused anywhere in its head, and the reply sends the model to the offset its shortened form shows", async () => {
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
      // The request shows the first 16,000 characters and the notice. The refusal holds no number of its own: it sends the model to the offset that shortened form shows.
      expect(seen.shown).toEqual([preview(text, seen.locator, BOUND)])
      expect(seen.start).toEqual({ error: "ResultShown", message: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none." })
      expect(seen.inside).toEqual(seen.start)
      // The offset that notice prints is served.
      expect(following(seen.start, seen.shown[0] ?? "", text)).toEqual(Option.some(BOUND))
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
      expect(seen.start).toEqual({ error: "ResultShown", message: "This result was shown in full when you asked: nothing of it was left out. If it is shown shortened now, pass the offset its shortened form shows, or offset 0 if it shows none." })
      expect(seen.last).toEqual(seen.start)
      // While the result is still whole it is not shown shortened, so the reply sends the model to no other call.
      expect(following(seen.start, seen.shown[0] ?? "", text)).toEqual(Option.none())
      // An offset past the end is still told the result's length.
      expect(seen.past).toEqual({ error: "OffsetOutOfRange", message: "The result has 2000 characters; pass an offset below 2000" })
    })
  })

  describe("a refusal read after memory shortened the result again", () => {
    test("after a spill under pressure, the offset the refusal sends the model to is the new notice's, and nothing between is skipped", async () => {
      const [short, long] = [lines(12_000, "short"), lines(40_000, "long")]
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read both records")
        const whole = yield* turn.returned(short)
        const bounded = yield* turn.returned(long)
        const refused = { whole: yield* turn.ask({ locator: whole, offset: 4_000 }), bounded: yield* turn.ask({ locator: bounded, offset: 4_000 }) }
        // Under pressure the strategy spills both to its shorter preview: the one shown whole, and the one bounded as it was written.
        yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(whole), preview: preview(short, whole, 600) })
        yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(bounded), preview: preview(long, bounded, 600) })
        const shown = yield* turn.shown
        // The model reads the same two refusals in the next request, and follows each.
        const next = { whole: following(refused.whole, shown[0] ?? "", short), bounded: following(refused.bounded, shown[1] ?? "", long) }
        const read = {
          whole: yield* turn.ask({ locator: whole, offset: Option.getOrElse(next.whole, () => -1) }),
          bounded: yield* turn.ask({ locator: bounded, offset: Option.getOrElse(next.bounded, () => -1) }),
        }
        return { whole, bounded, refused, shown, next, read }
      }))
      expect(seen.shown.slice(0, 2)).toEqual([preview(short, seen.whole, 600), preview(long, seen.bounded, 600)])
      // Each refusal leads to the first character the request no longer shows.
      expect(seen.next).toEqual({ whole: Option.some(600), bounded: Option.some(600) })
      expect(seen.read.whole).toBe(page(short, seen.whole, 600))
      expect(seen.read.bounded).toBe(page(long, seen.bounded, 600))
      expect(seen.refused).toEqual({ whole: shownInFull, bounded: headShown })
    })

    test("after a compact view took the result's place in a later turn, the refusal leads to the result's start", async () => {
      const [short, long] = [lines(12_000, "short"), lines(40_000, "long")]
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read both records")
        const whole = yield* turn.returned(short)
        const bounded = yield* turn.returned(long)
        const refused = { whole: yield* turn.ask({ locator: whole, offset: 4_000 }), bounded: yield* turn.ask({ locator: bounded }) }
        yield* turn.begin("and the rest?")
        // What the window strategy records at a turn's start, or under pressure with compactPreviousTurn off: the earlier results' compact views.
        yield* turn.compacted({ _tag: "CompactViews", entries: [EntryId.make(whole), EntryId.make(bounded)], texts: ["a record of 600 lines", "a record of 2,000 lines"] })
        const shown = yield* turn.shown
        const next = { whole: following(refused.whole, shown[0] ?? "", short), bounded: following(refused.bounded, shown[1] ?? "", long) }
        const read = {
          whole: yield* turn.ask({ locator: whole, offset: Option.getOrElse(next.whole, () => -1) }),
          bounded: yield* turn.ask({ locator: bounded, offset: Option.getOrElse(next.bounded, () => -1) }),
        }
        return { whole, bounded, refused, shown, next, read }
      }))
      // The later request shows each compact view, with no notice, and each refusal as it was written.
      expect(seen.shown).toEqual(["a record of 600 lines", "a record of 2,000 lines", canonicalJson(seen.refused.whole), canonicalJson(seen.refused.bounded)])
      // A shortened form that shows no offset: each refusal leads to the result's start.
      expect(seen.next).toEqual({ whole: Option.some(0), bounded: Option.some(0) })
      expect(seen.read.whole).toBe(page(short, seen.whole, 0))
      expect(seen.read.bounded).toBe(page(long, seen.bounded, 0))
      expect(seen.refused).toEqual({ whole: shownInFull, bounded: headShown })
    })

    test("the guard follows what is shown now: text a spill took out of the request is served", async () => {
      const [short, long] = [lines(12_000, "short"), lines(40_000, "long")]
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read both records")
        const whole = yield* turn.returned(short)
        const bounded = yield* turn.returned(long)
        yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(whole), preview: preview(short, whole, 600) })
        yield* turn.compacted({ _tag: "Spill", entry: EntryId.make(bounded), preview: preview(long, bounded, 600) })
        return {
          whole, bounded,
          head: { whole: yield* turn.ask({ locator: whole }), bounded: yield* turn.ask({ locator: bounded, offset: 599 }) },
          on: { whole: yield* turn.ask({ locator: whole, offset: 4_000 }), bounded: yield* turn.ask({ locator: bounded, offset: 4_000 }) },
        }
      }))
      expect(seen.head).toEqual({ whole: headShown, bounded: headShown })
      expect(seen.on.whole).toBe(page(short, seen.whole, 4_000))
      expect(seen.on.bounded).toBe(page(long, seen.bounded, 4_000))
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
    const refusal = { error: "AlreadyRecalled", message: "The text from that offset is in a page you already read, shown above. To read on, pass offset 24000." }
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
      // An offset inside that page is told the same.
      const inside = yield* turn.ask({ locator, offset: 29_999 })
      return { last, again, inside }
    }))
    expect(seen.last).toBe(text.slice(24_000))
    expect(seen.again).toEqual({ error: "AlreadyRecalled", message: "The text from that offset is in a page you already read, shown above. That page ends the result." })
    expect(seen.inside).toEqual(seen.again)
  })

  test("an offset inside a page already read is refused, with that page's end, whatever the offset", async () => {
    const text = lines(60_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const read = yield* turn.ask({ locator, offset: BOUND })
      // Each of these starts inside the page just read: all but one of its characters, half of them, its last one.
      const inside = yield* Effect.forEach([BOUND + 1, BOUND + 4_000, BOUND + RECALL_PAGE_CHARS - 1], (offset) => turn.ask({ locator, offset }), { concurrency: 1 })
      // The offset the refusal names is past the page: a page of its own.
      const next = yield* turn.ask({ locator, offset: BOUND + RECALL_PAGE_CHARS })
      return { locator, read, inside, next, shown: yield* turn.shown }
    }))
    expect(seen.read).toBe(page(text, seen.locator, BOUND))
    // One reply for every offset inside the page: it holds the page's end, nothing of the call.
    expect(seen.inside).toEqual([pageRead(24_000), pageRead(24_000), pageRead(24_000)])
    expect(seen.next).toBe(page(text, seen.locator, BOUND + RECALL_PAGE_CHARS))
    // The text from each refused offset to 24,000 is in the request: the page read first holds it.
    expect(seen.shown[1]).toContain(text.slice(BOUND + 1, 24_000))
  })

  test("of two pages already read that hold an offset, the reply names the end of the one that ends last", async () => {
    const text = lines(60_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      // The model read ahead first, then a page that starts before it and runs into it.
      const ahead = yield* turn.ask({ locator, offset: 20_000 })
      const before = yield* turn.ask({ locator, offset: BOUND })
      return {
        locator, ahead, before,
        // Inside both pages, inside the first one read only, inside the second only.
        both: yield* turn.ask({ locator, offset: 22_000 }), later: yield* turn.ask({ locator, offset: 26_000 }), earlier: yield* turn.ask({ locator, offset: 18_000 }),
      }
    }))
    expect(seen.ahead).toBe(page(text, seen.locator, 20_000))
    expect(seen.before).toBe(page(text, seen.locator, BOUND))
    expect(seen.both).toEqual(pageRead(28_000))
    expect(seen.later).toEqual(pageRead(28_000))
    expect(seen.earlier).toEqual(pageRead(24_000))
  })

  test("the next page, a page of another result and a page of an earlier turn are served", async () => {
    const [north, south] = [lines(40_000, "north"), lines(40_000, "south")]
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read both records")
      const first = yield* turn.returned(north)
      const other = yield* turn.returned(south)
      const second = yield* turn.ask({ locator: first, offset: BOUND })
      const third = yield* turn.ask({ locator: first, offset: BOUND + RECALL_PAGE_CHARS })
      // The same offsets of another result are that result's own pages.
      const others = yield* turn.ask({ locator: other, offset: BOUND + 1 })
      yield* turn.begin("and what follows?")
      // The result is now an earlier turn's: the guard is this turn's only, so every page of it is served, as often as asked.
      const head = yield* turn.ask({ locator: first })
      const earlier = yield* turn.ask({ locator: first, offset: BOUND })
      const repeated = yield* turn.ask({ locator: first, offset: BOUND + 1 })
      return { first, other, second, third, others, head, earlier, repeated }
    }))
    expect(seen.second).toBe(page(north, seen.first, BOUND))
    expect(seen.third).toBe(page(north, seen.first, BOUND + RECALL_PAGE_CHARS))
    expect(seen.others).toBe(page(south, seen.other, BOUND + 1))
    expect(seen.head).toBe(page(north, seen.first, 0))
    expect(seen.earlier).toBe(page(north, seen.first, BOUND))
    expect(seen.repeated).toBe(page(north, seen.first, BOUND + 1))
  })

  // Every other test here calls the tool with no run and records its results with none, as a call made outside a loop is: those pages count for it.
  describe("a page counts as read only for the run that read it", () => {
    const [first, second] = [RunOrdinal.make(0), RunOrdinal.make(1)]

    test("a page another run of the turn holds in an exchange still in flight is served, not called shown", async () => {
      const text = lines(40_000)
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read the record")
        const locator = yield* turn.returned(text, first)
        // The first run's response holds two calls: the page has returned, the other call is still running.
        yield* turn.responded(first, [
          { id: "page", toolName: RECALL_TOOL, input: { locator, offset: BOUND }, output: page(text, locator, BOUND) },
          { id: "slow", toolName: "lookup", input: {} },
        ])
        // A second run of the turn builds its request meanwhile: that exchange is left out of it.
        const shownToSecond = yield* turn.shownTo(second)
        const answered = yield* turn.answer({ locator, offset: BOUND }, second)
        // The run that read the page is refused it, as before.
        const own = yield* turn.answer({ locator, offset: BOUND }, first)
        return { locator, shownToSecond, answered, own }
      }))
      expect(seen.shownToSecond).toEqual([preview(text, seen.locator, BOUND)])
      expect(seen.answered).toEqual({ output: page(text, seen.locator, BOUND), isError: false })
      expect(seen.own).toEqual({ output: pageRead(24_000), isError: true })
    })

    test("a run is refused the pages it read itself; another run and a call made outside a loop are served them", async () => {
      const text = lines(40_000)
      const seen = await inSession((turn) => Effect.gen(function* () {
        yield* turn.begin("read the record")
        const locator = yield* turn.returned(text, first)
        const read = yield* turn.ask({ locator, offset: BOUND }, first)
        return {
          locator, read,
          own: yield* turn.answer({ locator, offset: BOUND + 1 }, first),
          // Another run, and a call made outside a loop, did not read that page: each is served it.
          other: yield* turn.answer({ locator, offset: BOUND }, second),
          direct: yield* turn.answer({ locator, offset: BOUND }),
          shownToSecond: yield* turn.shownTo(second),
        }
      }))
      expect(seen.read).toBe(page(text, seen.locator, BOUND))
      expect(seen.own).toEqual({ output: pageRead(24_000), isError: true })
      expect(seen.other).toEqual({ output: page(text, seen.locator, BOUND), isError: false })
      expect(seen.direct).toEqual({ output: page(text, seen.locator, BOUND), isError: false })
      // The first run's exchange is complete, so the second run's request shows that page: the guard serves it all the same. A known limit.
      expect(seen.shownToSecond).toEqual([preview(text, seen.locator, BOUND), page(text, seen.locator, BOUND)])
    })
  })

  test("a bound that falls inside a surrogate pair shows one unit less, and the page read from its notice starts there", async () => {
    const text = `${"a".repeat(BOUND - 1)}\u{1F600}${lines(20_000)}`
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      const shown = yield* turn.shown
      const start = yield* turn.ask({ locator })
      // One unit before the bound is still inside the head; the notice's offset is the first unit past it.
      const last = yield* turn.ask({ locator, offset: BOUND - 2 })
      const next = yield* turn.ask({ locator, offset: Option.getOrElse(following(start, shown[0] ?? "", text), () => -1) })
      // An offset inside the pair starts at the pair's first unit: the page just read.
      const inside = yield* turn.ask({ locator, offset: BOUND })
      return { locator, shown, start, last, next, inside }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND - 1)])
    expect(seen.start).toEqual(headShown)
    expect(seen.last).toEqual(headShown)
    expect(seen.next).toBe(page(text, seen.locator, BOUND - 1))
    expect(seen.inside).toEqual(pageRead(23_999))
  })

  test("a result shown through a compact view, a digest or a preview core did not write is served from its start", async () => {
    const names = ["compact", "digest", "own", "altered", "both"] as const
    const texts = names.map((name) => lines(2_000, name))
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the records")
      const [compact, digest, own, altered, both] = yield* Effect.forEach(texts, (text) => turn.returned(text), { concurrency: 1 })
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
    expect(seen.served).toEqual([texts[0], texts[1], texts[2], texts[3], headShown])
  })

  test("a result with a recorded digest is served under a policy that shows no digests, though the request shows it whole", async () => {
    const text = lines(2_000)
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned(text)
      yield* turn.digested(locator, "a digest")
      return { shown: yield* turn.shown, served: yield* turn.ask({ locator }) }
    }), { ...policy, render: { ...policy.render, digests: false } })
    // The reader names no strategy, so it cannot tell that this one shows the result and not its digest: it serves the page. A known limit.
    expect(seen.shown).toEqual([text])
    expect(seen.served).toBe(text)
  })

  test("an empty result's one page is read once", async () => {
    const seen = await inSession((turn) => Effect.gen(function* () {
      yield* turn.begin("read the record")
      const locator = yield* turn.returned("")
      return { first: yield* turn.ask({ locator }), again: yield* turn.ask({ locator }) }
    }))
    // The page starts and ends at 0: it holds its own start, and nothing past it.
    expect(seen.first).toBe("")
    expect(seen.again).toEqual(lastPageRead)
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
      return { locator, read, shown, again: yield* turn.ask({ locator, offset: BOUND }), inside: yield* turn.ask({ locator, offset: BOUND + 1 }) }
    }))
    expect(seen.shown).toEqual([preview(text, seen.locator, BOUND), preview(page(text, seen.locator, BOUND), seen.read.locator, 600)])
    expect(seen.again).toBe(page(text, seen.locator, BOUND))
    // The page just served again is whole in the request: an offset inside it is refused for that one.
    expect(seen.inside).toEqual(pageRead(24_000))
  })
})
