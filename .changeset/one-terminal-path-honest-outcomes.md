---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": minor
---

One terminal path + an honest outcome vocabulary for every agent run.

Every run (root turn or spawned node, any exit shape) now funnels through ONE idempotent, infallible terminal path — `finalizeRun`: durable `recordReturn` (terminal-once at the store: only a `running` row closes, so a racing sweeper can't overwrite the first outcome) → `bus.complete` (parent inbox + waiter wake) → the `subagent_end` event. Abnormal exits (interrupt, watchdog stall, crash) can no longer skip the terminal event — the gap that made dead agents look alive in every UI surface.

The status vocabulary is honest now: `running | ok | partial | error | killed` plus a typed `stopReason` (`budget` / `step-cap` / `degenerate-loop` / `stall` / `interrupt(by: human|parent|shutdown|deadline)` / `provider` / `error`), persisted on the node (new `stop_reason` column, sqlite migration 0010 / pg 0014) and carried on `subagent_end`/`agent_end` (`outcome`/`reason`, schema-optional so stale daemon/client pairs still decode; the legacy `ok` boolean stays). Budget/step-cap stops were previously recorded as plain `ok` 25× in the run forensics; they are `partial` now — usable but incomplete, and `wait_for_agents` tells the orchestrator exactly that. A step-capped or breaker-stopped ROOT turn also reports `partial` instead of shipping its mid-thought last sentence as a success, and the gate no longer ships a wholly-failed fleet as "advisory success" (a majority error/killed fleet with no files stops non-advisory).

Spawned runs are **supervised fibers**: `bus.forkSupervised` replaces `forkDaemon(...catchAll(() => void))` (which discarded every exit), and `bus.shutdown()` — wired into TUI, print, json, rpc, and daemon teardown — interrupts and AWAITS the fleet so each run records `killed(shutdown)` before the process exits; no more rows stranded `running` forever. Interrupt APIs stamp WHO killed a run (`human`/`parent`/`shutdown`/`deadline`) so the persisted reason says so.

Headless modes are exit-code honest: print/json exit 1 when the run itself failed (error event, root error/killed), 0-with-stderr-notes for partial results, failed sub-agents on a delivered run, and gate degradation; rpc's resolve payload carries `outcome`. `agent_end` no longer ships the full `messages` array on the wire (zero consumers, megabytes per turn on SSE).
