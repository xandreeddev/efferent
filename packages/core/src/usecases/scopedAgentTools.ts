import { Effect, Schema } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
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
 * Build a `delegate_to_<name>` tool. When `parentHooks` is passed in,
 * the sub-agent emits `onSubAgentStart`/`onSubAgentEnd` via those hooks
 * and its inner tool calls fire the parent's tool-call hooks — so the
 * parent TUI's side pane can show what the sub-agent is doing live.
 */
export const buildScopedAgentDelegationTool = <R = never>(
  config: ScopedAgentConfig,
  parentHooks?: AgentHooks<R>,
): AgentTool<any, any, FileSystem | Shell | Llm | R> => ({
  name: `delegate_to_${config.name}`,
  description:
    `Delegate a focused task to the '${config.name}' sub-agent. ${config.description} ` +
    `The sub-agent runs in a fresh context window — it sees only the task you pass, plus its own scope-specific instructions. ` +
    `It can read anywhere in the workspace but writes only inside its scope. ` +
    `Returns { summary, filesChanged }.`,
  parameters: DelegationInput,
  execute: ({ task }: { task: string }) =>
    runScopedAgent(config, task, parentHooks).pipe(
      Effect.mapError(
        (cause) =>
          new AgentToolError({
            tool: `delegate_to_${config.name}`,
            cause,
          }),
      ),
    ),
})
