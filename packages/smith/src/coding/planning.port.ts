import { Context } from "effect"
import type { Effect } from "effect"
import type { AgentMessage, HarnessError, UserMessage } from "@xandreed/core"

export class SmithPlanning extends Context.Service<SmithPlanning, {
  readonly decide: (input: { readonly userMessage: UserMessage; readonly history: ReadonlyArray<AgentMessage> }) => Effect.Effect<{ readonly mode: "direct" | "plan"; readonly reason: string }, HarnessError>
}>()("smith/Planning") {}
