// The `AgentEvent` union lives in `@xandreed/sdk-core` as a `Schema.Union`
// (`entities/AgentEvent.ts`) — both the loop's hooks and the daemon's HTTP/SSE
// wire need it. The hook adapters (`makeAgentEventHooks`/`makeEventHooks`)
// moved there too (`usecases/eventHooks.ts`) so a driver that never touches
// this package (e.g. `@xandreed/smith`) can wire the loop to a sink.
// Re-exported here so every `import … from "../../events.js"` consumer is
// unchanged.
import { AgentEvent } from "@xandreed/sdk-core"
export { AgentEvent }
export { makeAgentEventHooks, makeEventHooks } from "@xandreed/sdk-core"
