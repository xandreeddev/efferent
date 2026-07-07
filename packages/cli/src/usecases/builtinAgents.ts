import type { AgentDefinition } from "@xandreed/sdk-core"
import { BUILTIN_RESEARCH_AGENTS } from "./researchAgents.js"
import { BUILTIN_TEAM_AGENTS } from "./teamAgents.js"

/**
 * Merge the built-in roles into the loaded ones. A workspace/home file role of
 * the same name WINS — built-ins only fill names not already defined.
 */
export const withBuiltinAgents = (
  loaded: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<AgentDefinition> => {
  const builtins: ReadonlyArray<AgentDefinition> = [
    ...BUILTIN_TEAM_AGENTS,
    ...BUILTIN_RESEARCH_AGENTS,
  ]
  const have = new Set(loaded.map((a) => a.name))
  return [...loaded, ...builtins.filter((b) => !have.has(b.name))]
}

// `stripLeads` (the direct-mode roster filter) lives in `@xandreed/sdk-core`
// (`usecases/roster.ts`), next to the `LEAD_AGENT_NAMES` list it keys on.
export { stripLeads } from "@xandreed/sdk-core"
