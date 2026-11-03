import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Array as Arr, Effect, Order, Schema } from "effect"
import { EvaluationError } from "./identity.entity.js"
import type { ContextBudget, GradingContext } from "./grading-context.entity.js"

/** Object keys in code-unit order, so a fingerprint is the same under every locale. */
const byKey = Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)

/** `item` with each object's keys in code-unit order. */
const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item !== null && typeof item === "object" ? Object.fromEntries(Arr.sort(Object.entries(item), byKey).map(([key, entry]) => [key, stable(entry)])) : item

/**
 * The SHA-256 of `value`'s JSON, its object keys in code-unit order. An
 * array, and each array member of an object, is hashed an element at a
 * time, so its elements together may outgrow the longest string (a run's
 * trials); the digest is that of the one string.
 *
 * @public
 */
export const fingerprint = (value: unknown): string => {
  const hash = sha256.create()
  const encoder = new TextEncoder()
  const update = (text: string) => { hash.update(encoder.encode(text)) }
  // As JSON.stringify writes an array: an element with no JSON (undefined, a function) or a hole is null.
  const elements = (items: ReadonlyArray<unknown>) => {
    update("[")
    Array.from(items).forEach((item, index) => update(`${index === 0 ? "" : ","}${JSON.stringify(item) ?? "null"}`))
    update("]")
  }
  const sorted = stable(value)
  if (Array.isArray(sorted)) elements(sorted)
  else if (sorted !== null && typeof sorted === "object") {
    // As JSON.stringify writes an object: its keys in property order, a member with no JSON left out.
    const members = Object.entries(sorted).flatMap(([key, entry]): ReadonlyArray<readonly [string, string | ReadonlyArray<unknown>]> => {
      if (Array.isArray(entry)) return [[key, entry]]
      const text: string | undefined = JSON.stringify(entry)
      return text === undefined ? [] : [[key, text]]
    })
    update("{")
    members.forEach(([key, entry], index) => {
      update(`${index === 0 ? "" : ","}${JSON.stringify(key)}:`)
      if (typeof entry === "string") update(entry)
      else elements(entry)
    })
    update("}")
  } else hash.update(encoder.encode(JSON.stringify(sorted)))
  return bytesToHex(hash.digest())
}

export const gradingContext = <I>(options: {
  readonly projection: string; readonly version: string; readonly input: I; readonly schema: Schema.Codec<I, unknown>
  readonly budget: ContextBudget; readonly references: ReadonlyArray<string>; readonly omissions: ReadonlyArray<string>
}): Effect.Effect<GradingContext, EvaluationError> => Schema.encodeEffect(options.schema)(options.input).pipe(
  Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `Grading context ${options.projection} does not encode: ${error.message}`, cause: error })),
  Effect.flatMap((input) => {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
    return bytes + options.budget.reservedBytes > options.budget.maxBytes
      ? Effect.fail(new EvaluationError({ code: "unavailable", message: `Required grading context exceeds ${options.budget.maxBytes} bytes including rubric and response allowance` }))
      : Effect.succeed({ projection: options.projection, version: options.version, input, references: options.references, omissions: options.omissions, bytes, fingerprint: fingerprint({ projection: options.projection, version: options.version, input, budget: options.budget }) })
  }),
)
