import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { LanguageModel, Tool } from "effect/ai"
import type { AgentMessage } from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { PromptTier, SkillDefinition, ToolAnnotations } from "../harness/capability.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { ArtifactRef, Subject } from "../memory/memory-log.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"

/**
 * How a tool's long result may be digested for the current user message, with the
 * tool's own prompt. The memory strategy decides WHEN (on write above a size,
 * or at compaction); the digester runs it; the outcome is logged once.
 * `Select` (preferred) keeps whole items by key and re-renders them, so every
 * identifier the answer may cite survives. `Summarize` is accepted only when
 * every `preserve`d identifier appears verbatim in the summary.
 */
export type DigestDefinition<Result, Params> =
  | {
    readonly _tag: "Select"
    readonly version: string
    readonly instructions: string
    readonly items: (result: Result) => ReadonlyArray<{ readonly key: string; readonly text: string }>
    readonly render: (result: Result, params: Params, keep: ReadonlyArray<string>) => string
  }
  | {
    readonly _tag: "Summarize"
    readonly version: string
    readonly instructions: string
    readonly preserve: (result: Result) => ReadonlyArray<string>
  }

/** How one tool's result appears in context — owned by the tool, applied by memory. */
export interface ToolViewDefinition<Result, Params> {
  readonly version: string
  /** The exact text the model sees when the result is written. */
  readonly render: (result: Result, params: Params) => string
  /** The older-turn form; None keeps `render`'s text. */
  readonly compact: Option.Option<(result: Result, params: Params) => string>
  readonly subjects: (result: Result, params: Params) => ReadonlyArray<Subject>
  /** Files and images the result carries, kept by reference. */
  readonly artifacts: (result: Result, params: Params) => ReadonlyArray<ArtifactRef>
  readonly digest: Option.Option<DigestDefinition<Result, Params>>
}

/** The view as an author writes it; optional parts default in `defineTool`. */
export interface ToolViewInput<Result, Params> {
  readonly version: string
  readonly render: (result: Result, params: Params) => string
  readonly compact?: (result: Result, params: Params) => string
  readonly subjects?: (result: Result, params: Params) => ReadonlyArray<Subject>
  readonly artifacts?: (result: Result, params: Params) => ReadonlyArray<ArtifactRef>
  readonly digest?: DigestDefinition<Result, Params>
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

export interface InitialBatch {
  readonly calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>
  /** Skills the batch needs, activated before it runs. */
  readonly skills: ReadonlyArray<string>
}

export interface ModelChoice {
  readonly model: LanguageModel.LanguageModel
  /** Selects a system-prompt variant; sections receive it. */
  readonly variant: Option.Option<string>
}

/** One bundle a host (or a capability plugin) contributes. */
export interface Capability {
  readonly id: string
  readonly version: string
  readonly tools: ReadonlyArray<RegisteredTool>
  readonly skills: ReadonlyArray<SkillDefinition>
  readonly promptSections: ReadonlyArray<PromptSection>
}

/** A MULTI-provider key: every contributor's bundle, in graph order. */
export class Capabilities extends Context.Service<Capabilities, ReadonlyArray<Capability>>()("efferent/Capabilities") {}

export interface IntentMatch {
  readonly skills: ReadonlyArray<string>
  readonly probabilities: Option.Option<Readonly<Record<string, number>>>
  /** The matcher declined to choose; the turn runs on always-on skills. */
  readonly abstained: boolean
}

/** Pre-turn skill selection. Probabilistic intent never authorizes: the registry resolves grants. */
export class IntentMatcher extends Context.Service<IntentMatcher, {
  readonly id: string
  readonly version: string
  readonly match: (input: {
    readonly userMessage: UserMessage
    readonly skills: ReadonlyArray<SkillDefinition>
    readonly active: ReadonlyArray<string>
    /** A reference transcript: user messages and replies only. */
    readonly history: ReadonlyArray<AgentMessage>
  }) => Effect.Effect<IntentMatch, HarnessError>
}>()("efferent/IntentMatcher") {}
