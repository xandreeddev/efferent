import { Schema } from "effect"
import { AttemptNumber, GateName } from "./Brands.js"

/**
 * `Schema.TaggedError` (not `Data.TaggedError`) throughout: foundry's errors
 * cross a serialization boundary — they appear inside the persisted
 * `FactoryRun` artifact and inside model-readable feedback — so each carries
 * its schema and needs no hand-rolled normalizer.
 */

/** A gate failed to RUN (as opposed to failing the workspace). Fail-closed:
 *  the pipeline folds this into a `fail` verdict, never a silent pass. */
export class GateCrash extends Schema.TaggedError<GateCrash>()("GateCrash", {
  gate: GateName,
  message: Schema.String,
}) {}

export class ImplementorError extends Schema.TaggedError<ImplementorError>()("ImplementorError", {
  attempt: AttemptNumber,
  message: Schema.String,
}) {}

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A `ts.Program` could not be built (bad tsconfig path, parse errors).
 *  Gates map this into their own `GateCrash`. */
export class ProjectLoadError extends Schema.TaggedError<ProjectLoadError>()("ProjectLoadError", {
  tsconfig: Schema.String,
  message: Schema.String,
}) {}
