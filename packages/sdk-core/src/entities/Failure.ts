import { Schema } from "effect"

export const Failure = Schema.Struct({
  error: Schema.String,
  message: Schema.optional(Schema.String),
})
export type Failure = typeof Failure.Type

/**
 * Normalise an arbitrary thrown/failed value into the shared `Failure`
 * struct. An already-tagged failure (a `{ error: "<Tag>", message? }`
 * object, e.g. `OutOfScope` / `EditFailed`) is preserved verbatim so the
 * model sees the intended tag; everything else is wrapped (`_tag` → error,
 * best-effort message).
 */
export const toFailure = (e: unknown): Failure => {
  if (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    typeof (e as { error: unknown }).error === "string"
  ) {
    const o = e as { error: string; message?: unknown }
    return {
      error: o.error,
      ...(o.message !== undefined ? { message: String(o.message) } : {}),
    }
  }
  const tag =
    typeof e === "object" && e !== null && "_tag" in e
      ? String((e as { _tag: unknown })._tag)
      : "Error"
  const message =
    typeof e === "object" && e !== null
      ? String(
          (e as { message?: unknown }).message ??
            (e as { path?: unknown }).path ??
            JSON.stringify(e),
        )
      : String(e)
  return { error: tag, message }
}
