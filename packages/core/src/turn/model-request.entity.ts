import { Effect, Schema } from "effect"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import { ModelCallPolicy } from "../domain/model-call-policy.entity.js"
import { RunId, RunKey } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"

/** Public provider options only, as JSON. Credentials and endpoint authorization never belong here. */
export const ModelRequestDescriptor = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  settings: Schema.JsonObject,
})
export type ModelRequestDescriptor = typeof ModelRequestDescriptor.Type

/**
 * The model-visible declaration. A provider-defined tool (one the provider
 * runs) keeps its id and name, and its args only as their key names and the
 * SHA-256 of their canonical JSON: args can carry credentials (a remote tool
 * server's authorization), so their values are never stored. A dispatch
 * compares the digests, so any change of a value still diverges.
 */
export const ModelRequestTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
  provider: Schema.OptionFromNullOr(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    argKeys: Schema.Array(Schema.String),
    argsDigest: Schema.String,
  })),
})
export type ModelRequestTool = typeof ModelRequestTool.Type

/** A saved pure-render recipe: replay uses these options even after a memory plugin upgrade. */
export const MemoryRenderRecipe = Schema.Struct({
  strategy: Schema.String,
  currentTurn: Schema.Int,
  currentRun: RunId,
  /** The run of the turn whose step context the render shows; a header written before runs were counted reads 0. */
  run: RunKey,
  turnContext: Schema.Literals(["current", "all"]),
  replies: Schema.Boolean,
  stepContext: Schema.Literals(["tail", "none"]),
  digests: Schema.Boolean,
  media: Schema.Struct({
    mode: Schema.Literals(["none", "inline"]),
    maxImages: Schema.Int,
    /** Base64 characters of the images sent as images; a header written before 0.14.0 reads `MEDIA_LIMITS.requestChars`. */
    maxChars: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(MEDIA_LIMITS.requestChars))),
  }),
})
export type MemoryRenderRecipe = typeof MemoryRenderRecipe.Type

/**
 * Durable protocol, separate from diagnostic context/model events. Messages
 * remain in memory events: the request is rebuilt from the memory entries up
 * to `through`, the last one its build folded, with the saved `render`
 * recipe, so a memory write recorded after the build (a reaction to
 * `context.built`) is not part of it. Each header is self-contained: it
 * repeats the full system text and every active tool's declaration, a
 * deliberate storage trade-off so one event (and the memory before it)
 * rebuilds a request without reading other headers.
 */
export const ModelRequestHeader = Schema.Struct({
  version: Schema.Literal(1),
  runId: RunId,
  /** The run of the turn the request belongs to (`RunRef.ordinal`); a header written before runs were counted reads 0. */
  run: RunKey,
  step: Schema.Int,
  strategyVersion: Schema.String,
  system: Schema.String,
  render: MemoryRenderRecipe,
  /** The last memory entry the build included (its cut); none for an empty log. */
  through: Schema.OptionFromNullOr(EntryId),
  contextFingerprint: Schema.String,
  tools: Schema.Array(ModelRequestTool),
  toolChoice: Schema.Unknown,
  /** None explicitly marks an opaque model whose provider configuration cannot be inspected. */
  model: Schema.OptionFromNullOr(ModelRequestDescriptor),
  cacheKey: Schema.OptionFromNullOr(Schema.String),
  callPolicy: Schema.OptionFromNullOr(ModelCallPolicy),
})
export type ModelRequestHeader = typeof ModelRequestHeader.Type
