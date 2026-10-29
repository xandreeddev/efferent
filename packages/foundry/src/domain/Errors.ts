import { Option, Predicate, Schema } from "effect"
import { AttemptNumber, GateName } from "./Brands.js"

/**
 * `Schema.TaggedError` (not `Data.TaggedError`) throughout: foundry's errors
 * cross a serialization boundary — they appear inside the persisted
 * `FactoryRun` artifact and inside model-readable feedback — so each carries
 * its schema and needs no hand-rolled normalizer.
 *
 * `message` says what failed; `cause` keeps the failure it wraps as a value
 * (its tag, its fields, a Node error's `code`), never as `String(cause)`
 * text. An `Error` cause encodes as its name and message, never its stack.
 */
const cause = Schema.optional(Schema.Defect())

/** A gate failed to RUN (as opposed to failing the workspace). Fail-closed:
 *  the pipeline folds this into a `fail` verdict, never a silent pass. */
export class GateCrash extends Schema.TaggedError<GateCrash>()("GateCrash", {
  gate: GateName,
  message: Schema.String,
  cause,
}) {}

export class ImplementorError extends Schema.TaggedError<ImplementorError>()("ImplementorError", {
  attempt: AttemptNumber,
  message: Schema.String,
  cause,
}) {}

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
  cause,
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
  cause,
}) {}

/** A `ts.Program` could not be built (bad tsconfig path, parse errors).
 *  Gates map this into their own `GateCrash`. */
export class ProjectLoadError extends Schema.TaggedError<ProjectLoadError>()("ProjectLoadError", {
  tsconfig: Schema.String,
  message: Schema.String,
  cause,
}) {}

/** The message of a wrapped failure: an `Error`'s (a decoded one's too),
 *  or a thrown string. Anything else has none. */
const causeMessage = (wrapped: unknown): Option.Option<string> =>
  Predicate.isString(wrapped)
    ? Option.some(wrapped)
    : Predicate.hasProperty(wrapped, "message") && Predicate.isString(wrapped.message)
      ? Option.some(wrapped.message)
      : Option.none()

/** An error's message, then the message of the failure it wraps: the line a
 *  person reads at the terminal. Messages only, never a stack. */
export const describeError = (error: { readonly message: string; readonly cause?: unknown }): string =>
  Option.match(causeMessage(error.cause), {
    onNone: () => error.message,
    onSome: (wrapped) => `${error.message}: ${wrapped}`,
  })
