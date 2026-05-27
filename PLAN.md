# Plan: pivot `agent` CLI to a no-compromise coding agent

## Context

Today `agent` is a personal-notes CLI: `capture / ls / show / rm`. The agent loop, hooks, ports, Postgres-backed conversation memory, and Gemini provider are all in place — they just happen to be wired to capture tools and a notes-flavoured system prompt.

We're repurposing the CLI to be a **coding agent** in the Pi mould (`~/Workspace/xandreed/pi`, read-only research material): run `agent` in any directory, it inherits cwd as its workspace, reads / writes / edits files, greps, runs shell. **No compromise on UX**: the default `agent` invocation drops into a proper full-screen TUI (Pi/Codex/Claude-Code shape) with a persistent status bar (model name, live context-token gauge, cwd), a scrollback area with inline tool-call pills and streaming markdown, and a multi-line input editor with slash-command palette. Three further modes (`--print`, `--mode json`, `--mode rpc`) cover headless / scripting / IDE-integration use cases.

Bash calls hit a y/n confirm modal in the TUI and require explicit `--allow-bash` in non-interactive modes; reads / writes / edits run freely (file changes are diff-printable and git-undoable). The capture/notes domain **stays in `@agent/core` and is still wired into the web driver** — only the CLI loses its capture verbs.

