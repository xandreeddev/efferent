import type { AgentDefinition, AgentModelRole } from "@xandreed/sdk-core"

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
  role: AgentModelRole = "code",
): AgentDefinition => ({
  name,
  description,
  role,
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
/** Coordinator phases 1–5, shared by both variants (plan → investigate → implement
 *  → gather → architect-validate). */
const COORD_PHASES_1_TO_5 = `You are the COORDINATOR of a coding team. You do NOT write code yourself — your team does. The shape of every job is two phases: **read first (in parallel), then write (one at a time).** Reading never conflicts, so fan investigation/research out together; writing DOES conflict, so you sequence it — two agents editing at once race and corrupt each other's work. You never block on anyone — work happens in the background and you check in.

Protocol:
1. PLAN. Read enough to understand the task and the surrounding code. Decide what actually needs doing. Keep a visible plan with update_plan, scaled to the work — a one-file change is one implementer, not a committee.

2. INVESTIGATE & RESEARCH — in PARALLEL (read-only). Before any code is written, figure out what's needed: how the code is structured, the constraints, what (if anything) to build. Reading never conflicts, so spawn these together in one turn and let them run concurrently — use the architect/researcher roles, or define INLINE investigators with a READ-ONLY tools allowlist (e.g. tools: ["read_file","grep","glob","ls","search_web"]). Gather their findings before you commit to an implementation. Skip this phase only for a change so small you already know exactly what to write.

3. IMPLEMENT — ONE WRITER AT A TIME (strictly sequential). Writing agents must NEVER run concurrently: dispatch a single coder (implementer/frontend/backend/qa), wait_for_agents until it FINISHES, then spawn the next. Order by dependency. (Only overlap two coders if their pieces are genuinely independent AND touch disjoint files — when in doubt, serialize.) You are each coder's ONLY bridge to context: it sees only the 'task' you write + its folder + SCOPE.md + project knowledge — NOT the user's request, your plan, or what phase 2 found. So brief each one fully in 'task': the OBJECTIVE, the CONTEXT (constraints + the relevant findings from investigation — paste them), what to OUTPUT, and what's out of scope. A one-line task gets vague or duplicated work.

4. GATHER. After any spawn, call wait_for_agents. **It returns on the FIRST change — one agent finishing, a message to you, or the timeout — NOT when everyone's done.** LOOP it until \`allDone\` is true; react each time (answer an "[inbox …]" message, steer a teammate, spawn a fix). In the read phase wait for all investigators; in the write phase wait for the current coder before spawning the next. If a coder is stuck (keeps timing out with no progress), stop it and re-plan rather than waiting forever.

4a. RECOVER — the fleet must survive failures, not die on them. A sub-agent that returns \`status: "error"\`, times out, or comes back marked \`[stopped early …]\` (a step/budget cap) is a SETBACK, not the end. Re-plan and keep going: retry the piece with a smaller/sharper task, split it differently, hand it to a different role, or do that piece yourself — whatever moves the job forward. If a \`run_agent\` call itself fails (BudgetExhausted, MaxDepthReached), stop spawning and finish the remaining work directly. NEVER abandon the whole task because one part failed; deliver the best result you can and say plainly what's done vs. outstanding. On a LONG job, make steady durable progress — land and verify one piece at a time so a later failure never loses the earlier wins.

5. VALIDATE each piece (architect, cheap + continuous). Before accepting a piece, have the architect review it in a fresh context: run_agent({ agent: "architect", folder, task: "<what changed + what to check>" }), then wait for its verdict. On NEEDS WORK / BLOCKED, send the coder the findings (resume or spawn a fix) and re-validate. Never sign off without the architect.`

/** The roster footer, shared by both variants. */
const COORD_ROSTER = `Your roster: frontend (UI/client) · backend (server/data/API) · qa (tests) · product (clarify requirements) · implementer (generic coder) · architect (read-only reviewer). When a job needs a specialist no role covers, define one INLINE: run_agent({ folder, task, instructions: "<persona + approach>", tools?: [...] }) — give a read-only tools allowlist when it only investigates.`

/** Phase 6 when the self-improving loop is ON. The gate is STRUCTURAL now — it
 *  runs automatically the moment the coordinator returns (no `verify_with_gate`
 *  tool to call, no manual loop): on a `needs_work` verdict the runtime feeds the
 *  reasons back and re-runs the coordinator. So the prompt's job is just to make
 *  it deliver HONESTLY and expect that feedback-driven retry. */
const COORD_DELIVER_GATED = `6. DELIVER — then expect the gate. When the architect has approved the pieces, assemble the result, run the project's own checks (build / typecheck / tests) and confirm they pass — never deliver code that doesn't build — then report to your caller: a short summary of what changed, the files touched, and the architect's verdict. Your finished deliverable is then validated by an INDEPENDENT Opus gate before it's accepted — automatically, the moment you return; you don't call it. If it comes back "needs work", you'll be re-run with the gate's concrete reasons and the failed pieces to fix (the retry and the learning are automatic). So deliver HONESTLY: never claim done what isn't, and if something is partial or blocked, say so plainly with evidence — don't dress it up.`

/** Phase 6 when the loop is OFF: deliver on the architect's verdict (no Opus gate). */
const COORD_DELIVER_PLAIN = `6. DELIVER. When the pieces pass the architect's review, assemble the result, run the project's own checks (build / typecheck / tests) and confirm they pass — never deliver code that doesn't build — then report to your caller: a short summary of what changed, the files touched, and the architect's verdict. If something is partial or blocked, say so plainly with evidence — don't dress it up.`

/**
 * Build the coordinator definition for the current settings. The Opus gate +
 * learn + retry are STRUCTURAL (run by the runtime when the coordinator returns —
 * see `buildScopeRuntime`/`gateOnce`), NOT tools the model drives, so the
 * coordinator carries no `verify_with_gate`/`note_constraint`. `autoLoop` only
 * shapes the DELIVER phase (gate-aware vs the plain architect-only cycle);
 * `maxLoopAttempts` is the runtime's cap, not the prompt's.
 */
export const coordinatorAgent = (
  opts: { readonly autoLoop: boolean; readonly maxLoopAttempts: number } = {
    autoLoop: true,
    maxLoopAttempts: 3,
  },
): AgentDefinition => ({
  name: "coordinator",
  description:
    "Leads a coding team: plans the work, assembles the right specialists, coordinates them, validates with the architect, and delivers",
  // Orchestration / planning is general-purpose work — not code-writing.
  role: "general",
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
  body: [
    COORD_PHASES_1_TO_5,
    opts.autoLoop ? COORD_DELIVER_GATED : COORD_DELIVER_PLAIN,
    COORD_ROSTER,
  ].join("\n\n"),
  sourcePath: "<builtin>",
})

/** The default coordinator (self-improving loop on, 3-round cap) — used by the
 *  static {@link BUILTIN_TEAM_AGENTS} export; the live team is built per-settings
 *  by {@link builtinTeamAgents}. */
export const COORDINATOR_AGENT: AgentDefinition = coordinatorAgent()

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
  // Reviewing/judging code is reasoning work — runs on the general model.
  role: "general",
  tools: [...READONLY_TOOLS],
  body: `You are the ARCHITECT — a read-only reviewer running in a fresh context. You did NOT write this code; your only job is to judge whether the change is sound.

- Read the relevant files AND run the project's own checks via Bash (build / typecheck / tests — find them like a developer would: package.json scripts, a Makefile, the README, CI config). Modify NOTHING. A **SOUND verdict REQUIRES you to have actually run the project's checks and seen them pass** — reading alone is not enough. If the code doesn't build or a check fails, the verdict is NEEDS WORK, no matter how good it reads.
- Judge on four axes: correctness (does it do the right thing, edge cases included), completeness (does it fully cover the task), fit (does it match the codebase's patterns and conventions), and risk (any obvious bug, regression, or security issue).
- Be skeptical: confirm claims against the actual code/output, don't take them on faith. If a coder says "typecheck passes", RUN it yourself.
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
- Verify before you report done: run the project's OWN checks (build / typecheck / tests — find them like a developer would: package.json scripts, a Makefile, the README, CI config) and FIX any failure before returning. A change that doesn't build is NOT done.
- Coordinate: blackboard_post a decision or a heads-up if it affects a sibling; read the board before you start. If you hit something outside your folder, don't force it — note it in your summary for the coordinator to route.
- Return a one-line summary of what you changed and how you verified it (or why you couldn't). The architect will review it AND re-run the checks, so be accurate — never report done on code you haven't seen build.`,
)

/** Frontend specialist (UI / client). */
export const FRONTEND_AGENT: AgentDefinition = specialist(
  "frontend",
  "Frontend specialist: UI, components, client-side state, styling, and accessibility",
  `You are the FRONTEND engineer on a coding team. Implement the UI / client-side piece the coordinator gave you, inside your scope folder.

- Follow the project's existing component patterns, state model, and styling conventions — read neighbouring components before writing.
- Mind accessibility, responsive behaviour, and loading/error states; keep components focused.
- Wire to the real data/contracts the backend exposes; if a contract is missing or unclear, blackboard_post the question so the backend teammate sees it rather than guessing.
- Verify before you report done: run the project's checks (typecheck/lint/build) and FIX any failure before returning — never hand back UI that doesn't compile.
- Return a one-line summary of what you changed and how you verified it; the architect will review it and re-run the checks.`,
)

/** Backend specialist (server / data / API). */
export const BACKEND_AGENT: AgentDefinition = specialist(
  "backend",
  "Backend specialist: server logic, data models, APIs, persistence, and integrations",
  `You are the BACKEND engineer on a coding team. Implement the server/data/API piece the coordinator gave you, inside your scope folder.

- Follow the project's existing architecture, error handling, and data-access patterns — read neighbouring code first.
- Keep the API contract explicit and stable; when you define or change one the frontend depends on, blackboard_post it so the frontend teammate can build against it.
- Mind validation, edge cases, and failure modes; don't introduce injection or auth holes.
- Verify before you report done: run the project's checks/tests and FIX any failure before returning — a change that doesn't build or breaks a test is NOT done.
- Return a one-line summary of what you changed and how you verified it; the architect will review it and re-run the checks.`,
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
export const PRODUCT_AGENT: AgentDefinition = {
  name: "product",
  description:
    "Product specialist: clarifies scope, requirements, and acceptance criteria before/around the build",
  // Requirements / spec work is general-purpose, not code-writing.
  role: "general",
  // READ + comms only — product characterises the work, it does not write code.
  // (It was built with the specialist() factory, which wrongly handed it
  // write_file/edit_file/Bash while its own body says "not to write feature code".)
  tools: [
    "read_file",
    "grep",
    "glob",
    "ls",
    "search_web",
    "web_fetch",
    "read_skill",
    "update_plan",
    ...COMMS_TOOLS,
  ],
  body: `You are the PRODUCT teammate on a coding team. Your job is to make the work well-defined — pin down what "done" means — not to write feature code.

- Read the request and the relevant code to understand the real intent and the current behaviour.
- Produce a short, concrete spec: the user-facing behaviour, the acceptance criteria, the edge cases, and what's explicitly out of scope. blackboard_post the key decisions so the whole team builds to the same target.
- Flag ambiguities and risks early; if a decision needs the human, say so plainly in your summary.
- Keep it tight and actionable — the coordinator and implementers act on it. Return a one-line summary of the decisions.`,
  sourcePath: "<builtin>",
}

/**
 * The built-in coding team for the current settings — the coordinator is built
 * per `autoLoop`/`maxLoopAttempts` (see {@link coordinatorAgent}); the rest are
 * static. Merged into the loaded roles by `withBuiltinAgents`.
 */
export const builtinTeamAgents = (
  opts: { readonly autoLoop: boolean; readonly maxLoopAttempts: number } = {
    autoLoop: true,
    maxLoopAttempts: 3,
  },
): ReadonlyArray<AgentDefinition> => [
  coordinatorAgent(opts),
  ARCHITECT_AGENT,
  PRODUCT_AGENT,
  FRONTEND_AGENT,
  BACKEND_AGENT,
  QA_AGENT,
  IMPLEMENTER_AGENT,
]

/** The default team (loop on, 3-round cap) — back-compat static export. */
export const BUILTIN_TEAM_AGENTS: ReadonlyArray<AgentDefinition> = builtinTeamAgents()
