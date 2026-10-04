import { sessionsPlugin } from "@xandreed/plugin-sessions"
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
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { smithCapabilitiesPlugin } from "./coding/capabilities.adapter.js"
import { smithCodingPlugin } from "./coding/coding.plugin.adapter.js"
import { SMITH_EFFECT_MODULE_IDS, smithEffectPlugin } from "./coding/effect-modules.adapter.js"
import { smithPlanningPlugin } from "./planning/jev.adapter.js"

export const SMITH_SYSTEM = `You are Smith, a careful software engineering agent.
Work directly on the user's task. Answer ordinary conversation directly.
Use tools when the request needs workspace facts, edits or verification.
Inspect the workspace and its AGENTS.md or
CLAUDE.md instructions before making changes. Preserve unrelated user changes.
Use tools to establish facts, make focused changes, and run relevant checks.
Explain the result and any remaining limitations. Never claim an unrun check
passed. Ask for missing decisions only when they materially affect the work.
Delegate source edits to the focused editor, review and apply its proposals,
then verify with read-only workspace commands. Preserve useful workspace facts
in the session; never include secrets in a summary.
Keep progress updates brief and show uncertainty honestly.`

export const smithAgent = (
  workspace: string,
  approve: (description: string) => Effect.Effect<boolean, HarnessError> = () => Effect.succeed(false),
) => defineAgent({
  id: "smith",
  plugins: [approvalPlugin(approve), sessionSqlitePlugin, sessionsPlugin, modelsPlugin, memoryPlugin, contextPlugin,
    workspacePolicyPlugin, mcpPlugin, toolsLocalPlugin, agentLoopPlugin, telemetryPlugin, smithWorkerPlugin, smithWorkflowPlugin,
    memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, smithCapabilitiesPlugin, smithCodingPlugin, smithEffectPlugin, smithPlanningPlugin],
  config: {
    version: 1,
    profile: "smith",
    system: SMITH_SYSTEM,
    plugins: [
      { id: "approval", use: "efferent/approval-host" },
      { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(workspace, ".efferent/runtime/sessions.db") } },
      { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
      { id: "models", use: modelsPlugin.id },
      { id: "memory", use: memoryWindowPlugin.id },
      { id: "policy", use: workspacePolicyPlugin.id },
      { id: "mcp", use: mcpPlugin.id },
      { id: "tools", use: smithCapabilitiesPlugin.id },
      { id: "registry", use: toolDiscoveryPlugin.id },
      { id: "steps", use: stepLoopPlugin.id },
      { id: "effect", use: smithEffectPlugin.id },
      { id: "planning", use: smithPlanningPlugin.id },
      { id: "loop", use: smithCodingPlugin.id },
      { id: "telemetry", use: telemetryPlugin.id },
      { id: "worker", use: smithWorkerPlugin.id, enabled: false },
      { id: "workflow", use: smithWorkflowPlugin.id, enabled: false },
    ],
    profiles: {
      smith: {},
      plan: { plugins: [{ id: "loop", use: smithCodingPlugin.id, options: { readOnly: true } }] },
      effect: { plugins: [{ id: "loop", use: smithCodingPlugin.id, options: { modules: [...SMITH_EFFECT_MODULE_IDS] } }] },
    },
  },
})
