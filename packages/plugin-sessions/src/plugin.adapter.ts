import { definePlugin, SessionLog, Sessions, TurnAdmission } from "@xandreed/core"
import { SessionsConfig, sessionsDefaults } from "./sessions-state.entity.js"
import { SessionsLive } from "./sessions.adapter.js"

/**
 * Sessions over the host's SessionLog: one event log per session, one open
 * turn at a time, leases by lease or by process, the inbox and forks. The
 * host admits every turn (TurnAdmissionOpen admits all).
 */
export const sessionsPlugin = definePlugin({
  id: "@xandreed/plugin-sessions", version: "0.7.0-next.1", scope: "runtime",
  config: SessionsConfig, defaults: sessionsDefaults,
  requires: [SessionLog, TurnAdmission],
  provides: [Sessions],
  layer: SessionsLive,
})
/** Sessions as a typed layer: provides Sessions; requires SessionLog and TurnAdmission. */
export const SessionsPluginLive = sessionsPlugin.live
export default sessionsPlugin
