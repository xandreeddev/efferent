# User journeys — what must work, and how we know it does

The product's spine, journey by journey: every interaction a user actually performs, its
moving parts, and its verification status. A journey is **solid** only when it's covered by
tests *and* has been driven end-to-end in a real terminal. Update this file when a journey
changes; it is the checklist for "is the tool usable", not aspiration.

Status legend: ✅ test-covered · 🖥 driven live (tmux, real renderer) · 🔑 needs a provider
credential to exercise end-to-end · ⚠ known rough edge (listed at the bottom).

---

## 1 · First contact

**Install → first boot → oriented in under a minute.**

| Step | What happens | Status |
|---|---|---|
| `efferent` in a TTY, no config | TUI boots straight in; status bar shows model/storage/cwd; conversation shows the `:login` hint | 🖥 |
| Sending a message with no provider | Message renders + "no provider configured — run :login" info block; nothing crashes, nothing is persisted | 🖥 ✅ |
| `:login` | Method pick (subscription/OAuth vs API key) → provider list with status tags → masked key paste or browser OAuth → usable that turn | 🖥 to the key prompt · 🔑 beyond |
| Headless with no credential | One-line hint on stderr, **exit code 1** | 🖥 |
| Running from source outside the repo | ⚠ dies on the Solid JSX preload (bunfig is cwd-relative) — supported flows are repo-root + `--cwd`, or the npm bundle | ⚠ |

## 2 · The conversation turn (the core loop)

**Type → send → watch the agent work → read the result.**

- Compose (multi-line textarea, Shift-Enter sends) → user block renders → activity gauge
  starts → assistant prose as markdown, tool pills with `⎿` results, edit diffs highlighted →
  turn folds when done. Esc interrupts the fiber (structured — sub-agents die with it).
- Tool failures come back as data the model reads (`failureMode: "return"`,
  `recoverMalformedToolCalls` for decode failures) — a bad tool call is a visible recovery,
  never a dead turn. ✅
- What the loop appends is persisted **explicitly** (`AgentResult.newTail`) — including
  synthetic correctives — never reconstructed by index arithmetic. ✅
- Bash asks for approval (modal: allow once / session rule / project rule / deny-with-reason);
  denial reasons steer the model in the same turn. ✅ (modal keys) · 🔑 (live turn)
- Status: loop logic ✅ · rendering 🖥 · full turn with a real model 🔑

## 3 · Delegation (sub-agents over the context tree)

**The agent fans work out; the human watches and steers.**

- `run_agent({folder, task})` spawns folder-sandboxed sub-agents; independent folders run in
  parallel (same-folder spawns queue on a per-folder lock); all spawns share one token budget
  per turn, refusals/partial-stops are model-readable. ✅
- `:tree` is the **agent navigation pane**: workspace conversations as git-graph roots (the
  live one tagged `◀ active`), each with its persisted agent subtree railed beneath — status
  glyphs, provenance, seed kind, billed tokens, `stale` badges, `d` drops a subtree, refresh
  at turn end. ✅ (pure model + store) · 🖥 (populated, seeded store)
- **Swap sessions from the tree**: `↵` on a conversation makes it the active session; `↵` on
  an agent node opens a read-only **session preview** in the conversation pane (seed/run
  boundary marked from the persisted `seedMessageCount`; `q`/`↵`/idle-Esc closes); `c` forks
  a node's context into a new conversation and makes it active. Swaps/forks refused
  mid-turn. ✅ 🖥 (seeded store, wide + narrow)
- Agent-driven resume/branch (`seedFromNode`/`seedMode`) — staleness brief injected when HEAD
  moved. ✅
- **The populated live journey (spawn → running nodes → resume) is the one remaining
  unverified leg — it needs a credentialed smoke.** 🔑

## 4 · Context curation

**See what the model sees; shape it.**

- `:handoff` folds the loaded history into a brief (cumulative; originals preserved). ✅
- `:context` partitions archived vs loaded, turn-granular selection, `:build` seeds a fresh
  session from picked turns/handoffs. ✅ (fold/selection model) · 🖥 (nav)
- `:browse` / `:resume <#|id>` / startup picker over prior workspace conversations. 🖥 ✅

## 5 · Steering the machine

**Models, settings, themes — without leaving the session.**

- `:model` live catalogue picker · `:effort` · `:search` (web-search model) — apply next turn,
  no restart. 🔑 (catalogue needs a key) · ✅ (selection persistence)
- `:settings` table (allowBash toggle, maxSteps edit, budget hint…), `:set <key> <value>`,
  `:theme` live-switches the whole UI. 🖥 ✅
- `:` works from **every** pane (read-only panes drop to the input and seed it — same as `/`);
  a bare `:` + Enter is a no-op, never "run the first palette entry" (which is `:exit`). 🖥

## 6 · Headless / scripting

**Same loop, machine surfaces.**

- `-p/--print` one-shot; `--mode json` JSONL events; `--mode rpc` JSON-RPC. Drain is
  deterministic (flush sentinel + fiber join) — `agent_end` and trailing tool events cannot
  be dropped. ✅ (drain pattern) · 🔑 (live one-shots)
- `--allow-bash` is the headless approval policy; CI never prompts. ✅

## 7 · Coming back

**Sessions survive; context is an asset.**

- History in SQLite (zero-config) or Postgres; resume by picker or `--resume`; the context
  tree persists across sessions; OAuth tokens refresh single-flight (no rotating-token
  poisoning under parallel calls), and a failed refresh says "run `:login <provider>` again"
  instead of silently dropping the model. ✅ (store contracts, refresh structure) · 🔑 (live)

---

## Known rough edges (open, ranked)

1. **Live credentialed smoke not yet run** for: a full turn, a populated `:tree`, approval
   mid-turn, OAuth round-trip. Everything below the LLM call is test-covered; the top leg
   needs a human with a key.
2. **Fast input bursts** (paste-speed): an Enter inside the same terminal chunk as text can
   land as a newline instead of running a `:` command. Typing-speed input is fine, and the
   double-Esc case is FIXED (two Escapes in one chunk parse as meta+Esc — now normalized to
   Esc). The Enter case lives in the textarea's chunk handling; upstream-or-adapter
   investigation. Mitigated: a bare `:` + Enter is a no-op, and pane navigation no longer
   depends on Ctrl encodings (Esc/`w` work everywhere — tmux/SSH included; `Ctrl-j/k/l`
   recovered from legacy bytes, `Ctrl-h` is indistinguishable from backspace and stays
   unsupported in legacy terminals).
3. **Running from source with cwd outside the repo** crashes on the missing Solid transform
   (`bunfig.toml` preload is cwd-relative). `--cwd` from the repo root and the npm bundle are
   the supported paths; the failure message should say so (today it's a raw module-resolve
   error).
4. **Activity pane under parallel sub-agents** models one open sub-agent at a time — inner
   tool attribution can interleave during a parallel burst. `:tree` (store-backed) is the
   source of truth; cosmetic.
5. Shell adapter: no process group on timeout kill (grandchildren may survive) + unbounded
   output buffering before truncation. Hardening, not breakage.
