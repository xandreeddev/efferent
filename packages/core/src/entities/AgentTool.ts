import { Data, type Effect, type Schema } from "effect"

export class AgentToolError extends Data.TaggedError("AgentToolError")<{
  readonly tool: string
  readonly cause: unknown
}> {}

/**
 * A capability the agent can invoke. Pure data: the `execute` Effect carries
 * its requirements `R` in the type, so the LLM adapter can run it inside the
 * caller's runtime without the adapter knowing what the requirements are.
 */
export interface AgentTool<I, O, R = never> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Schema<I, any>
  readonly execute: (input: I) => Effect.Effect<O, AgentToolError, R>
}
