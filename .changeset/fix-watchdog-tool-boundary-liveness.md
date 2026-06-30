---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(fleet): stamp stall-watchdog liveness at the START of each tool call, not just on completion

The sub-agent stall watchdog (`SUBAGENT_STALL_DEADLINE_MS`, 180s) stamps progress on turn-start, tool *completion*, narration, and LLM retry. A turn's LLM phase (already bounded by the 120s request timeout, which retries and stamps) plus a long tool call can together exceed the deadline while each phase is individually fine — and because only `onAfterToolCall` stamped, the watchdog measured time-since-turn-start and could interrupt a working agent mid-tool.

Bumping on `onBeforeToolCall` makes the watchdog measure time-since-the-last-step (turn boundary OR tool boundary), so a healthy agent whose work spans model time + tool time isn't killed for being busy. The guard still fires on a genuine hang (no turn, no tool start/finish, no retry within the deadline) — verified by the existing watchdog tests (a hung model is still interrupted; a healthy one is not).

Note: a *single* tool call that legitimately runs longer than the deadline (e.g. a multi-minute build) is not covered by this and remains a known limitation; pausing the watchdog for the duration of an in-flight tool is the larger follow-up. Incremental persistence of a running node's status/usage to the durable context tree (today it commits at finish; the live bus is already authoritative for the running fleet) is also deferred as an observability improvement.
