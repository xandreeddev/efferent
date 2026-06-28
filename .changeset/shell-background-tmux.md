---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": minor
---

shell: background processes + tmux interactive sessions, on a process-group-correct foundation.

The `Shell` port was one-shot only (`exec` — blocking, pipes, no TTY), so nothing could outlive a tool call and an interactive program had no way to run. A research run that tried to "observe a TUI live" hacked `script -q -c '<tui>'` and hung the turn for 41 minutes: `exec` killed only the direct child on timeout, then blocked on `readAll` of a pipe a reparented orphan still held.

- **Foundation — process-group correctness (`shell/local.ts`).** Commands now spawn in their own process group (`detached`), so a timeout/abort group-kills the whole tree (`script`/`setsid`/reparented orphans included), and the call settles on the process's **exit** plus a bounded drain grace — never on pipe EOF, so an fd-holding orphan can't hang it. This fixes the original hang and protects the verifier's long `exec` too.
- **Background processes.** `Bash({ run_in_background: true })` returns a `processId` immediately; `bash_output` reads incremental output (with a cursor); `kill_bash` group-kills it. For dev servers, watchers, long builds. The Bash default timeout is also raised 60s → **5 min** (agent-overridable via `timeout`), kept independent from the verifier's 30-min cap.
- **Interactive tmux sessions.** A new `TerminalSession` port (tmux-backed) + `session_start`/`session_send`/`session_read`/`session_kill`/`session_list` — drive a TUI/REPL/ssh, capture its screen, and `tmux attach` to the same pane. Feature-detected: no tmux ⇒ a graceful, model-readable failure.
- **Visibility + teardown.** Background output surfaces live via a new `bg_output` event (same `RunContext` sink path as `llm_retry`); on app exit, all background procs and tmux sessions are group-killed so nothing is orphaned.
