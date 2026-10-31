import { Option, Schema, Tracer } from "effect"
import { traceParentOf } from "@xandreed/core"
import { LangSmithRunType } from "./langsmith-telemetry.entity.js"

const nativeOperations = new Set(["LanguageModel.generateText", "LanguageModel.generateObject", "LanguageModel.streamText"])
const inferenceOperations = new Set(["chat", "text_completion", "completion", "generate_content"])
const frameworkWrapper = (name: string): boolean => ["agent.", "engine.", "tasks.", "task."].some((prefix) => name.startsWith(prefix))
  || ["providers.generate", "models.utility", "loop.tool_call"].includes(name)
const runTypeOf = Schema.decodeUnknownOption(LangSmithRunType)
const explicitType = (span: Tracer.Span) => runTypeOf(span.attributes.get("langsmith.span.kind"))
const inferenceType = (type: LangSmithRunType): boolean => type === "llm" || type === "embedding"
const neutralInference = (span: Tracer.Span): boolean => {
  const operation = span.attributes.get("gen_ai.operation.name")
  return typeof operation === "string" && inferenceOperations.has(operation)
}
const usageOrCost = (key: string): boolean => ["gen_ai.usage.", "gen_ai.cost.", "llm.usage.", "llm.token_count.", "llm.cost.", "langsmith.usage.", "langsmith.cost."].some((prefix) => key.startsWith(prefix))
  || key === "langsmith.usage_metadata" || key === "usage_metadata"
const alternateType = (key: string): boolean => ["openinference.span.kind", "traceloop.span.kind", "traceloop.llm.request.type", "llm.request.type", "llm.prompt_template.variables"].includes(key)

/** Map attributes before Effect's own span end snapshots them for OTLP. */
const finishAttributes = (span: Tracer.Span, type: LangSmithRunType): void => {
  if (!inferenceType(type)) {
    const attributes = span.attributes
    // Both Effect OTLP and NativeSpan own mutable Maps behind their readonly view.
    if (attributes instanceof Map) Array.from(attributes.keys()).filter((key) => usageOrCost(key) || alternateType(key)
      || key === "gen_ai.operation.name" && !(type === "tool" && span.attributes.get(key) === "execute_tool")
      || type !== "tool" && (key === "gen_ai.tool.name" || key === "tool.name")).forEach((key) => attributes.delete(key))
  }
  const alias = (current: string, destination: string) => {
    if (!span.attributes.has(destination) && span.attributes.has(current)) span.attribute(destination, span.attributes.get(current))
  }
  if (inferenceType(type)) {
    alias("gen_ai.provider.name", "gen_ai.system")
    alias("gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_write.input_tokens")
  }
  if (type === "chain") {
    alias("engine.step.input", "input.value")
    alias("engine.step.output", "output.value")
  }
  span.attribute("langsmith.span.kind", type)
}

/** Preserve the underlying span object, context hook and lifecycle; state is weak and tracer-local. */
export const langSmithTracer = (underlying: Tracer.Tracer): Tracer.Tracer => {
  const inferred = new WeakSet<Tracer.Span>()
  const childInference = new WeakSet<Tracer.Span>()
  const explicitAncestor = (parent: Option.Option<Tracer.AnySpan>, remaining = 128): boolean => Option.match(parent, {
    onNone: () => false,
    onSome: (span) => {
      if (span._tag !== "Span" || remaining <= 0) return false
      const authored = inferred.has(span) ? Option.none<LangSmithRunType>() : explicitType(span)
      const ownsInference = Option.match(authored, { onSome: inferenceType, onNone: () => !nativeOperations.has(span.name) && neutralInference(span) })
      return !frameworkWrapper(span.name) && span.attributes.get("efferent.inference.synthetic") !== true && ownsInference || explicitAncestor(span.parent, remaining - 1)
    },
  })
  const markAncestors = (parent: Option.Option<Tracer.AnySpan>, remaining = 128): void => Option.match(parent, {
    onNone: () => undefined,
    onSome: (span) => {
      if (span._tag !== "Span" || remaining <= 0) return
      if (nativeOperations.has(span.name)) childInference.add(span)
      markAncestors(span.parent, remaining - 1)
    },
  })
  return Tracer.make({
    ...(underlying.context === undefined ? {} : { context: underlying.context }),
    span(options) {
      // Effect accepts arbitrary custom parent strings; OTLP requires valid IDs.
      const parent = Option.filter(options.parent, (candidate) => Option.isSome(traceParentOf(candidate)))
      const span = underlying.span({ ...options, parent })
      const end = span.end.bind(span)
      span.end = (endTime, exit) => {
        if (span.status._tag === "Ended") return
        const authored = explicitType(span)
        const native = nativeOperations.has(span.name)
        const automaticInference = native || neutralInference(span)
        const synthetic = span.attributes.get("efferent.inference.synthetic") === true
        const suppressed = native && explicitAncestor(span.parent)
        const type = synthetic || frameworkWrapper(span.name) || suppressed || native && childInference.has(span) ? "chain" : native ? "llm" : Option.getOrElse(authored, (): LangSmithRunType => automaticInference ? "llm"
          : span.name.startsWith("tool.") || span.attributes.get("gen_ai.operation.name") === "execute_tool" ? "tool" : "chain")
        if (Option.isNone(authored)) inferred.add(span)
        if (inferenceType(type)) markAncestors(span.parent)
        finishAttributes(span, type)
        end(endTime, exit)
      }
      return span
    },
  })
}
