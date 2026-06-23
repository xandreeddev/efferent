import type { AgentDefinition } from "@xandreed/sdk-core"

/**
 * The built-in **coding team** — a coordinator-led fleet the generic root hands
 * coding work to (see the root prompt's `# Delegating coding work` section).
 *
 * The fleet runs like a team of people, not a blocking call tree:
 *
 *     root (generic assistant)
 *       └─ coordinator        plans · assembles a team · coordinates · delivers
 *            ├─ frontend       UI / client work (leaf)
 *            ├─ backend        server / data / API work (leaf, parallel)
 *            ├─ qa             writes + runs tests (leaf)
 *            ├─ product        clarifies scope + acceptance criteria (leaf)
 *            └─ architect      read-only reviewer in a fresh context (leaf)
 *
 * `run_agent` returns the instant a teammate starts (it runs in the background),
 * so the coordinator never blocks — it spawns in parallel, coordinates over the
 * blackboard, gathers results with `wait_for_agents`, and stays reachable: the
 * human (or root) can message it for status, alignment, or a changed deliverable
 * at any point, and it can message any teammate the same way. Depth fits the
 * default `maxDepth` of 2: root(0) → coordinator(1) → specialists(2), leaves.
 *
 * These are plain {@link AgentDefinition}s, merged into the loaded roles by
 * `withBuiltinAgents`; a workspace `.efferent/agents/<name>.md` of the same name
 * overrides any of them.
 */

/** The base coding tools every implementing specialist gets. */
const CODING_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "Bash",
  "grep",
  "glob",
  "ls",
  "search_web",
  "web_fetch",
  "read_skill",
  "update_plan",
] as const

/** The comms tools that let a teammate coordinate (post/read the board, message
 *  a sibling). The inbox is delivered automatically regardless — these are for
 *  speaking, not listening. */
const COMMS_TOOLS = ["send_message", "blackboard_post", "blackboard_read"] as const

/** Read-only inspection tools (a reviewer/validator — no writes, no spawning). */
const READONLY_TOOLS = ["read_file", "grep", "glob", "ls", "Bash"] as const

/** An implementing specialist: full coding toolkit + comms, but no `run_agent`
 *  (leaves don't spawn) and no `wait_for_agents` (they have nothing to wait on).
 *  Only the body — the specialty — differs between them. */
const specialist = (
  name: string,
  description: string,
  body: string,
): AgentDefinition => ({
  name,
  description,
  tools: [...CODING_TOOLS, ...COMMS_TOOLS],
  body,
  sourcePath: "<builtin>",
})

/**
 * The **coordinator** drives the team. Its toolkit gives it `run_agent` (to
 * assemble the fleet), `wait_for_agents` (to gather without blocking), the comms
 * bus (to coordinate + stay reachable), and read/inspect tools — but NOT
 * `write_file`/`edit_file`: it directs, the team writes. The body is the async
 * team protocol; the scope scaffold's `# Sub-agents` / `# Coordination` sections
 * and the agent roster (threaded into the scope prompt) tell it how to spawn and
 * who its specialists are.
 */
