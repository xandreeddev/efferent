import { Option } from "effect"
import type { Vector } from "./embedder.entity.js"

/**
 * How alike two vectors are: the cosine of the angle between them, from -1 (opposite) through 0 (unrelated) to 1
 * (the same direction, whatever their lengths). A vector of zeros points nowhere, so it is alike to nothing: 0.
 * Vectors of two lengths come from two kinds of embedding and are not compared: 0.
 *
 * @public
 */
export const cosine = (a: Vector, b: Vector): number => {
  if (a.length !== b.length) return 0
  let dot = 0
  let squaresA = 0
  let squaresB = 0
  for (const [index, x] of a.entries()) {
    const y = b[index] ?? 0
    dot += x * y
    squaresA += x * x
    squaresB += y * y
  }
  if (squaresA === 0 || squaresB === 0) return 0
  // Rounding can carry the quotient of two equal directions a hair past 1.
  return Math.min(1, Math.max(-1, dot / Math.sqrt(squaresA * squaresB)))
}

/** A text in words, quoted, cut at `limit` characters (never half a character) with what was cut counted. */
export const quoted = (text: string, limit = 80): string => {
  if (text.length <= limit) return JSON.stringify(text)
  const end = (text.charCodeAt(limit - 1) & 0xfc00) === 0xd800 ? limit - 1 : limit
  return `${JSON.stringify(text.slice(0, end))} [… ${text.length - end} characters clipped]`
}

/** Why numbers are no `Vector` (none, or one that is not finite), in words, or nothing when they are one. */
export const notAVector = (numbers: ReadonlyArray<number>): Option.Option<string> => {
  if (numbers.length === 0) return Option.some("it holds no number")
  const at = numbers.findIndex((number) => !Number.isFinite(number))
  return at === -1 ? Option.none() : Option.some(`its number at ${at} is ${String(numbers[at])}, not a finite number`)
}
