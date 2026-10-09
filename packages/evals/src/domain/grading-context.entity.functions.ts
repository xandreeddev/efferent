import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Effect, Schema } from "effect"
import { EvaluationError } from "./identity.entity.js"
import type { ContextBudget, GradingContext } from "./grading-context.entity.js"

export const fingerprint = (value: unknown): string => {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : item
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(stable(value)))))
}

export const gradingContext = <I>(options: {
  readonly projection: string; readonly version: string; readonly input: I; readonly schema: Schema.Codec<I, unknown>
  readonly budget: ContextBudget; readonly references: ReadonlyArray<string>; readonly omissions: ReadonlyArray<string>
}): Effect.Effect<GradingContext, EvaluationError> => Schema.encodeEffect(options.schema)(options.input).pipe(
  Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })),
  Effect.flatMap((input) => {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
    return bytes + options.budget.reservedBytes > options.budget.maxBytes
      ? Effect.fail(new EvaluationError({ code: "unavailable", message: `Required grading context exceeds ${options.budget.maxBytes} bytes including rubric and response allowance` }))
      : Effect.succeed({ projection: options.projection, version: options.version, input, references: options.references, omissions: options.omissions, bytes, fingerprint: fingerprint({ projection: options.projection, version: options.version, input, budget: options.budget }) })
  }),
)
