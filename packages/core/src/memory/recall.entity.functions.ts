import { Tool } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { Failure } from "../domain/failure.entity.js"
import type { RunRef } from "../domain/run.entity.js"
import { defineCapability, defineSkill, defineTool } from "../harness/capability.entity.functions.js"
import { CurrentAgentRun } from "../loop/stepContext.js"
import type { Capability } from "../ports/capability.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { presentedEntries, shownViewsOf, toolInputsByResult } from "./memory-log.entity.functions.js"
import { CompactionAction, EntryId } from "./memory-log.entity.js"
import type { LogBody, LogEntry } from "./memory-log.entity.js"
import { RecallRefusal } from "./recall.entity.js"
import type { ShownPart } from "./recall.entity.js"

/** The name of the tool that reads a shortened result back; a memory strategy never shortens one of its results. */
export const RECALL_TOOL = "recall_context"

/** The most characters one recall_context call returns. */
export const RECALL_PAGE_CHARS = 8_000

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Where a cut asked for at `at` falls in `text`: within the text, and one
 * unit earlier when `at` is inside a surrogate pair, so neither side of the
 * cut holds half a character (a lone surrogate is not valid text to send).
 */
const cutAt = (text: string, at: number): number => {
  const end = Math.min(Math.max(0, Math.floor(at)), text.length)
  return end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end
}

/**
 * A spilled result's preview: its first `chars` characters (one fewer when
 * the cut would split a surrogate pair), and how to read the rest. The
 * offset it prints is where the cut fell, so the page read from it starts
 * at the next character.
 */
export const spillPreview = (entry: LogEntry, view: string, chars: number): string => {
  const cut = cutAt(view, chars)
  return `${view.slice(0, cut)}\n[… ${view.length - cut} more characters kept out of context; call recall_context with locator "${entry.id}" and offset ${cut} to read them]`
}

/**
 * How many characters of `view` a preview of it shows before its notice:
 * the offset the notice prints, when the preview is exactly what
 * `spillPreview` writes for that cut, else 0. A `Spill` holds whatever text
 * its strategy wrote, and only core's own preview says how much of the view
 * it shows.
 */
const previewChars = (entry: LogEntry, view: string, preview: string): number => {
  const printed = Option.map(Option.fromNullishOr(/ and offset (\d+) to read them\]$/.exec(preview)?.[1]), Number)
  return Option.getOrElse(Option.filter(printed, (offset) => Number.isSafeInteger(offset) && spillPreview(entry, view, offset) === preview), () => 0)
}

const RecallParameters = Schema.Struct({
  locator: Schema.String.annotate({ description: "The locator the shortened result shows." }),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "The first character to return; 0 by default." })),
})

