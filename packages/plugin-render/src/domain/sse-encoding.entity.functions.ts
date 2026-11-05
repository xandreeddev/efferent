import { Array as Arr, Option } from "effect"
import type { SseContentEncoding } from "./sse-encoding.entity.js"

/** One `Accept-Encoding` member: its coding, lowercased, and its weight (1 when it names none, 0 when the weight is malformed). */
const weightsOf = (acceptEncoding: string): ReadonlyArray<readonly [string, number]> =>
  acceptEncoding.split(",").flatMap((member) => {
    const [name = "", ...parameters] = member.split(";").map((part) => part.trim())
    if (name.length === 0) return []
    const weight = Arr.findFirst(parameters, (parameter) => /^q\s*=/i.test(parameter)).pipe(Option.match({
      onNone: () => 1,
      onSome: (parameter) => {
        const value = parameter.slice(parameter.indexOf("=") + 1).trim()
        return /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value) ? Number(value) : 0
      },
    }))
    return [[name.toLowerCase(), weight] as const]
  })

/** Whether the client takes `coding`: listed with a weight above 0, or unlisted while `*` has one. */
const accepts = (weights: ReadonlyArray<readonly [string, number]>, coding: string): boolean =>
  Arr.findFirst(weights, ([name]) => name === coding).pipe(
    Option.orElse(() => Arr.findFirst(weights, ([name]) => name === "*")),
    Option.match({ onNone: () => false, onSome: ([, weight]) => weight > 0 }),
  )

/**
 * The coding to send an SSE response in, given the request's `Accept-Encoding`:
 * `br` when the client takes it, else `gzip`, else `identity`. A coding is taken
 * when it is listed with a weight above 0, or is unlisted and `*` has one; a
 * coding listed with `q=0` is refused even under `*`. The server's order
 * decides between two codings the client takes, whatever their weights.
 *
 * @public
 */
export const sseContentEncodingOf = (acceptEncoding: string): SseContentEncoding => {
  const weights = weightsOf(acceptEncoding)
  return accepts(weights, "br") ? "br" : accepts(weights, "gzip") ? "gzip" : "identity"
}
