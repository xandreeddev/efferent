import { Schema } from "effect"
import type { Duration, Redacted } from "effect"
import { OtlpCompression, OtlpProtocol } from "./otlp-telemetry.entity.js"

/** A registered LangSmith agent identifier. @public */
export const LangSmithAgentId = Schema.String.check(Schema.isPattern(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/)).pipe(Schema.brand("LangSmithAgentId"))
export type LangSmithAgentId = typeof LangSmithAgentId.Type

/** The environment selected in an agent-based LangSmith workspace. @public */
export const LangSmithEnvironment = Schema.Literals(["local", "development", "staging", "production"])
export type LangSmithEnvironment = typeof LangSmithEnvironment.Type

/** Exactly one project or registered agent/environment destination. @public */
export const LangSmithTarget = Schema.Union([
  Schema.TaggedStruct("Project", { project: Schema.Trimmed.check(Schema.isNonEmpty()) }),
  Schema.TaggedStruct("Agent", { agentId: LangSmithAgentId, environment: LangSmithEnvironment }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type LangSmithTarget = typeof LangSmithTarget.Type

/** Host configuration for trace-only LangSmith OTLP export. No model or LangSmith SDK is required. @public */
export interface LangSmithTelemetryOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly target: typeof LangSmithTarget.Encoded
  /** A complete traces URL, used verbatim; defaults to the US SaaS /otel/v1/traces endpoint. */
  readonly tracesUrl?: string
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly resourceAttributes?: Readonly<Record<string, string>>
  readonly protocol?: OtlpProtocol
  readonly compression?: OtlpCompression
  readonly exportInterval?: Duration.Input
  readonly shutdownTimeout?: Duration.Input
}

/** Internal input decoder; durations are validated with Duration.fromInput after this shape check. */
export const LangSmithTelemetryInput = Schema.Struct({
  apiKey: Schema.Redacted(Schema.String.check(Schema.isPattern(/^\S+(?![\s\S])/)), { disallowJsonEncode: true }),
  target: LangSmithTarget,
  tracesUrl: Schema.optionalKey(Schema.Trimmed.check(Schema.isNonEmpty())),
  serviceName: Schema.optionalKey(Schema.NonEmptyString),
  serviceVersion: Schema.optionalKey(Schema.NonEmptyString),
  resourceAttributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  protocol: Schema.optionalKey(OtlpProtocol),
  compression: Schema.optionalKey(OtlpCompression),
  exportInterval: Schema.optionalKey(Schema.Unknown),
  shutdownTimeout: Schema.optionalKey(Schema.Unknown),
})

export const LANGSMITH_TRACES_URL = "https://api.smith.langchain.com/otel/v1/traces"
export const LANGSMITH_OPTIONS_ERROR = "Invalid LangSmith telemetry options"

/** LangSmith's documented run types; explicit host annotations may select any of them. */
export const LangSmithRunType = Schema.Literals(["llm", "chain", "tool", "retriever", "embedding", "prompt", "parser"])
export type LangSmithRunType = typeof LangSmithRunType.Type
