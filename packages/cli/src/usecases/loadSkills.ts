// `loadSkills` moved to `@xandreed/sdk-core` (`usecases/loadSkills.ts`) so
// drivers outside this package (e.g. `@xandreed/smith`) can discover workspace
// skills without importing the CLI. Re-exported here so existing
// `import … from "./loadSkills.js"` consumers are unchanged.
export { loadSkills } from "@xandreed/sdk-core"
