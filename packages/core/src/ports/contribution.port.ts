import { Context } from "effect"
import type { Effect, Layer, Option } from "effect"
import type { LanguageModel, Tool } from "@effect/ai"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { PromptTier, SkillDefinition, ToolAnnotations } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { Subject } from "../memory/memory-log.entity.js"

/** How one tool's result appears in context — owned by the tool, applied by memory. */
export interface ToolViewDefinition<Result, Params> {
  readonly version: string
  /** The exact text the model sees when the result is written. */
  readonly render: (result: Result, params: Params) => string
  /** The older-turn form; None keeps `render`'s text. */
  readonly compact: Option.Option<(result: Result, params: Params) => string>
  readonly subjects: (result: Result, params: Params) => ReadonlyArray<Subject>
}

/** The view as an author writes it; optional parts default in `defineTool`. */
export interface ToolViewInput<Result, Params> {
  readonly version: string
  readonly render: (result: Result, params: Params) => string
  readonly compact?: (result: Result, params: Params) => string
  readonly subjects?: (result: Result, params: Params) => ReadonlyArray<Subject>
}

/** A typed tool definition as its author writes it (see `defineTool`). */
export interface ToolDefinition<T extends Tool.Any, R> {
  readonly tool: T
  readonly handler: (params: Tool.Parameters<T>) => Effect.Effect<Tool.Success<T>, Tool.Failure<T>, R>
  readonly view: Option.Option<ToolViewDefinition<Tool.Success<T>, Tool.Parameters<T>>>
  readonly annotations: ToolAnnotations
}

/** The erased form the registry consumes; its requirements are provided per run. */
export interface RegisteredTool {
  readonly tool: Tool.Any
  readonly handler: (params: unknown) => Effect.Effect<unknown, unknown, unknown>
  readonly view: Option.Option<ToolViewDefinition<unknown, unknown>>
  readonly annotations: ToolAnnotations
}

export interface PromptContext {
  readonly variant: Option.Option<string>
  readonly active: ReadonlyArray<string>
  readonly skills: ReadonlyArray<SkillDefinition>
}

/** One section of the system prompt (static/session) or of the turn context (turn). */
export interface PromptSection {
  readonly id: string
  readonly version: string
  readonly tier: PromptTier
  readonly order: number
  readonly render: (context: PromptContext) => Effect.Effect<Option.Option<string>, HarnessError, unknown>
}

export interface StepInfo {
  readonly stepIndex: number
  readonly activeTools: ReadonlyArray<string>
  readonly lastUsage: Option.Option<TokenUsage>
}

export type ToolChoice = "required" | { readonly tool: string }

export interface StepDirective {
  /** Appended at the end of the context for this step only. */
  readonly context: Option.Option<string>
  readonly toolChoice: Option.Option<ToolChoice>
}

export interface ToolOutcome {
  readonly tool: string
  readonly invocationId: string
  readonly input: unknown
  readonly ok: boolean
  readonly encoded: unknown
}

export interface RunSummary {
  readonly outcome: "completed" | "partial"
  readonly text: string
}

export interface InitialBatch {
  readonly calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>
  /** Skills the batch needs, activated before it runs. */
  readonly skills: ReadonlyArray<string>
}

export interface ModelChoice {
  readonly model: LanguageModel.Service
  /** Selects a system-prompt variant; sections receive it. */
  readonly variant: Option.Option<string>
}

/** Host policy for a run. Every hook is optional; contributions merge in graph order. */
export interface RunHooks {
  /** Some(reply) answers the turn without a model call (still recorded). First Some wins. */
  readonly preflight: Option.Option<Effect.Effect<Option.Option<string>, HarnessError, unknown>>
  /** A host-planned first batch, run as step zero without a provider call. First Some wins. */
  readonly initialStep: Option.Option<Effect.Effect<Option.Option<InitialBatch>, HarnessError, unknown>>
  /** Model selection at each provider step. First Some wins. */
  readonly model: Option.Option<(step: StepInfo) => Effect.Effect<Option.Option<ModelChoice>, HarnessError, unknown>>
  /** Per-step context and tool choice. Contexts concatenate; the first tool choice wins. */
  readonly step: Option.Option<(step: StepInfo) => Effect.Effect<StepDirective, HarnessError, unknown>>
  /** Host completion; every contribution must agree. */
  readonly isComplete: Option.Option<(step: StepInfo) => Effect.Effect<boolean, never, unknown>>
  readonly onToolResult: Option.Option<(outcome: ToolOutcome) => Effect.Effect<void, never, unknown>>
  /** The delivered reply recorded for follow-up turns. First Some wins. */
  readonly reply: Option.Option<Effect.Effect<Option.Option<string>, never, unknown>>
  readonly settle: Option.Option<(summary: RunSummary) => Effect.Effect<void, HarnessError, unknown>>
  readonly correctives: Option.Option<{
    readonly malformed: (tools: ReadonlyArray<string>, description: string) => string
    readonly incomplete: string
  }>
}

/** One bundle a host (or a capability plugin) contributes. */
export interface Contribution {
  readonly id: string
  readonly version: string
  readonly tools: ReadonlyArray<RegisteredTool>
  readonly skills: ReadonlyArray<SkillDefinition>
  readonly sections: ReadonlyArray<PromptSection>
  /** Per-run services (built after RunContext, before the tools open). */
  readonly run: Option.Option<Layer.Layer<never, HarnessError, unknown>>
  readonly hooks: RunHooks
}

/** A MULTI-provider key: every contributor's bundle, in graph order. */
export class Contributions extends Context.Tag("efferent/Contributions")<Contributions, ReadonlyArray<Contribution>>() {}
