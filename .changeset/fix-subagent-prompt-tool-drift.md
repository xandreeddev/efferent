---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(prompts): a sub-agent's prompt now lists only the tools it actually has — no more lying scaffold

Every spawned sub-agent got ONE static `# Tools` block plus the full `# Sub-agents` spawn doctrine, the agent roster, and the `# Coordination` "Read the blackboard FIRST" nudge — regardless of its real toolkit. So the read-only **architect** was told it could `write_file`/`edit_file`/`run_agent`/`wait_for_agents`/`blackboard_post`, the **researcher** that it had `Bash`/`run_agent`, and every leaf coder got "how to run a fleet" + "read the blackboard first" for tools it doesn't have. The real per-role toolkit was computed separately (`roleToolEntries`) and never reconciled with the prompt text.

- **Single source of truth.** New `renderToolsFor(toolNames)` (`sdk-core/prompts/toolList.ts`) renders the `# Tools` block from exactly the role's tool names, so a prompt can never advertise a tool the toolkit lacks. A coverage test asserts every tool the runtime can grant a sub-agent has a blurb (add a tool without one → CI fails). The spawn path passes `roleToolEntries(definition)` (or the generic set) straight through, so prompt and toolkit are derived from the same list.
- **Capability-gated sections.** `# Sub-agents` + the agent roster render only for a role that can actually spawn (`run_agent`); `coordinationSection` is now a function gated on the role's real comms/`wait_for_agents` — a read-only reviewer gets none of it, a comms-only leaf gets the blackboard/message guidance but not the `wait_for_agents` loop, a lead gets all of it.
- **`product` is read-only.** It was built with the `specialist()` factory, which handed it `write_file`/`edit_file`/`Bash` while its own body says "not to write feature code". It now carries read + comms only.

Net: the architect's prompt drops from a toolset it can't use + full fleet doctrine to exactly its five read-only tools and nothing else. Guarded by tests (renderToolsFor coverage + drop-unknown; per-role prompt presence-by-capability; product read-only). No behavior change to the toolkits themselves — only the prompt text now matches them.
