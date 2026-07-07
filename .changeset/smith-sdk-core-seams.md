---
"@xandreed/sdk-core": minor
---

Lift the coder-driver seams out of the CLI so any driver can build the real
coder agent from the SDK alone: `coderPrompt`/`coderSystemPrompt`
(`prompts/coder.ts`), `coderAgentConfig`, `makeAgentEventHooks`/`makeEventHooks`
(`usecases/eventHooks.ts`), `stripLeads` (`usecases/roster.ts`),
`runFleetToCompletion`/`withInboxDrain` (`usecases/fleetCompletion.ts`), and the
workspace discovery loaders `loadSkills`/`loadMemory`/`loadAgents`/
`discoverInstructionFiles` over a shared `workspaceDiscovery.ts`
(`ancestorDirs` + `workspaceSearchPath` + `loadMarkdownAssets`). Breaking
within the move: `parseAgentFile` now returns `Option<AgentDefinition>`
instead of a nullable. The CLI re-exports everything from its old paths, so
`efferent/*` consumers are unchanged.
