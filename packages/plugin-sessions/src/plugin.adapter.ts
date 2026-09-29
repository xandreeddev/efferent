import { definePlugin, SessionLog, Sessions } from "@xandreed/core"
import { SessionsConfig, sessionsDefaults } from "./sessions-state.entity.js"
import { SessionsLive } from "./sessions.adapter.js"

/**
 * Sessions over the host's SessionLog: one event log per session, one open
 * turn at a time, leases by lease or by process, the inbox and forks.
 */
export const sessionsPlugin = definePlugin({
  id: "@xandreed/plugin-sessions", version: "0.7.0-next.1", scope: "runtime",
  config: SessionsConfig, defaults: sessionsDefaults,
  requires: [SessionLog],
  provides: [Sessions],
  layer: SessionsLive,
})
/** Sessions as a typed layer: provides Sessions; requires SessionLog. */
export const SessionsPluginLive = sessionsPlugin.live
export default sessionsPlugin
