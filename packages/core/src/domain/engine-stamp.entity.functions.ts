import { Option, Schema } from "effect"
import type { Response } from "effect/ai"
import { ENGINE_KEY, ResponseStamp } from "./engine-stamp.entity.js"

const decodeStamp = Schema.decodeUnknownOption(ResponseStamp)
const isJsonObject = Schema.is(Schema.JsonObject)

/** Merge neutral bookkeeping while preserving provider metadata and engine siblings. */
export const mergeEngineStamp = (metadata: Response.ProviderMetadata, stamp: Schema.JsonObject): Response.ProviderMetadata => {
  const previous = metadata[ENGINE_KEY]
  return { ...metadata, [ENGINE_KEY]: { ...(isJsonObject(previous) ? previous : {}), ...stamp } }
}

const isFinish = (part: Response.AnyPart): part is Response.FinishPart => part.type === "finish"

const finishOf = (content: ReadonlyArray<Response.AnyPart>): Option.Option<Response.FinishPart> =>
  Option.fromNullishOr(content.find(isFinish))

/** A stamp's model, when the value is a stamp. */
const modelOf = (stamp: unknown): Option.Option<string> => Option.map(decodeStamp(stamp), (decoded) => decoded.model)

/** A response part with `model` stamped under {@link ENGINE_KEY} when it is the finish part; any other part as it is. The stream twin of {@link stampResponseModel}. */
export const stampPartModel = (part: Response.AnyPart, model: string): Response.AnyPart =>
  isFinish(part) ? { ...part, metadata: mergeEngineStamp(part.metadata, { model }) } : part

/**
 * A response's content with the model that produced it on its finish part,
 * under core's own key: a model that sends each call on to another (a
 * settings-backed router) stamps the one it resolved, and the step loop
 * stores it with the turn's usage ({@link responseModelOf}). The finish part
 * is copied; the content is not mutated.
 */
export const stampResponseModel = (
  content: ReadonlyArray<Response.AnyPart>,
  model: string,
): ReadonlyArray<Response.AnyPart> => content.map((part) => stampPartModel(part, model))

/** The resolved `provider:modelId` stamped on a response's finish part ({@link stampResponseModel}), if any. */
export const responseModelOf = (content: ReadonlyArray<Response.AnyPart>): Option.Option<string> =>
  Option.flatMap(finishOf(content), (finish) => modelOf(finish.metadata[ENGINE_KEY]))