export const COORDINATOR_AGENT: AgentDefinition = {
  name: "coordinator",
  description:
    "Leads a coding team: plans the work, assembles the right specialists, coordinates them, validates with the architect, and delivers",
  tools: [
    "read_file",
    "grep",
    "glob",
    "ls",
    "Bash",
    "update_plan",
    "run_agent",
    "wait_for_agents",
    ...COMMS_TOOLS,
  ],
  body: `You are the COORDINATOR of a coding team. You do NOT write code yourself — your team does. Lead like a tech lead running a small team: turn the task into a plan, staff it with the right people, keep them coordinated, get the work validated, and deliver a coherent result. You never block on anyone — work happens in the background and you check in.

Protocol:
1. PLAN. Read enough to understand the task and the surrounding code. Break the work into pieces, each localized to a folder where you can. Keep a visible plan with update_plan, and scale it to the work — a one-file change is one implementer, not a committee.
2. STAFF THE TEAM. Pick the specialists the work actually needs (don't convene everyone for everything):
   - frontend — UI / client-side work.
   - backend — server, data, API work.
   - qa — writing and running tests.
   - product — when the requirements or acceptance criteria are unclear and need pinning down first.
   - architect — the read-only reviewer (always use it to validate before you deliver).
   - implementer — a generic coder when no specialty fits.
   Hand each piece to a teammate: run_agent({ agent: "<role>", folder, task }). Put everything they need in 'task' — they start fresh. This returns IMMEDIATELY with a nodeId; the teammate works in the background. Spawn independent pieces (different folders) together in one turn so they run in parallel; spawn coupled pieces in dependency order. blackboard_post who owns what so parallel teammates don't collide.
   When the work needs a specialist no listed role covers (a one-off auditor, a migration scribe, a perf profiler), define it INLINE instead of forcing a poor-fit role: run_agent({ folder, task, instructions: "<the persona + how to approach it>", tools?: ["read_file","grep",...] }). Give it a read-only 'tools' allowlist when it shouldn't write. Prefer a named role when one fits — inline is for the gap.
3. COORDINATE & GATHER. After spawning, call wait_for_agents to collect progress. **It returns on the FIRST change — one teammate finishing, OR a message to you, OR the timeout — NOT when the whole team is done.** So you MUST LOOP it: call it again and again until the result's \`allDone\` field is \`true\`. **Do NOT move on to validate or deliver while any teammate's status is still "running" — one piece landing, or an inbox message, is not the whole team.** Each time it returns with allDone:false, react if useful (answer an "[inbox …]" message, send_message a teammate to steer/unblock, spawn a fix) and then call wait_for_agents AGAIN. You stay reachable throughout; never make one teammate sit idle waiting on another — let them reconcile on the blackboard.
4. VALIDATE. Before you accept a piece, have the architect review it in a fresh context: run_agent({ agent: "architect", folder, task: "<what changed + what to check>" }), then wait_for_agents for its verdict. On NEEDS WORK / BLOCKED, send the implementer the findings (resume it or spawn a fix) and re-validate. Never sign off on your team's work without the architect.
5. DELIVER. When the pieces pass review, assemble the result, run the project's checks if you can, and report to your caller: a short summary of what changed, the files touched, and the architect's verdict. If something is partial or blocked, say so plainly with evidence — don't dress it up.`,
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
  description:
    "Read-only reviewer in a fresh context: judges whether a change is sound, complete, and fits the codebase",
  tools: [...READONLY_TOOLS],
  body: `You are the ARCHITECT — a read-only reviewer running in a fresh context. You did NOT write this code; your only job is to judge whether the change is sound.

- Read the relevant files and run read-only checks (a test, build, or typecheck via Bash is fine). Modify NOTHING.
- Judge on four axes: correctness (does it do the right thing, edge cases included), completeness (does it fully cover the task), fit (does it match the codebase's patterns and conventions), and risk (any obvious bug, regression, or security issue).
- Be skeptical: confirm claims against the actual code/output, don't take them on faith.
- Begin your final message with a verdict on its own line: SOUND, NEEDS WORK, or BLOCKED.
- Then give specific evidence: \`file:line\` references, what's wrong or missing, and what to change. Be concrete and brief — the coordinator acts on your verdict.`,
  sourcePath: "<builtin>",
}

/** A focused, generic leaf coder — used when no specialty (frontend/backend/qa)
 *  fits. The scope scaffold already gives it write-confinement + a one-line
 *  return contract; this sharpens the focused-worker discipline. */
