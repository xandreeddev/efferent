import { Tool } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { Failure } from "../domain/failure.entity.js"
import { defineCapability, defineSkill, defineTool } from "../harness/capability.entity.functions.js"
import type { Capability } from "../ports/capability.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { EntryId } from "./memory-log.entity.js"
import type { LogEntry } from "./memory-log.entity.js"

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

const RecallContext = Tool.make(RECALL_TOOL, {
  description: `Read an earlier result that was shortened to save context, by the locator its shortened form shows. Returns at most ${RECALL_PAGE_CHARS} characters from offset (0 by default); when more remain, the reply ends with the offset to pass next.`,
  parameters: Schema.Struct({
    locator: Schema.String.annotate({ description: "The locator the shortened result shows." }),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "The first character to return; 0 by default." })),
  }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/**
 * One page of a stored result: at most `RECALL_PAGE_CHARS` from `offset`,
 * ending with how to read on while more remains. A page never holds half a
 * surrogate pair: it ends one unit earlier when its end would split one (the
 * offset it prints is where it ended), and an `offset` given inside a pair
 * starts at that pair's first unit.
 */
export const recallPage = (locator: string, view: string, offset: number): string => {
  const start = cutAt(view, offset)
  const end = cutAt(view, start + RECALL_PAGE_CHARS)
  const page = view.slice(start, end)
  return end >= view.length ? page
    : `${page}\n[… ${view.length - end} more characters; call recall_context with locator "${locator}" and offset ${end}]`
}

const recallTool = defineTool({
  tool: RecallContext,
  requires: [RunContext],
  handler: ({ locator, offset }) => Effect.gen(function* () {
    const run = yield* RunContext
    const id = Schema.decodeUnknownOption(EntryId)(locator)
    const entry = Option.isNone(id) ? Option.none<LogEntry>() : yield* run.memory.resolve(id.value)
    const view = Option.flatMap(entry, (found) => found.body._tag === "ToolResult" ? Option.some(found.body.view) : Option.none())
    const from = offset ?? 0
    return yield* Option.match(view, {
      onNone: () => Effect.fail({ error: "UnknownLocator", message: `No stored result has locator ${locator}; pass a locator exactly as a shortened result shows it` }),
      onSome: (text) => from > 0 && from >= text.length
        ? Effect.fail({ error: "OffsetOutOfRange", message: `The result has ${text.length} characters; pass an offset below ${text.length}` })
        : Effect.succeed(recallPage(locator, text, from)),
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
