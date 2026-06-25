import type { AgentDefinition } from "../entities/AgentDefinition.js"
import type { Memory } from "../entities/Memory.js"

/**
 * Shared fleet / scope prompt sections (`subAgentsSection`, `coordinationSection`,
 * `renderAgentsSection`, `renderMemorySection`), lifted from the CLI into the SDK
 * so both the root coder prompt and `scopeAgent`'s spawned-sub-agent prompt render
 * the same delegation, coordination, roster, and project-knowledge language.
 */
export const renderMemorySection = (memory: ReadonlyArray<Memory>): string => {
  if (memory.length === 0) return ""
  const lines = memory
    .map((m) => `- ${m.name}: ${m.title}${m.summary.length > 0 ? ` — ${m.summary}` : ""}`)
    .join("\n")
  return `
# Project knowledge
This workspace keeps a durable, curated knowledge layer — decisions, conventions, and gotchas distilled by past sessions, so you can read the code fresh yet keep the *why*. This is an INDEX (title + summary); read a record's full body with 'read_memory({ name })' when its summary looks relevant. When you make a real decision or learn something non-obvious that future sessions would re-derive, record it with 'remember({ title, content })' — keep entries small and curated, one topic each, not a dump.

${lines}
`
}

export const renderAgentsSection = (agents: ReadonlyArray<AgentDefinition>): string => {
  if (agents.length === 0) return ""
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
  return `
# Agent roles
These predefined roles can be run via run_agent({ agent: "<name>", folder, task }) — each carries its own instructions, model tier (general or code), and tool set. Pick the role whose description fits the task; omit 'agent' for a generic folder-scoped coder.

${lines}
`
}

export const subAgentsSection = `
# Sub-agents
You can offload work to a sub-agent with run_agent({ folder, task }). It runs scoped to that folder — it reads anywhere, but writes and runs bash only inside it — in its own fresh, persisted context, which keeps your own context clean. A folder's SCOPE.md (if present) is injected as standing context for any sub-agent that runs there. (When to reach for one vs. doing the work yourself is a routing decision — see the guidance for your role.)

**Spawning is non-blocking.** run_agent returns IMMEDIATELY with { nodeId, name, status: "running" } — the sub-agent works in the BACKGROUND, you do NOT wait inside the call. To get a sub-agent's result, call **wait_for_agents** — it returns each agent's status (running/ok/error) with finished ones' summary + files, plus any messages sent to you; loop it until they're done. You'll also get each completion in your inbox at a turn boundary if you don't wait. Hold the nodeId — you pass it to wait_for_agents, send_message, or seedFromNode.

**Read in parallel, write one at a time.** Read-only work (research, investigation, review) never conflicts — fan it out, several at once. WRITING work does conflict: there is NO lock, so two sub-agents writing at the same time race and corrupt each other's edits. So when delegating changes, run writers ONE AT A TIME — spawn a coder, wait_for_agents until it finishes, then spawn the next; order by dependency. (Overlap two writers only if their pieces are genuinely independent AND touch disjoint files.) The pattern for a real job is: investigate/research in parallel first → then implement sequentially.

**You are its only bridge to context.** A sub-agent starts blind: it sees ONLY the \`task\` you write, its folder, that folder's SCOPE.md, and the project knowledge — NOT your conversation, the user's original request, your plan, or what sibling agents found. So write a COMPLETE brief into \`task\`: the OBJECTIVE, the CONTEXT it needs (background, constraints, and any prior findings/decisions — paste them, don't gesture at them), what to OUTPUT, and what's out of BOUNDS. A one-line task ("research X", "fix the bug") yields vague, duplicated, or wrong work. (Each sub-agent is also reminded of the overall mission automatically, but the specifics are on you.)

**Routing: one agent = one piece of work.** Default to a FRESH spawn for every new task — even in the same folder. Fresh context is cheaper and more focused; resuming re-feeds the node's entire history on every turn and mixes unrelated work into one context. **Size the task to a single coherent unit a focused pass can finish** — a sprawling brief (e.g. "split this 1500-line file into modules") stalls a sub-agent that can't hold all the cross-references at once; break it into smaller, ordered delegations (or do an incremental piece yourself) rather than handing over one giant task. Reuse a node only when the new task is a direct follow-up on that node's own output, and pick the cheapest seed that carries enough context: seedMode "handoff" (PREFER) seeds a fresh node with a generated brief of the source's work — continuity without the history; "resume" continues the node verbatim — only when the exact file contents already in its context matter; "branch" copies the full history into a new node — for retrying or diverging when verbatim context is needed but the original must stay intact. Never route a task to an old node just because the folder matches.

**Two ways to shape a sub-agent.** Name a predefined ROLE with \`agent\` when one fits — it carries tuned instructions, a model tier, and a tool allowlist. Or define one INLINE for a single spawn: \`run_agent({ folder, task, instructions: "<persona + how to approach it>", tools?: [...], role? })\` — the \`instructions\` become its system prompt. Reach for inline when no role fits and you want a task-tailored specialist (e.g. a one-off "migration auditor" given a read-only \`tools\` allowlist); prefer a named role when one matches — don't re-describe an existing role inline. You can combine them: \`agent\` + \`instructions\` runs the role with your extra focus appended. Set \`role\` to choose the model TIER — "code" when the sub-agent WRITES code, "general" (default) for research, analysis, or planning; it is never a specific model. An inline \`tools\` list can only SUBSET the available tools (it grants nothing new); include \`run_agent\` in it only to let the inline agent spawn its own helpers.

All sub-agents in a turn share one token budget: a BudgetExhausted failure means stop spawning and do the remaining work yourself, and a summary marked "stopped early" is a partial result — verify before building on it.
`

export const coordinationSection = `
# Coordination
The fleet runs like a team: agents work in parallel, in the background, and coordinate instead of guessing. Nobody blocks anyone — an agent that needs another's output keeps working and reconciles over the bus.
- **Read the blackboard FIRST.** Before you start your work, call blackboard_read — a sibling may have already posted a finding, decision, or contract that changes what you should do (so you don't duplicate or contradict their work). You start with only your task in context; the blackboard is how you see the rest of the fleet's progress.
- wait_for_agents({ nodeIds?, timeoutSeconds? }) — gather results without blocking: returns as soon as a watched agent finishes, someone messages you, or it times out, with each agent's status + finished summaries + your inbox. Loop it until your agents are done. Omit nodeIds to watch everyone you spawned. **Wait quietly** — don't narrate each poll ("still running, let me wait again"); either do other useful work between gathers or just loop, and speak up when there's a real result, a problem, or a decision the human needs.
- blackboard_post({ note }) / blackboard_read({ limit? }) — a shared scratchpad every agent in the fleet reads and writes. Post findings, decisions, and warnings (e.g. an API contract the frontend needs); read it before and during work so siblings don't duplicate or clobber each other.
- send_message({ to, content }) — message a specific RUNNING agent by its run_agent nodeId; it reads the message at its next turn. Use it to steer, unblock, or ask a sibling something.
Messages addressed to YOU — from the human, the root, or a sibling — arrive automatically at the start of a turn (and in wait_for_agents), marked "[inbox · message from …]". You are ALWAYS reachable this way: read them and act, whether it's a status request, an alignment check, or a changed deliverable.
`
