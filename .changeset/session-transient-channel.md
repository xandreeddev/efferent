---
"@xandreed/core": minor
"@xandreed/plugin-sessions": minor
"@xandreed/plugin-render": minor
---

A session's transient events reach every follower of the session: core's `SessionChannel` port with `shareTransient`, an opt-in turn subscription that publishes `assistant.delta` and `tool.progress` to it without ever holding the turn, and its kit `sessionChannelConformance`; plugin-sessions' in-memory `SessionChannelMemoryLive`; and plugin-render's `sessionLive`, a session's channel as a render feed's `live` stream. Nothing is stored or replayed.
