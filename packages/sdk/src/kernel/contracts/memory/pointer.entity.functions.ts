import { Option, Result } from "effect"
import type { Schema } from "effect"
import { messageOf } from "@xandreed/core/kernel"
import type { Message, StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens, framed, hostNote } from "./memory.entity.functions.js"
import { READ_RESULT } from "./pointer.entity.js"
import type { PointerOptions, ResultPage } from "./pointer.entity.js"

/**
 * The text of a tool's result, as it is measured and read back: a string as it is, anything else its JSON. The
 * pointer and `readResult` both count characters of this text, so the place one names is the place the other reads.
 *
 * @public
 */
export const resultText = (result: Schema.Json): string => typeof result === "string" ? result : JSON.stringify(result)

/** Whether a cut at `at` would fall between the two halves of one character (a surrogate pair). */
const splits = (text: string, at: number): boolean =>
  at > 0 && at < text.length && (text.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(at) & 0xfc00) === 0xdc00

/** The place to end a slice of `text` asked to end at `at`: there, or one earlier when that would cut a character in two. */
const endAt = (text: string, at: number): number => (splits(text, at) ? at - 1 : at)

/** The start of a result's text sent with its pointer: `characters` of it, never half a character. */
export const previewOf = (text: string, characters: number): string => text.slice(0, endAt(text, Math.min(text.length, characters)))

/**
 * What the model is sent in place of a long result: its start, framed as the tool's own text, then one host note
 * saying how long the result is, how much of it this is, and the call that reads on. `at` is the result's place in
 * its journal.
 */
export const pointerText = (at: number, text: string, preview: string): string =>
  `${framed("tool-result-preview", preview)}\n${hostNote(`the result above is cut short: it is ${text.length} characters long and its first ${preview.length} are shown. To read on, call ${READ_RESULT} with result ${at} and from ${preview.length}.`)}`

/** Pointer options as `pointed` uses them, or what is wrong with them. */
const checked = ({ overTokens, previewTokens }: PointerOptions): Result.Result<{ readonly overTokens: number; readonly characters: number }, string> =>
  !Number.isFinite(overTokens) || overTokens < 1 || !Number.isFinite(previewTokens) || previewTokens < 1
    ? Result.fail(`pointers need overTokens and previewTokens of at least one token each; they were given overTokens ${overTokens} and previewTokens ${previewTokens}`)
    : previewTokens >= overTokens
      ? Result.fail(`a preview of ${previewTokens} tokens is not shorter than the results it stands for, those over ${overTokens} tokens: give pointers a previewTokens below overTokens`)
      : Result.succeed({ overTokens, characters: Math.floor(previewTokens) * 4 })

/**
 * `messageOf`, with long results shortened (ADR 0011): the function a memory reads each record's message with. A
 * tool's result whose text is estimated over `overTokens` is still that call's result, failed or not; what it says
 * becomes the first `previewTokens` of its text and a pointer naming its place in the journal, which the
 * `readResult` tool reads from. Three results are left as stored: one its tool marked `whole`, a page `readResult`
 * itself returned, and one the pointer would not make shorter. It reads the record and nothing else, so a result is
 * sent the same way in every context: the start of a prompt a provider cached does not change. Options that are none
 * are refused here, where they are written: it throws, as a definition does.
 *
 * @public
 */
export const pointed = (options: PointerOptions): ((record: StoredEvent) => Option.Option<Message>) => {
  const { overTokens, characters } = Result.getOrThrowWith(checked(options), (problem) => new Error(problem))
  return (record) => Option.map(messageOf(record), (message) => {
    if (message._tag !== "ToolResult" || message.whole === true || message.name === READ_RESULT) return message
    const text = resultText(message.result)
    if (estimateTokens(text) <= overTokens) return message
    const pointer = pointerText(record.seq, text, previewOf(text, characters))
    return pointer.length < text.length ? { ...message, result: pointer } : message
  })
}

/** What `readResult` answers when no tool result is stored at the place it was given. */
export const noResultAt = (at: number): string => `No tool result is stored at ${at}: use the number a cut-short result names.`

/** What `readResult` answers when asked to start at or past the end of a result. */
export const pastTheEnd = (at: number, total: number): string => `The result at ${at} is ${total} characters long: from must be less than ${total}.`

/**
 * A part of the result stored at `at` in `journal`: up to `length` characters of its text from `from`, never half a
 * character, or why there is none (no tool result at that place; `from` at or past its end). `length` is the
 * caller's to bound. Following the pointer
 * and then each page's `to` reads the whole text, each character once.
 */
export const pageOf = (journal: ReadonlyArray<StoredEvent>, at: number, from: number, length: number): Result.Result<ResultPage, string> => {
  const stored = journal.find((event) => event.seq === at)
  const message = stored === undefined ? Option.none<Message>() : messageOf(stored)
  if (Option.isNone(message) || message.value._tag !== "ToolResult") return Result.fail(noResultAt(at))
  const text = resultText(message.value.result)
  // An empty result has one page, from 0: nothing.
  if (from >= text.length && from > 0) return Result.fail(pastTheEnd(at, text.length))
  // A start inside a character moves past it; an end inside one moves before it, but a page always reads something.
  const start = splits(text, from) ? from + 1 : from
  const asked = endAt(text, Math.min(text.length, start + Math.max(1, length)))
  const to = asked > start ? asked : Math.min(text.length, start + 2)
  return Result.succeed({ text: text.slice(start, to), from: start, to, total: text.length })
}
