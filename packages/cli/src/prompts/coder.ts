// The root coder prompt moved to `@xandreed/sdk-core` (`prompts/coder.ts`) so
// drivers outside this package (e.g. `@xandreed/smith`) can build the REAL
// coder system prompt without importing the CLI. Re-exported here so existing
// `import … from "../prompts/coder.js"` consumers are unchanged.
export {
  actionsSection,
  coderPrompt,
  coderSystemPrompt,
  doingTasksSection,
  knowledgeSection,
  renderCoreToolsSection,
  safetySection,
  systemSection,
  toneSection,
} from "@xandreed/sdk-core"
