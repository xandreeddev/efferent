import { Schema } from "effect"

/**
 * A **directive** is a standing goal for a session: an objective the agent
 * pursues across turns (vs. a one-shot prompt), plus optional acceptance
 * criteria. Injected into the system prompt each turn and checked by a
 * separate-context verifier.
 *
 * Lives in sdk-core (not the `code` package) because the daemon persists it and
 * the `Workspace` protocol carries it across the wire — both need the Schema.
 * The agent-definition side (the verifier role, `withBuiltinAgents`) stays in
 * `@xandreed/code`'s `usecases/directive.ts`, which re-exports this.
 */
export const Directive = Schema.Struct({
  objective: Schema.String,
  criteria: Schema.optional(Schema.String),
})
export type Directive = typeof Directive.Type

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
