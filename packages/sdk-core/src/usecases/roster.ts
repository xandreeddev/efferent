import type { AgentDefinition } from "../entities/AgentDefinition.js"
import { LEAD_AGENT_NAMES } from "./buildScopeRuntime.js"

/**
 * Direct ("claude code") mode roster: drop the fleet LEADS so
 * `isOrchestrateMode` turns off and the root becomes the hands-on coder with
 * the full toolkit. Filters by the SAME `LEAD_AGENT_NAMES` list the mode
 * switch keys on, so the two can never drift. Deliberately applied AFTER any
 * built-in merge: a workspace-defined `coordinator.md` is removed too — any
 * surviving lead name would flip the root back to orchestrate.
 * Specialists/verifier stay (only the two lead names matter).
 */
export const stripLeads = (
  agents: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<AgentDefinition> => agents.filter((a) => !LEAD_AGENT_NAMES.includes(a.name))
