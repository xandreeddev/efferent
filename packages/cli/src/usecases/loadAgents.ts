// `loadAgents` + `parseAgentFile` moved to `@xandreed/sdk-core`
// (`usecases/loadAgents.ts`) so drivers outside this package (e.g.
// `@xandreed/smith`) can discover workspace agent definitions without
// importing the CLI. NOTE: `parseAgentFile` now returns
// `Option<AgentDefinition>` (core never returns nullables). Re-exported here
// so existing `import … from "./loadAgents.js"` consumers are unchanged.
export { loadAgents, parseAgentFile } from "@xandreed/sdk-core"
