import { LEAD_AGENT_NAMES, type AgentDefinition } from "@xandreed/sdk-core"
import { BUILTIN_RESEARCH_AGENTS, builtinResearchAgents } from "./researchAgents.js"
import { BUILTIN_TEAM_AGENTS, builtinTeamAgents } from "./teamAgents.js"

// The `Directive` type + its pure `parseDirective`/`renderDirectiveSection`
// helpers moved to `@xandreed/sdk-core` (`entities/Directive.ts`) — the daemon
// persists the directive and the `Workspace` protocol carries it on the wire,
// so the Schema must live in core. Re-exported here so existing
// `import … from "../usecases/directive.js"` consumers are unchanged. The
// agent-definition side (the verifier role) stays below.
export { Directive, parseDirective, renderDirectiveSection } from "@xandreed/sdk-core"

/**
 * Built-in **verifier** role: a strict, read-only judge spawned in a fresh
 * context (no memory of the work) to decide whether a goal is actually met.
 * Always available (merged into the loaded roles by {@link withBuiltinAgents});
 * a workspace `.efferent/agents/verifier.md` overrides it.
 */
export const VERIFIER_AGENT: AgentDefinition = {
  name: "verifier",
  description: "Strict read-only judge: decides whether a goal/directive is actually met, in a fresh context",
  // Judging/verifying is reasoning work — runs on the general model.
  role: "general",
  tools: ["read_file", "grep", "glob", "ls", "Bash"],
  body: `You are a strict goal VERIFIER running in a fresh context — you did not do the work, and your only job is to judge whether the stated objective is genuinely met, from evidence.

- Read the relevant files; run read-only checks (a test or build via Bash is fine). Do NOT modify anything.
- Be skeptical: do not take any prior claim at face value — confirm it against the actual code/output.
- Begin your final message with a verdict on its own line: MET, NOT MET, or INCONCLUSIVE.
- Then give specific evidence: \`file:line\` references, test/build output, what's missing.`,
  sourcePath: "<builtin>",
}

/**
 * Merge the built-in roles into the loaded ones. A workspace/home file role of
 * the same name WINS (so users can customise the verifier) — built-ins only
 * fill names not already defined. `loopOpts` (from settings) shapes the
 * coordinator: `autoLoop` toggles the Opus gate + learn/retry phase, and
 * `maxLoopAttempts` sets the gate-round cap (see {@link builtinTeamAgents}).
 * Omitted ⇒ the default team (loop on, 3-round cap).
 */
export const withBuiltinAgents = (
  loaded: ReadonlyArray<AgentDefinition>,
  loopOpts?: { readonly autoLoop: boolean; readonly maxLoopAttempts: number },
): ReadonlyArray<AgentDefinition> => {
  const team = loopOpts === undefined ? BUILTIN_TEAM_AGENTS : builtinTeamAgents(loopOpts)
  const research =
    loopOpts === undefined ? BUILTIN_RESEARCH_AGENTS : builtinResearchAgents(loopOpts)
  const builtins: ReadonlyArray<AgentDefinition> = [
    VERIFIER_AGENT,
    ...team,
    ...research,
  ]
  const have = new Set(loaded.map((a) => a.name))
  return [...loaded, ...builtins.filter((b) => !have.has(b.name))]
}

/**
 * Direct ("claude code") mode roster: drop the fleet LEADS so
 * `isOrchestrateMode` turns off and the root becomes the hands-on coder with
 * the full toolkit. Filters by the SAME `LEAD_AGENT_NAMES` list the mode
 * switch keys on (exported by core), so the two can never drift. Deliberately
 * applied AFTER the built-in merge: a workspace-defined `coordinator.md` is
 * removed too — any surviving lead name would flip the root back to
 * orchestrate. Specialists/verifier stay (only the two lead names matter).
 */
export const stripLeads = (
  agents: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<AgentDefinition> => agents.filter((a) => !LEAD_AGENT_NAMES.includes(a.name))