const RecallContext = Tool.make(RECALL_TOOL, {
  description: `Read on in a tool result that is shown shortened, by the locator its shortened form shows. Returns at most ${RECALL_PAGE_CHARS} characters from offset (0 by default); when more remains, the reply ends with the offset to pass next. For a result of this turn, a call for text still shown above (an offset inside its shown part, or inside a page already read) can return no text: the reply then says where to read on, or that nothing is left.`,
  parameters: RecallParameters,
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/**
 * Where the page asked for at `offset` starts and ends in `view`: at most
 * `RECALL_PAGE_CHARS` on, neither end inside a surrogate pair.
 */
const pageBounds = (view: string, offset: number): { readonly start: number; readonly end: number } => {
  const start = cutAt(view, offset)
  return { start, end: cutAt(view, start + RECALL_PAGE_CHARS) }
}

/**
 * One page of a stored result: at most `RECALL_PAGE_CHARS` from `offset`,
 * ending with how to read on while more remains. A page never holds half a
 * surrogate pair: it ends one unit earlier when its end would split one (the
 * offset it prints is where it ended), and an `offset` given inside a pair
 * starts at that pair's first unit.
 */
export const recallPage = (locator: string, view: string, offset: number): string => {
  const { start, end } = pageBounds(view, offset)
  const page = view.slice(start, end)
  return end >= view.length ? page
    : `${page}\n[… ${view.length - end} more characters; call recall_context with locator "${locator}" and offset ${end}]`
}

type ToolResultBody = Extract<LogBody, { readonly _tag: "ToolResult" }>

/** Whether a compaction rewrites what the result `id` shows: a compact view of it, or a spill's preview. */
const rewrites = (action: CompactionAction, id: EntryId): boolean => CompactionAction.match(action, {
  CompactViews: (compact) => compact.entries.includes(id),
  Spill: (spill) => spill.entry === id,
  DropTurns: () => false,
  Summarize: () => false,
  OmitMedia: () => false,
})

/**
 * How many characters of its view, from its start, a result of the turn
 * being run still shows: all of them while nothing rewrote or digested it,
 * the head before the notice after a spill or a bound, and 0 otherwise (a
 * compact view, a digest, a preview that is not core's). The precedence is
 * the render's own (`shownViewsOf`), with digests counted as shown: a
 * strategy that shows none shows more, never less. A reader names no
 * strategy, so the one whose compaction last named the result is taken: a
 * result of the turn being run was written, and so only ever rewritten, by
 * the session that renders it, and with no such compaction every strategy
 * shows it alike.
 */
const shownChars = (entries: ReadonlyArray<LogEntry>, result: LogEntry, body: ToolResultBody): number => {
  const strategy = entries.flatMap((entry) => entry.body._tag === "Compaction" && rewrites(entry.body.action, result.id) ? [entry.body.strategy] : []).at(-1) ?? ""
  return Option.match(Option.fromNullishOr(shownViewsOf(entries, { strategy, digests: true }).get(result.id)), {
    onNone: () => body.view.length,
    onSome: (shown) => shown.by === "Spill" ? previewChars(result, body.view, shown.text) : 0,
  })
}

const decodeRecallInput = Schema.decodeUnknownOption(RecallParameters)

/**
 * Whether a recorded result is the asking run's: the run of the step loop
 * the call is made in, by its id and its ordinal. A call made outside a loop
 * names no run, and then only a result recorded with no run is its own.
 */
const ofRun = (asking: Option.Option<RunRef>, entry: LogEntry, body: ToolResultBody): boolean => Option.match(asking, {
  onNone: () => body.run === undefined,
  onSome: (run) => entry.runId === run.id && body.run === run.ordinal,
})

/**
 * Why a page of `target` from `offset` is not served, if it is not: the
 * guard of the turn being run, decided from the run's memory alone. A result
 * of an earlier turn is always served.
 *
 * - `ResultShown`: the page would start inside the text the result still
 *   shows (`shownChars`).
 * - `AlreadyRecalled`: the page would start inside a page of `target` that a
 *   `recall_context` call of this turn returned to the asking run, and that
 *   page is still shown whole. `next` is where that page ended; of several
 *   such pages, the one that ends last. Only a recorded page counts: a
 *   refused call returned none, and the call being answered has no result
 *   yet. Only the asking run's pages count (`ofRun`): a build leaves out
 *   another run's exchange while one of its calls has no result, so a page
 *   that run read may not be in the request this call was made from.
 *
 * An offset past the shown text and outside every such page is a page. Two
 * calls for one page that a response makes together and the loop runs at
 * once are both served: neither has a result when the other is checked.
 */
const recallRefusalOf = (stored: ReadonlyArray<LogEntry>, turn: number, asking: Option.Option<RunRef>, target: LogEntry, offset: number): Option.Option<RecallRefusal> => {
  const body = target.body
  if (body._tag !== "ToolResult" || target.turn !== turn) return Option.none()
  const entries = presentedEntries(stored)
  const view = body.view
  const { start } = pageBounds(view, offset)
  const shown = shownChars(entries, target, body)
  if (start < shown) return Option.some({ _tag: "ResultShown", shown: shown < view.length ? "head" : "whole" })
  const pages = entries.flatMap((entry) => entry.turn === turn && entry.body._tag === "ToolResult" && entry.body.toolName === RECALL_TOOL && !entry.body.isError && ofRun(asking, entry, entry.body)
    ? [{ entry, page: entry.body }] : [])
  // The inputs of every result are read in one pass over the log, and only when the turn holds a page at all.
  const inputs = pages.length === 0 ? new Map<EntryId, unknown>() : toolInputsByResult(entries)
  // Where each page that holds the offset ended: one that starts there (an empty page holds nothing else), or one the offset falls inside.
  const ends = pages.flatMap(({ entry, page }) => Option.match(Option.filter(decodeRecallInput(inputs.get(entry.id)), (input) => input.locator === target.id), {
    onNone: () => [],
    onSome: (input) => {
      const read = pageBounds(view, input.offset ?? 0)
      return (read.start === start || (read.start < start && start < read.end)) && shownChars(entries, entry, page) >= page.view.length ? [read.end] : []
    },
  }))
  return ends.length === 0 ? Option.none() : Option.some({ _tag: "AlreadyRecalled", next: Option.filter(Option.some(Math.max(...ends)), (end) => end < view.length) })
}

/**
 * What a `ResultShown` failure says, by how much of the result was shown. A
 * failure is the call's recorded result, read again in every later request,
 * and memory may shorten the result it is about in between: a spill under
 * pressure leaves a shorter head and a new notice, a compact view leaves no
 * notice. So each text says what the result showed when the call was made,
 * holds no offset of its own, and sends the model to the offset the result's
 * shortened form shows when it reads the reply (the tool's description names
 * a shortened result that way): with a notice, that is where the result's
 * shown form ends; with none, the result's start. A result still shown
 * whole is not shown shortened, so its text sends the model to no call that
 * would be refused again.
 */
const resultShownMessage: Record<ShownPart, string> = {
  head: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none.",
  whole: "This result was shown in full when you asked: nothing of it was left out. If it is shown shortened now, pass the offset its shortened form shows, or offset 0 if it shows none.",
}

/**
 * The failure `recall_context` returns for a refusal: what the request held
 * of the text asked for, and how to read on. It holds nothing of the call
 * (no offset asked for, no locator), so every offset inside one shown head,
 * and every offset inside one page, gets the same failure. An
 * `AlreadyRecalled` text names no turn: it is read again in later turns,
 * where the page it calls shown is still above it (the two are recorded in
 * one turn, and a turn leaves a request only as a whole).
 */
const recallRefusalFailure = (refusal: RecallRefusal): Failure => RecallRefusal.match(refusal, {
  ResultShown: ({ shown }) => ({ error: "ResultShown", message: resultShownMessage[shown] }),
  AlreadyRecalled: ({ next }) => ({
    error: "AlreadyRecalled",
    message: Option.match(next, {
      onNone: () => "The text from that offset is in a page you already read, shown above. That page ends the result.",
      onSome: (ended) => `The text from that offset is in a page you already read, shown above. To read on, pass offset ${ended}.`,
    }),
  }),
})

const recallTool = defineTool({
  tool: RecallContext,
  requires: [RunContext],
  handler: ({ locator, offset }) => Effect.gen(function* () {
    const run = yield* RunContext
    const id = Schema.decodeUnknownOption(EntryId)(locator)
    const entry = Option.isNone(id) ? Option.none<LogEntry>() : yield* run.memory.resolve(id.value)
    const target = Option.flatMap(entry, (found) => found.body._tag === "ToolResult" ? Option.some({ found, view: found.body.view }) : Option.none())
    if (Option.isNone(target)) return yield* Effect.fail({ error: "UnknownLocator", message: `No stored result has locator ${locator}; pass a locator exactly as a shortened result shows it` })
    const { found, view } = target.value
    const from = offset ?? 0
    if (from > 0 && from >= view.length) return yield* Effect.fail({ error: "OffsetOutOfRange", message: `The result has ${view.length} characters; pass an offset below ${view.length}` })
    // The loop's run where the loop makes the call; none for a call made outside one.
    const refusal = recallRefusalOf(yield* run.memory.entries, yield* run.memory.turn, yield* CurrentAgentRun, found, from)
    return yield* Option.match(refusal, {
      onNone: () => Effect.succeed(recallPage(locator, view, from)),
      onSome: (refused) => Effect.fail(recallRefusalFailure(refused)),
    })
  }),
  annotations: { readOnly: true },
})

/**
 * The memory-owned tool that makes a shortened result lossless for the
 * model, as a capability under the id of the memory plugin that contributes
 * it. The tool, its always-on skill and every text of theirs are the same
 * under each id.
 */
export const recallCapabilityOf = (id: string): Capability => defineCapability({
  id,
  version: "1",
  tools: [recallTool],
  skills: [defineSkill({ id: "memory.recall", summary: "Read shortened earlier results in full.", tools: [RECALL_TOOL], always: true })],
})
