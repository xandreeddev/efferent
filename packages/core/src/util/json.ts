import { Effect, Result, Option } from "effect"

/**
 * Parse JSON with CORRUPT ≠ ABSENT semantics: malformed text logs a warning
 * naming the source and yields `None`. Config readers fall back to their
 * empty shape either way — but a corrupt `auth.json` silently reading as
 * "logged out", or a corrupt `config.json` as "defaults", gives the user
 * zero signal about the actual problem (audit class L8).
 */
export const parseJsonWarn = (
  text: string,
  where: string,
): Effect.Effect<Option.Option<unknown>> =>
  Result.match(
    Result.try(() => JSON.parse(text) as unknown),
    {
      onFailure: (error) =>
        Effect.logWarning(
          `${where}: unreadable JSON — treating as empty: ${String(error)}`,
        ).pipe(Effect.as(Option.none<unknown>())),
      onSuccess: (value) => Effect.succeed(Option.some(value)),
    },
  )

/** The record-or-empty projection every config reader wants after parse. */
export const asJsonRecord = (value: Option.Option<unknown>): Record<string, unknown> =>
  Option.match(value, {
    onNone: () => ({}),
    onSome: (parsed) =>
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {},
  })

/** SILENT parse-to-Option — for wire noise (a garbage WS frame) where
 *  dropping without a log is the design; configs use {@link parseJsonWarn}. */
export const parseJsonOption = (text: string): Option.Option<unknown> =>
  Result.getSuccess(Result.try(() => JSON.parse(text) as unknown))

/** Decode append-only JSONL text: one JSON value per line, each decoded by
 *  `decode`; a corrupt or undecodable LINE is skipped (append-only files
 *  corrupt at a line boundary — one bad row must not brick the history).
 *  The shared machinery of the smith memory ledger and the social ledger. */
export const decodeJsonLines = <A, E>(
  text: string,
  decode: (value: unknown) => Result.Result<A, E>,
): ReadonlyArray<A> =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) =>
      Result.try(() => JSON.parse(line) as unknown).pipe(
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
