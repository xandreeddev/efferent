// `coderAgentConfig` moved to `@xandreed/sdk-core` (`usecases/coderAgentConfig.ts`)
// so drivers outside this package (e.g. `@xandreed/smith`) can build the coder
// config without importing the CLI. Re-exported here so existing
// `import … from "./coderAgentConfig.js"` consumers are unchanged.
export { coderAgentConfig } from "@xandreed/sdk-core"
