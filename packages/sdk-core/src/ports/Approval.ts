import { Context, Effect, Layer, Schema } from "effect"

/**
 * Human approval for consequential tool actions (today: bash). The port is the
 * *question*; policy lives in the implementation — the TUI asks with a modal,
 * headless modes answer statically from `--allow-bash`.
 *
 * The design constraint is prompt fatigue: a yes/no gate asked forty times an
 * hour trains a reflex, and the reflex is the vulnerability — the one command
 * that matters gets the same enter as the nineteen `bun test`s before it. So
 * the unit of approval is a **rule** ({@link ApprovalRequest.ruleKey}), and an
 * answer can eliminate future prompts (`session` / `project` scope). The
 * prompt rate decays toward "commands never blessed before", which is exactly
 * the set a human should be reading.
 *
 * Denial is **data the model reads**: a deny (with its optional reason) comes
 * back as an ordinary tool failure, so the model adjusts course inside the
 * same turn instead of dying or blindly retrying — the same recovery path as
 * `OutOfScope` and every other returned failure.
 */
// A Schema (not a bare interface): the daemon's `Workspace` protocol carries a
// pending approval to every client and an answer back, so the request/decision
// must serialize. The `.Type`s are structurally identical to the old
// interfaces, so every existing consumer is unchanged.
export const ApprovalRequest = Schema.Struct({
  /** The asking tool — `"Bash"` today. */
  tool: Schema.String,
  /** What will run, verbatim (the command). */
  summary: Schema.String,
  /** Where it will run. */
  cwd: Schema.String,
  /** The rule this request matches (see `bashRuleKey`) — what session/project allows key on. */
  ruleKey: Schema.String,
})
export type ApprovalRequest = typeof ApprovalRequest.Type

export const ApprovalDecision = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("allow"),
    scope: Schema.Literal("once", "session", "project"),
  }),
  Schema.Struct({
    kind: Schema.Literal("deny"),
    reason: Schema.optional(Schema.String),
  }),
)
export type ApprovalDecision = typeof ApprovalDecision.Type

export class Approval extends Context.Tag("@xandreed/sdk-core/Approval")<
  Approval,
  {
    readonly request: (
      req: ApprovalRequest,
    ) => Effect.Effect<ApprovalDecision>
  }
>() {}

/**
 * Static allow-everything policy — for headless modes (where `--allow-bash`
 * already encodes the human's standing decision) and evals/CI.
 */
export const ApprovalAllowAllLive = Layer.succeed(
  Approval,
  Approval.of({
    request: () => Effect.succeed({ kind: "allow", scope: "once" } as const),
  }),
)

/** Shell metacharacters that make a command's effect non-obvious from its head. */
const SHELL_META = /[|&;<>$`(){}\[\]*?!\\\n]/

/**
 * The rule a bash command matches for session/project allows.
 *
 * Granularity is the whole game: too coarse (`bash:*`) recreates unrestricted
 * shell one click at a time; too fine (exact commands) re-prompts on every
 * changed test path and recreates the rubber stamp. The landing spot:
 * command + subcommand (`cmd:bun test`, `cmd:git status`) — except a flag
 * second word collapses to the bare command (blessing `cmd:rm -rf` as a rule
 * would read as safer than it is), and anything carrying shell metacharacters
 * is `exact:` — a pipe or substitution can't be judged by its first words.
 */
export const bashRuleKey = (command: string): string => {
  const trimmed = command.trim().replace(/\s+/g, " ")
  if (SHELL_META.test(trimmed)) return `exact:${trimmed}`
  const [head, second] = trimmed.split(" ")
  if (head === undefined || head.length === 0) return `exact:${trimmed}`
  return second !== undefined && !second.startsWith("-")
    ? `cmd:${head} ${second}`
    : `cmd:${head}`
}
