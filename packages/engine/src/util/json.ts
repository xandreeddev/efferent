import { Effect, Either, Option } from "effect"

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
  Either.match(
    Either.try(() => JSON.parse(text) as unknown),
    {
      onLeft: (error) =>
        Effect.logWarning(
          `${where}: unreadable JSON — treating as empty: ${String(error)}`,
        ).pipe(Effect.as(Option.none<unknown>())),
      onRight: (value) => Effect.succeed(Option.some(value)),
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
