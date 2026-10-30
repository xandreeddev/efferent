import { Effect, Result, Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/**
 * Parse JSON with CORRUPT ≠ ABSENT semantics: malformed text logs a warning
 * naming the source and yields `None`. Config readers fall back to their
 * empty shape either way — but a corrupt `auth.json` silently reading as
 * "logged out", or a corrupt `config.json` as "defaults", gives the user
 * zero signal about the actual problem.
 *
 * @deprecated Decode the shape that is read with
 * `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` (`Schema.Json` or
 * `Schema.JsonObject` when it stays open), and log the failure where it is
 * handled. Removed in a later release.
 */
export const parseJsonWarn = (
  text: string,
  where: string,
): Effect.Effect<Option.Option<unknown>> =>
  Result.match(
    decodeJson(text),
    {
      onFailure: (error) =>
        Effect.logWarning(
          `${where}: unreadable JSON — treating as empty: ${error.message}`,
        ).pipe(Effect.as(Option.none<unknown>())),
      onSuccess: (value) => Effect.succeed(Option.some(value)),
    },
  )

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)

/**
 * The record-or-empty projection every config reader wants after parse: the
 * parsed value when it is a JSON object, else `{}` (an array, a string or a
 * number is not one).
 *
 * @deprecated Decode the object with `Schema.fromJsonString(S)` instead
 * (`Schema.JsonObject` when it stays open). Removed in a later release.
 */
export const asJsonRecord = (value: Option.Option<unknown>): Record<string, unknown> =>
  Option.getOrElse(Option.flatMap(value, decodeJsonObject), () => ({}))

/**
 * SILENT parse-to-Option — for wire noise (a garbage WS frame) where
 * dropping without a log is the design; configs use {@link parseJsonWarn}.
 *
 * @deprecated Decode with `Schema.decodeUnknownOption(Schema.fromJsonString(S))`
 * instead (`Schema.Json` when the shape stays open). Removed in a later release.
 */
export const parseJsonOption = (text: string): Option.Option<unknown> =>
  Result.getSuccess(decodeJson(text))

/**
 * Decode append-only JSONL text: one JSON value per line, each decoded by
 * `decode`; a corrupt or undecodable LINE is skipped (append-only files
 * corrupt at a line boundary — one bad row must not brick the history).
 *
 * @deprecated Decode each line with `Schema.decodeUnknownResult(Schema.fromJsonString(S))`
 * where the file is read. Removed in a later release.
 */
export const decodeJsonLines = <A, E>(
  text: string,
  decode: (value: unknown) => Result.Result<A, E>,
): ReadonlyArray<A> =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) =>
      decodeJson(line).pipe(
        Result.match({
          onFailure: () => [] as ReadonlyArray<A>,
          onSuccess: (parsed) =>
            Result.match(decode(parsed), {
              onFailure: () => [] as ReadonlyArray<A>,
              onSuccess: (decoded) => [decoded],
            }),
        }),
      ),
    )