No React (it's a wedge — Pi-style: hand-rolled TUI on Bun). Model + tools + system prompt + safety policy are configured **in code** (composition root in `packages/cli/src/main.ts`); a settings layer is a future slice. The TUI surfaces what's hardcoded (model name, token usage) so users see it, even though they can't change it from the CLI yet.

## Architectural decisions

1. **`runAgent` becomes config-parameterized.** Lift `agentSystemPrompt` + `buildCaptureTools()` into an `AgentConfig<R> = { systemPrompt; tools }` parameter. Two prebuilt configs: `notesAgentConfig` (used by web) and `coderAgentConfig(cwd)` (used by the new CLI). Loop, hooks, persistence, caching unchanged.

2. **Two new ports** in `packages/core/src/ports/`:
   - `FileSystem` — read, write, exists, list, glob. Errors: `FileNotFound`, `PermissionDenied`, `NotADirectory`, `FileSystemError`.
   - `Shell` — `exec({ command; cwd; timeoutMs; signal? }) → { exitCode; stdout; stderr; durationMs; timedOut }`. Errors: `ShellTimeout`, `ShellAborted`, `ShellError`.

3. **Seven coding tools** mirroring Pi: `read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`, `ls`.

4. **`Llm` port extended** with `metadata: Effect<{ modelId; contextWindow }>` and `usage: TokenUsage` on `LlmRunTurnResult`. The TUI status bar reads metadata at startup and updates the token gauge from `onAssistantMessage` events.

5. **CLI shape** (no subcommands; capture verbs gone):
   ```
   agent                              # full TUI (TTY default)
   agent "<prompt>"                   # short-circuit: print mode if argv has prompt
   agent -p / --print                 # explicit print mode (stdin OK with "-")
   agent --mode json                  # stream agent events as JSONL on stdout
   agent --mode rpc                   # bidirectional JSON-RPC on stdin/stdout
   agent --resume <conversationId>    # continue an existing session
   agent --allow-bash                 # skip bash confirm prompts (non-interactive only)
   agent --cwd <path>                 # override workspace dir
   ```

6. **Mode = event renderer.** Loop emits `AgentEvent`s via hooks → queue → each mode renders differently.

7. **Real TUI** (no React/Ink/blessed): hand-rolled Bun + ANSI primitives in `packages/cli/src/tui/`. Three regions — status bar (top), scrollback (middle), input (bottom). Target ~600–900 LOC.

8. **Safety**: TUI installs an `onBeforeToolCall` that opens a y/n modal for `bash`. Non-interactive modes block `bash` unless `--allow-bash` passed — failures come back as structured tool results (the loop already catches `AgentToolError` gracefully).

## Target structure

```
packages/core/src/
├── entities/        AgentTool.ts AgentHooks.ts (+usage) Conversation.ts Capture.ts
├── ports/           Llm.ts (+metadata) ConversationStore.ts CaptureStore.ts
│                    FileSystem.ts                       NEW
│                    Shell.ts                            NEW
├── usecases/        runAgent.ts (parameterized)
│                    agentLoop.ts
│                    notesAgentConfig.ts                 NEW
│                    coderAgentConfig.ts                 NEW
│                    captureTools.ts                     (unchanged)
│                    codingTools.ts                      NEW
│                    capture.ts saveCapture.ts ...       (unchanged)
└── prompts/         agent.ts → notes.ts                 (renamed)
                     coder.ts                            NEW

packages/adapters/src/
├── llm/             gemini.ts vercelAi.ts (+usage +metadata)
├── fileSystem/      local.ts                            NEW
└── shell/           local.ts                            NEW

packages/cli/src/
├── main.ts                                              REWRITE
├── events.ts                                            NEW
├── safetyHooks.ts                                       NEW
├── modes/{tui,print,json,rpc}.ts                        NEW
└── tui/{terminal,keys,render,statusBar,scrollback,
          input,slashPalette,modal,markdown}.ts          NEW
```

## Coding tools

| tool          | parameters                                       | implementation |
|---------------|--------------------------------------------------|----------------|
| `read_file`   | `{ path; offset?; limit? }`                      | `FileSystem.read` |
| `write_file`  | `{ path; content }`                              | `FileSystem.write` |
| `edit_file`   | `{ path; edits: [{ oldText; newText }] }`        | read → string replace → write; returns unified diff |
| `bash`        | `{ command; timeout? }`                          | `Shell.exec` with cwd bound at tool-build time |
| `grep`        | `{ pattern; dir?; flags?; context? }`            | `Shell.exec("grep -rn ...")` v1; native impl later |
| `glob`        | `{ pattern; dir? }`                              | `FileSystem.glob` |
| `ls`          | `{ path?; recursive? }`                          | `FileSystem.list` |

All paths resolved against the `cwd` baked into `buildCodingTools(cwd)`. Errors wrapped via `AgentToolError`.

## Token & model display

Status bar tracks **input tokens this turn** (which already includes prior context the model re-saw) — gauge updates after every `onAssistantMessage` event. Denominator is the static `contextWindow` from `Llm.metadata` (1M for Gemini Flash). Cache-read tokens displayed dim alongside: `18k (12k cached) / 1M`.

Model id read once at startup; `/model` switching deferred.

## Dependencies

None added. Bun ships `Bun.spawn`, `Bun.Glob`, `Bun.file`; raw mode via `process.stdin.setRawMode`.

## Out of scope (deferred)

- Settings UI / config files / `/model` slash command — knobs hardcoded in `main.ts`.
- Skills system (Pi's lazy-loaded markdown index).
- Compaction.
- Streaming tool output (bash chunks back to model live).
- Token-level assistant streaming — v1 renders once per turn.
- Branch / fork / session tree.
- Extension system.
- Sub-agents / parallel tool execution.
- Image attachments.
- Mouse support.
- `tool.respond` safety prompts over RPC.
- Native (non-shell-out) grep.
- Settled fate of the capture domain (still used by web).
- Repo / binary rename.

## Verification

1. `bun run typecheck` — clean.
2. **TUI smoke**: `agent` opens full-screen TUI; status bar shows model + `0/1M` + cwd. Type `read the entrypoint`. Watch a `⚡ read_file packages/cli/src/main.ts` pill go orange → green, then assistant block appears. Token gauge updates. `/exit` restores prior terminal scrollback.
3. **Bash confirm**: in TUI, `run git status` → modal pops; `n` aborts (pill red), `y` runs.
4. **Print mode**: `agent -p "what's in packages/core/src/ports?"` runs `ls`, prints summary, exits 0. Tool log on stderr.
5. **JSON mode**: `agent --mode json "ls"` emits ≥4 JSONL events (`turn_start`, `tool_call_start`, `tool_call_end`, `agent_end`).
6. **RPC mode**: pipe `{"jsonrpc":"2.0","id":1,"method":"agent.send","params":{"prompt":"ls"}}\n` to stdin; receive `agent.event` notifications and a final response.
7. **`--allow-bash` denial**: `agent -p "run git status"` (no flag) → call blocked, agent recovers; with `--allow-bash` → runs.
8. **Web regression**: `bun --hot packages/web/src/main.ts`, two-turn notes conversation still works (web uses `notesAgentConfig`).
9. `git config user.email` returns `xandreed@proton.me`.

## OPSEC

Commits as `Xand Reed <xandreed@proton.me>`. No real-name references. Never commit anything under `~/Workspace/xandreed/pi`.
