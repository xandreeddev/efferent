import { Effect, Schema } from "effect"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import { ModelCallPolicy } from "../domain/model-call-policy.entity.js"
import { RunId, RunKey } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"

/**
 * Public provider options only, as JSON. Credentials and endpoint
 * authorization never belong here.
 *
 * @public
 */
export const ModelRequestDescriptor = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  settings: Schema.JsonObject,
})
export type ModelRequestDescriptor = typeof ModelRequestDescriptor.Type

/**
 * A provider-defined tool's id (`<provider>.<tool>`, effect/ai's
 * `Tool.ProviderDefined.id`), as a header stores it, with no checks.
 *
 * @public
 */
export const ProviderToolId = Schema.String.pipe(Schema.brand("ProviderToolId"))
export type ProviderToolId = typeof ProviderToolId.Type

/**
 * The model-visible declaration. A provider-defined tool (one the provider
 * runs) keeps its id and name, and its args only as their key names and the
 * SHA-256 of their canonical JSON: args can carry credentials (a remote tool
 * server's authorization), so their values are never stored. A dispatch
 * compares the digests, so any change of a value still diverges.
 *
 * @public
 */
export const ModelRequestTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
  provider: Schema.OptionFromNullOr(Schema.Struct({
    id: ProviderToolId,
    name: Schema.String,
    argKeys: Schema.Array(Schema.String),
    argsDigest: Schema.String,
  })),
})
export type ModelRequestTool = typeof ModelRequestTool.Type

/**
 * A saved pure-render recipe: replay uses these options even after a memory
 * plugin upgrade.
 *
 * @public
 */
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
 * Full materialized request and historical durable version 1, separate from
 * diagnostic context/model events. New version 2 headers reference reusable
 * parts; resolution returns this full shape. Messages
 * remain in memory events: the request is rebuilt from the memory entries up
 * to `through`, the last one its build folded, with the saved `render`
 * recipe, so a memory write recorded after the build (a reaction to
 * `context.built`) is not part of it. Each header is self-contained: it
 * repeats the full system text and every active tool's declaration, a
 * deliberate storage trade-off so one event (and the memory before it)
 * rebuilds a request without reading other headers.
 *
 * @public
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
  /** Frozen prefix length before volatile context; absent in historical headers, which replay without a marker. */
  stableMessages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  tools: Schema.Array(ModelRequestTool),
  toolChoice: Schema.Unknown,
  /** None explicitly marks an opaque model whose provider configuration cannot be inspected. */
  model: Schema.OptionFromNullOr(ModelRequestDescriptor),
  cacheKey: Schema.OptionFromNullOr(Schema.String),
  callPolicy: Schema.OptionFromNullOr(ModelCallPolicy),
})
export type ModelRequestHeader = typeof ModelRequestHeader.Type
