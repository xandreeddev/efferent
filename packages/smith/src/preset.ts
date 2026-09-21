import { smithWorkerPlugin, smithWorkflowPlugin } from "./workflow.plugin.js"
import { join } from "node:path"
import { Effect } from "effect"
import { approvalPlugin, defineAgent } from "@xandreed/sdk"
import type { HarnessError } from "@xandreed/core"
import { agentLoopPlugin } from "@xandreed/plugin-agent-loop"
import { contextPlugin } from "@xandreed/plugin-context"
import { memoryPlugin } from "@xandreed/plugin-memory"
import { modelsPlugin } from "@xandreed/plugin-models"
import { mcpPlugin } from "@xandreed/plugin-mcp"
import { workspacePolicyPlugin } from "@xandreed/plugin-policy-workspace"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { telemetryPlugin } from "@xandreed/plugin-telemetry"
import { toolsLocalPlugin } from "@xandreed/plugin-tools-local"

export const SMITH_SYSTEM = `You are Smith, a careful software engineering agent.
Work directly on the user's task. Inspect the workspace and its AGENTS.md or
CLAUDE.md instructions before making changes. Preserve unrelated user changes.
Use tools to establish facts, make focused changes, and run relevant checks.
Explain the result and any remaining limitations. Never claim an unrun check
passed. Ask for missing decisions only when they materially affect the work.
The Bash tool is confined to the workspace and has no network. Use
external_command only when host access or publishing is necessary; it requires
the user's approval. Use remember for useful factual lessons, never secrets.
Keep progress updates brief and show uncertainty honestly.`

export const smithAgent = (
  workspace: string,
  approve: (description: string) => Effect.Effect<boolean, HarnessError> = () => Effect.succeed(false),
) => defineAgent({
  id: "smith",
  plugins: [approvalPlugin(approve), sessionSqlitePlugin, modelsPlugin, memoryPlugin, contextPlugin,
    workspacePolicyPlugin, mcpPlugin, toolsLocalPlugin, agentLoopPlugin, telemetryPlugin, smithWorkerPlugin, smithWorkflowPlugin],
  config: {
    version: 1,
    profile: "smith",
    system: SMITH_SYSTEM,
    plugins: [
      { id: "approval", use: "efferent/approval-host" },
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(workspace, ".efferent/runtime/sessions.db") } },
      { id: "models", use: modelsPlugin.id },
      { id: "memory", use: memoryPlugin.id },
      { id: "context", use: contextPlugin.id },
      { id: "policy", use: workspacePolicyPlugin.id },
      { id: "mcp", use: mcpPlugin.id },
      { id: "tools", use: toolsLocalPlugin.id },
      { id: "loop", use: agentLoopPlugin.id },
      { id: "telemetry", use: telemetryPlugin.id },
      { id: "worker", use: smithWorkerPlugin.id, enabled: false },
      { id: "workflow", use: smithWorkflowPlugin.id, enabled: false },
    ],
    profiles: {
      smith: {},
      plan: { system: `${SMITH_SYSTEM}\nPlanning mode: inspect and propose a concrete plan. Source mutation and shell tools are unavailable.`, plugins: [{ id: "tools", use: toolsLocalPlugin.id, options: { readOnly: true } }] },
    },
  },
})
