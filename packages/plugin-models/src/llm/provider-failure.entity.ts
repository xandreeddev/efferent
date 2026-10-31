import { Schema } from "effect"

/** The existing provider dialect whose error vocabulary is being interpreted. */
export const ProviderFailureProtocol = Schema.Literals(["anthropic", "openai", "compat"])
export type ProviderFailureProtocol = typeof ProviderFailureProtocol.Type

/** Raw provider evidence, before status and SDK normalization discard its meaning. */
export const ProviderFailureEvidence = Schema.Struct({
  protocol: ProviderFailureProtocol,
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  code: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  stopReason: Schema.optionalKey(Schema.String),
})
export type ProviderFailureEvidence = typeof ProviderFailureEvidence.Type

/** Only known structured error fields are read; arbitrary response data is not searched. */
export const ProviderErrorDetail = Schema.Struct({
  code: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ProviderErrorDetail = typeof ProviderErrorDetail.Type

/** HTTP providers and sockets expose these two established error-body shapes. */
export const ProviderErrorBody = Schema.Struct({
  error: Schema.optionalKey(Schema.Union([ProviderErrorDetail, Schema.String])),
  ...ProviderErrorDetail.fields,
})
export type ProviderErrorBody = typeof ProviderErrorBody.Type

/** The pinned SDK's namespaced HTTP metadata and top-level socket metadata. */
export const ProviderErrorMetadata = Schema.Struct({
  ...ProviderErrorDetail.fields,
  errorCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errorType: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ProviderErrorMetadata = typeof ProviderErrorMetadata.Type
