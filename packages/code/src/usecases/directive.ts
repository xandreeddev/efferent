import type { AgentDefinition } from "@xandreed/sdk-core"
import { BUILTIN_TEAM_AGENTS } from "./teamAgents.js"

/**
 * Phase 4 — a **directive** is a standing goal for the session: an objective the
 * agent pursues across turns (vs. a one-shot prompt), plus optional acceptance
 * criteria. It's injected into the agent's system prompt each turn and checked
 * by a separate-context verifier (the lead-researcher pattern — the judge never
 * graded its own work). v1 is session-scoped (in the runtime); persisting it
 * across resume is a deferred follow-up.
 */
export interface Directive {
  readonly objective: string
  readonly criteria?: string
}

/** Parse a `:goal` argument: `<objective>` or `<objective> :: <criteria>`. */
export const parseDirective = (arg: string): Directive | undefined => {
  const t = arg.trim()
  if (t.length === 0) return undefined
  const sep = t.indexOf("::")
  if (sep === -1) return { objective: t }
  const objective = t.slice(0, sep).trim()
  const criteria = t.slice(sep + 2).trim()
  return objective.length === 0
    ? undefined
    : { objective, ...(criteria.length > 0 ? { criteria } : {}) }
}

/** The standing-goal section appended to the root agent's prompt while a
 *  directive is set. Empty when none. */
export const renderDirectiveSection = (d: Directive | undefined): string =>
  d === undefined
    ? ""
    : `

# Directive (standing goal)
Pursue this across every turn until it's met — weigh each action against it:
${d.objective}${d.criteria !== undefined ? `\nDone when: ${d.criteria}` : ""}
When you believe it's met, say so with the evidence and suggest the human run :verify — a fresh agent will check independently. Never claim it's done without evidence.`

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
