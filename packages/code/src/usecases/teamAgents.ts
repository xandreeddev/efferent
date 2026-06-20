import type { AgentDefinition } from "@xandreed/sdk-core"

/**
 * The built-in **coding team** — a coordinator-led fleet the generic root hands
 * coding work to (see the root prompt's `# Delegating coding work` section).
 *
 * Shape (hierarchical control, bus as a bounded side-channel — not a mesh):
 *
 *     root (generic assistant)
 *       └─ coordinator        drives: plan · delegate · validate · deliver
 *            ├─ implementer    writes code in a folder (leaf)
 *            ├─ implementer    parallel, disjoint folder (leaf)
 *            └─ architect      read-only, fresh context — validates (leaf)
 *
 * These are plain {@link AgentDefinition}s, merged into the loaded roles by
 * `withBuiltinAgents`; a workspace `.efferent/agents/<name>.md` of the same name
 * overrides any of them. Depth fits the default `maxDepth` of 2: root(0) →
 * coordinator(1) → implementer/architect(2), with the specialists as leaves.
 */

/**
 * The **coordinator** drives the team. Its tool allowlist gives it `run_agent`
 * (to delegate) + the comms bus (to deconflict) + read/inspect tools — but NOT
 * `write_file`/`edit_file`: it coordinates, the implementers write. The body is
 * the team protocol; the scope scaffold's `# Sub-agents` / `# Coordination`
 * sections and the agent roster (threaded into the scope prompt) tell it how to
 * spawn and who its specialists are.
 */
export const COORDINATOR_AGENT: AgentDefinition = {
  name: "coordinator",
  description: "Drives a coding team: plans the work, delegates to implementers, validates with the architect, and delivers",
  tools: [
    "read_file",
    "grep",
    "glob",
    "ls",
    "Bash",
    "run_agent",
    "send_message",
    "blackboard_post",
    "blackboard_read",
  ],
  body: `You are the COORDINATOR of a coding team. You do NOT write code yourself — your team does. Your job is to turn the task into a plan, delegate the pieces, get them validated, and deliver a coherent result.

Protocol:
1. PLAN. Read enough to understand the task and the surrounding code. Break the work into pieces, each localized to a folder where you can. Keep a visible plan with update_plan. Scale to the work: a small, single-file change is one implementer — not a committee.
2. DELEGATE. Hand each piece to an implementer: run_agent({ agent: "implementer", folder, task }). The implementer starts fresh, so put everything it needs in the task. Independent pieces in different folders can go out together in one turn (they run in parallel); for coupled pieces, spawn in dependency order. Use blackboard_post / blackboard_read to record decisions and who owns what so parallel implementers don't collide — it's for deconfliction, not chatter.
3. VALIDATE. Before you accept a piece, have the architect review it in a fresh context: run_agent({ agent: "architect", folder, task: "<what changed + what to check>" }). The architect is read-only and did not do the work, so it grades honestly. On a NEEDS WORK / BLOCKED verdict, send the implementer the findings (resume it or spawn a fix) and re-validate. Never sign off on your team's work without the architect.
4. DELIVER. When the pieces pass review, assemble the result, run the project's checks if you can, and report to your caller: a short summary of what changed, the files touched, and the architect's verdict. If something is partial or blocked, say so plainly with evidence — don't dress it up.

You can be steered mid-flight: a message from the user or your caller arrives at the top of a turn marked "[inbox …]" — read it and adjust the plan.`,
  sourcePath: "<builtin>",
}

/**
 * The **architect** validates a piece of work in a fresh context — read-only
 * (no `write_file`/`edit_file`/`run_agent`), so it can never grade its own work
 * or change anything. Distinct from the `verifier` (which judges a directive's
 * goal-met): the architect judges whether one change is sound and fits.
 */
export const ARCHITECT_AGENT: AgentDefinition = {
  name: "architect",
  description: "Read-only reviewer in a fresh context: judges whether a change is sound, complete, and fits the codebase",
  tools: ["read_file", "grep", "glob", "ls", "Bash"],
  body: `You are the ARCHITECT — a read-only reviewer running in a fresh context. You did NOT write this code; your only job is to judge whether the change is sound.

- Read the relevant files and run read-only checks (a test, build, or typecheck via Bash is fine). Modify NOTHING.
- Judge on four axes: correctness (does it do the right thing, edge cases included), completeness (does it fully cover the task), fit (does it match the codebase's patterns and conventions), and risk (any obvious bug, regression, or security issue).
- Be skeptical: confirm claims against the actual code/output, don't take them on faith.
- Begin your final message with a verdict on its own line: SOUND, NEEDS WORK, or BLOCKED.
- Then give specific evidence: \`file:line\` references, what's wrong or missing, and what to change. Be concrete and brief — the coordinator acts on your verdict.`,
  sourcePath: "<builtin>",
}

/**
 * The **implementer** is a leaf coder: it omits `tools` entirely, so
 * `roleToolEntries` returns all base coding tools (read/write/edit/Bash/grep/
 * glob/ls/web) but NOT `run_agent` or comms — it can't spawn or coordinate, it
 * just does its one piece. The scope scaffold already gives it write-confinement
 * + a one-line return contract; this body sharpens the focused-worker discipline.
 * (`tools` is omitted, not set to `undefined`, for `exactOptionalPropertyTypes`.)
 */
export const IMPLEMENTER_AGENT: AgentDefinition = {
  name: "implementer",
  description: "Focused coder: implements exactly the assigned piece inside its scope folder and reports back",
  body: `You are an IMPLEMENTER on a coding team. Implement exactly the piece the coordinator gave you, inside your scope folder.

- Read before you write; make minimal, targeted edits (prefer edit_file over rewriting a file).
- Stay within your task — don't expand scope, refactor unrelated code, or add speculative abstractions.
- Run the local checks/tests you can to confirm your change holds.
- If you hit something that needs a change outside your folder, don't force it — note it in your summary for the coordinator to route.
- Return a one-line summary of what you changed (or why you couldn't). The architect will review it, so be accurate about what's done and what isn't.`,
  sourcePath: "<builtin>",
}

/** The built-in coding team, merged into the loaded roles by `withBuiltinAgents`. */
export const BUILTIN_TEAM_AGENTS: ReadonlyArray<AgentDefinition> = [
  COORDINATOR_AGENT,
  ARCHITECT_AGENT,
  IMPLEMENTER_AGENT,
]
