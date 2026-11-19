import { Schema } from "effect"

/**
 * How long results are shortened (ADR 0011): a tool's result estimated over `overTokens` is sent as its first
 * `previewTokens` and a pointer, and the model reads the rest with `readResult`. Both count by memory's estimate
 * (`estimateTokens`); the preview is shorter than the results it stands for. Options that are none (a number that is
 * not finite or under one token, a preview not shorter than `overTokens`) are refused where they are written:
 * `pointed` throws, as a definition does.
 *
 * @public
 */
export interface PointerOptions {
  /** A result whose text is estimated over this many tokens is sent as a pointer. At least one. */
  readonly overTokens: number
  /** How much of its start is sent with the pointer. At least one token, and fewer than `overTokens`. */
  readonly previewTokens: number
}

/**
 * The name of the tool a pointer tells the model to call. The pointer's text and the tool are one contract: a host
 * that sends pointers offers the tool, under this name.
 *
 * @public
 */
export const READ_RESULT = "readResult"

/**
 * The most characters one call of the tool reads.
 *
 * @public
 */
export const READ_RESULT_PAGE = 2000

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A part of a stored result's text: the characters from `from` up to `to`, of `total`. The next part starts at
 * `to`; the result is read to its end when `to` is `total`.
 *
 * @public
 */
export const ResultPage = Schema.Struct({ text: Schema.String, from: Offset, to: Offset, total: Offset })
export type ResultPage = typeof ResultPage.Type
