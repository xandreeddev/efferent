import type { AgentDefinition } from "@xandreed/sdk-core"
import { BUILTIN_TEAM_AGENTS } from "./teamAgents.js"

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
  tools: ["read_file", "grep", "glob", "ls", "Bash"],
  body: `You are a strict goal VERIFIER running in a fresh context — you did not do the work, and your only job is to judge whether the stated objective is genuinely met, from evidence.

- Read the relevant files; run read-only checks (a test or build via Bash is fine). Do NOT modify anything.
- Be skeptical: do not take any prior claim at face value — confirm it against the actual code/output.
- Begin your final message with a verdict on its own line: MET, NOT MET, or INCONCLUSIVE.
- Then give specific evidence: \`file:line\` references, test/build output, what's missing.`,
  sourcePath: "<builtin>",
}

const BUILTINS: ReadonlyArray<AgentDefinition> = [VERIFIER_AGENT, ...BUILTIN_TEAM_AGENTS]

/**
 * Merge the built-in roles into the loaded ones. A workspace/home file role of
 * the same name WINS (so users can customise the verifier) — built-ins only
 * fill names not already defined.
 */
export const withBuiltinAgents = (
  loaded: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<AgentDefinition> => {
  const have = new Set(loaded.map((a) => a.name))
  return [...loaded, ...BUILTINS.filter((b) => !have.has(b.name))]
}
