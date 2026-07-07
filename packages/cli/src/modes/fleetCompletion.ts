// `runFleetToCompletion` + `withInboxDrain` moved to `@xandreed/sdk-core`
// (`usecases/fleetCompletion.ts`) so drivers outside this package (e.g.
// `@xandreed/smith`'s implementor) can wait an outstanding fleet to completion.
// Re-exported here so existing `import … from "./fleetCompletion.js"` consumers
// are unchanged.
export { runFleetToCompletion, withInboxDrain } from "@xandreed/sdk-core"
