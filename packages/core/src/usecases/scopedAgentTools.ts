import { Effect, Schema } from "effect"
import { type AgentTool, AgentToolError } from "../entities/AgentTool.js"
import type { ScopedAgentConfig } from "../entities/ScopedAgent.js"
import type { FileSystem } from "../ports/FileSystem.js"
import type { Llm } from "../ports/Llm.js"
import type { Shell } from "../ports/Shell.js"
import { runScopedAgent } from "./runScopedAgent.js"

const DelegationInput = Schema.Struct({
  task: Schema.String.annotations({
    description:
      "The focused task for the sub-agent: what you want changed, and any constraints. The sub-agent has no prior context — be explicit.",
  }),
})

/**
 * Build a `delegate_to_<name>` tool that, when invoked, spawns a fresh
 * scoped agent loop with the given config and returns the sub-agent's
 * one-line summary + the list of files it actually wrote.
 *
 * From the parent's perspective this is one tool call. Internally the
 * sub-agent may take many turns; those turns do NOT fire the parent's
 * hooks (no scrollback noise, no token-gauge updates), so the TUI
 * shows one opaque pill while the delegation runs.
 */
export const buildScopedAgentDelegationTool = (
  config: ScopedAgentConfig,
): AgentTool<any, any, FileSystem | Shell | Llm> => ({
  name: `delegate_to_${config.name}`,
  description:
    `Delegate a focused task to the '${config.name}' sub-agent. ${config.description} ` +
    `The sub-agent runs in a fresh context window — it sees only the task you pass, plus its own scope-specific instructions. ` +
    `It can read anywhere in the workspace but writes only inside its scope. ` +
    `Returns { summary, filesChanged }.`,
  parameters: DelegationInput,
  execute: ({ task }: { task: string }) =>
    runScopedAgent(config, task).pipe(
      Effect.mapError(
        (cause) =>
          new AgentToolError({
            tool: `delegate_to_${config.name}`,
            cause,
          }),
      ),
    ),
})