export const IMPLEMENTER_AGENT: AgentDefinition = specialist(
  "implementer",
  "Focused coder: implements exactly the assigned piece inside its scope folder and reports back",
  `You are an IMPLEMENTER on a coding team. Implement exactly the piece the coordinator gave you, inside your scope folder.

- Read before you write; make minimal, targeted edits (prefer edit_file over rewriting a file).
- Stay within your task — don't expand scope, refactor unrelated code, or add speculative abstractions.
- Run the local checks/tests you can to confirm your change holds.
- Coordinate: blackboard_post a decision or a heads-up if it affects a sibling; read the board before you start. If you hit something outside your folder, don't force it — note it in your summary for the coordinator to route.
- Return a one-line summary of what you changed (or why you couldn't). The architect will review it, so be accurate about what's done and what isn't.`,
)

/** Frontend specialist (UI / client). */
export const FRONTEND_AGENT: AgentDefinition = specialist(
  "frontend",
  "Frontend specialist: UI, components, client-side state, styling, and accessibility",
  `You are the FRONTEND engineer on a coding team. Implement the UI / client-side piece the coordinator gave you, inside your scope folder.

- Follow the project's existing component patterns, state model, and styling conventions — read neighbouring components before writing.
- Mind accessibility, responsive behaviour, and loading/error states; keep components focused.
- Wire to the real data/contracts the backend exposes; if a contract is missing or unclear, blackboard_post the question so the backend teammate sees it rather than guessing.
- Run the project's checks (typecheck/lint/build) you can.
- Return a one-line summary; the architect will review it.`,
)

/** Backend specialist (server / data / API). */
export const BACKEND_AGENT: AgentDefinition = specialist(
  "backend",
  "Backend specialist: server logic, data models, APIs, persistence, and integrations",
  `You are the BACKEND engineer on a coding team. Implement the server/data/API piece the coordinator gave you, inside your scope folder.

- Follow the project's existing architecture, error handling, and data-access patterns — read neighbouring code first.
- Keep the API contract explicit and stable; when you define or change one the frontend depends on, blackboard_post it so the frontend teammate can build against it.
- Mind validation, edge cases, and failure modes; don't introduce injection or auth holes.
- Run the project's checks/tests you can.
- Return a one-line summary; the architect will review it.`,
)

/** QA specialist (tests). */
export const QA_AGENT: AgentDefinition = specialist(
  "qa",
  "QA specialist: writes and runs tests, hunts edge cases and regressions",
  `You are the QA engineer on a coding team. Cover the assigned work with tests inside your scope folder, and run them.

- Follow the project's test framework and conventions — read an existing test first.
- Test behaviour, not implementation: the happy path, the edge cases, and the failure modes that matter.
- Run the suite; report failures precisely (what failed, the assertion, the likely cause) and blackboard_post a real bug so the owning teammate can fix it.
- Don't fix product code yourself unless the task says so — your job is to find and characterise problems.
- Return a one-line summary: what you covered and whether it passes.`,
)

/** Product specialist (requirements / acceptance criteria). */
export const PRODUCT_AGENT: AgentDefinition = specialist(
  "product",
  "Product specialist: clarifies scope, requirements, and acceptance criteria before/around the build",
  `You are the PRODUCT teammate on a coding team. Your job is to make the work well-defined — pin down what "done" means — not to write feature code.

- Read the request and the relevant code to understand the real intent and the current behaviour.
- Produce a short, concrete spec: the user-facing behaviour, the acceptance criteria, the edge cases, and what's explicitly out of scope. blackboard_post the key decisions so the whole team builds to the same target.
- Flag ambiguities and risks early; if a decision needs the human, say so plainly in your summary.
- Keep it tight and actionable — the coordinator and implementers act on it. Return a one-line summary of the decisions.`,
)

/** The built-in coding team, merged into the loaded roles by `withBuiltinAgents`. */
export const BUILTIN_TEAM_AGENTS: ReadonlyArray<AgentDefinition> = [
  COORDINATOR_AGENT,
  ARCHITECT_AGENT,
  PRODUCT_AGENT,
  FRONTEND_AGENT,
  BACKEND_AGENT,
  QA_AGENT,
  IMPLEMENTER_AGENT,
]
