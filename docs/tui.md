# The efferent TUI

A field guide to the terminal UI — what the panes are, how you move around them, and
every key and `:` command. Up to date with `main`.

> **What it is.** A **modal, multi-pane** terminal UI rendered by **OpenTUI** (a native
> Zig renderer driven over Bun FFI) with a **SolidJS** signal graph on top — **no React,
> no Ink, no hand-rolled ANSI**. Assistant prose is real `<markdown>`; file edits are real
> `<diff>`; fenced code and diff hunks are tree-sitter syntax-highlighted. The layout is
> Yoga/flexbox boxes, not string-pasting.

For *architecture* (how the TUI is wired to the Effect runtime), see `packages/cli/CLAUDE.md`.
For *what's shipped at a glance*, see `README.md`. For *what's deferred*, see `docs/roadmap.md`.

---

## The screen

Top to bottom, the TUI is five stacked regions:

```
▌efferent  ⠹ Read(main.ts) 4s  ◆ 2 agents · audit, fix scroll      ← header: the live agent state
┌─ <session title> ──────────────────────┐ ┌─ activity ─────────┐ ← the two read-only panes,
│ the event rail: your prompts, the       │ │activity·context·agents│ one empty column between;
│ agent's prose, tool calls, diffs        │ │ ctx ▓░ 1% 6k/1M     │   the side pane's tab row
│                                         │ │ Σ main·fast·cheap   │   shows its views; Σ = the
└─────────────────────────────────────────┘ └────────────────────┘   per-role spend ledger
 j/k scroll · ↵ fold · w next pane · v views · i type · ? keys     ← keybind strip (1 row;
 :model  …                                                            `?` expands the full box)
┌─ input · INSERT ─────────────────────────────────────────────┐   ← the composer (1→8 rows)
│ run the tests                                                 │
└───────────────────────────────────────────────────────────────┘
 gemini-3.5-flash · fast flash-lite · ▓░ 1% 6k/1M · 66% cached …   ← status bar (+ toasts)
```

Modal overlays (`:model`, `:login`, `:settings`, …) float over everything on an
absolutely-positioned layer, capped to the screen height. **Below ~110 columns** only the
focused pane renders, full-width — the side pane stays a keystroke away (`w`, `:tree`,
`:context`). Transient feedback (theme switched, copied, queued, unknown command) appears as
a **toast** in the status bar and clears itself — the conversation rail is the permanent
record, never a notification feed.

---

## Panes, focus, and modes

There are **three focusable panes**: **conversation** (left), **side** (right), and **input**
(the composer). The focused pane's border + title brighten to its accent — **conversation =
cyan, side = magenta, input = green** (unfocused = gray).

| Action | Keys |
|---|---|
| Leave the composer (input → conversation, NORMAL) | `Esc` (on a `:`/`/` line it cancels the line first) |
| Cycle panes (conversation → side → input) | `w` (in NORMAL) |
| Jump straight to a pane | `Ctrl-k` (conversation) / `Ctrl-l` (side) / `Ctrl-j` (input) — also `Ctrl-arrows` and `Ctrl-h` where the terminal supports them |
| Cycle the side pane's views | `v` from any pane (activity → context → agents → sessions) — focuses the side pane so the next keys drive the view you swapped to |
| Back to the composer | `i` |
| Toggle the full keybind box | `?` (in NORMAL) |
| Zoom the focused pane | `z` |
| Quit | `Ctrl-C` (press twice — the first press arms it) |

**Esc and `w` work in every terminal** — including tmux and SSH sessions, where the
`Ctrl-h/j/k/l` encodings may never reach the app (legacy input modes send them as other
bytes; `Ctrl-j`/`Ctrl-k`/`Ctrl-l` are recovered, `Ctrl-h` is indistinguishable from
backspace). vi hands get the modal flow (`Esc` out, `i` in, `hjkl` motions); everyone else
gets arrows, `w`, and the visible strip — same vocabulary, no memorization required.

Each pane has a **mode**, shown in the expanded keybind box title as `<pane> · <MODE>`:

- **Input is `INSERT`** — you're typing a message.
- **The two read-only panes are `NORMAL`** — a vim-style **fold cursor** moves over the
  pane's logical rows. `i` from the side pane drops back into the input.

> The keybind **strip** is one dim row — the focused context's essentials. `?` expands the
> full two-row box (global nav row + the focused pane's complete keys).

---

## The conversation pane

A Claude-style **event rail**. Each block is separated by a blank line so the pane breathes.

- **Your prompts** lead the turn.
- **Assistant prose** renders as **markdown** — headings, bold/italic, inline code, lists,
  links; the `●` bullet floats top-left so the prose wraps with a clean hanging indent.
- **Tool calls** each lead with a `●` (colour = run/ok/error). The header reads
  `ToolName(arg)`; the result hangs under a `⎿` connector. `edit_file` results render as a
  real unified **`<diff>`** with `+/-` colouring and line numbers.
- **Fenced code blocks and diff hunks** are **syntax-highlighted** via tree-sitter
  (grammars bundled: JS/TS/markdown/zig; others render un-highlighted).

### Turns and tool groups (folding)

- A **turn** ("commit") is one user message and everything it produced. `⇥`/`↵` collapses it
  to `▸ <subject> · N steps`.
- A **big or multi-line user message** (e.g. a resumed handoff summary) shows just its first
  line as the subject and keeps the full text in the foldable body — so it collapses like any
  turn instead of being an un-foldable wall.
- A **run of ≥2 tool calls** in a turn **aggregates into one collapsed-by-default line** —
  `▸ read · grep · edit  (3 tools, +5 -2)` (repeated verbs collapse to `read ×3`; the rolled-up
  diffstat and any running/failed counts ride along; the caret takes the group's aggregate
  colour, so a failure shows through the fold). `⇥`/`↵` expands it to the individual pills.

### Moving around

`j/k` (and `↓/↑`) **scroll lines**; the **fold cursor** moves by logical unit and tints the
current one (scrolling it into view as it goes):

| Action | Keys |
|---|---|
| Scroll one line | `j` / `k` · `↓` / `↑` |
| Half page / full page | `Ctrl-D` / `Ctrl-U` · `PgDn` / `PgUp` |
| Cursor: prev/next paragraph | `{` / `}` |
| Cursor: prev/next message | `[` / `]` |
| Cursor: first / last unit | `gg` / `G` (jumps to absolute top/bottom) |
| Fold the unit under the cursor | `⇥` / `↵` · `h` / `l` · `←` / `→` |
| Fold **all** turns (toggle) | `Z` |
| Search this pane | `/` (then `n` / `N` to cycle, `Esc` to clear) |
| Copy the mouse selection | `y` |

---

## The side pane

The right pane has **four views**, one concern each (`v` cycles them **from any pane** in
NORMAL; the tab row shows where you are):

- **activity** — the live run dashboard (full pane).
- **context** — the loaded-context viewer/curator (full pane).
- **agents** (`:tree`) — **the active session's execution tree only**, anchored by a
  depth-0 **root agent row** (the active session, `◀ active`) with its sub-agents railed
  beneath, split into two reactive sections: the tree on top holds the cursor, and the
  **detail section below follows it** — full (unclipped) return summary, seed,
  files changed, billed tokens, and a running node's **live tool feed**. `↵` opens/talks
  to a node; `↵` on the root closes any open preview — **back to the root agent**; `c`
  forks, `d` drops.
- **sessions** (`:sessions`) — every conversation sharing this workspace path, the live one
  tagged `◀ active`; `↵` swaps the active session (the composer and the agents view follow).

Navigator data loads at boot and refreshes at every turn end.

### Activity (default)

A live dashboard of the run — and a faithful one after a switch: the tree is **rebuilt from
the loaded session's messages** whenever the context changes (resume, build, fork, boot), runs
folded, so the pane always describes the session you're looking at, not the previous one.
(Timings only exist for live runs; rebuilt rows show no duration.)

- **Context gauge** — tokens used vs the model's window (cached tokens shown dim).
- **Plan** — the agent's working checklist (`update_plan`): ✓ done · ● active · ○ pending.
  Appears once the agent plans a multi-step task; follows the loaded session.
- **Cumulative** output tokens, turns, elapsed time; **per-LLM-call** usage + duration.
- **Run tree** — every user message opens a **run container** (`❯ <prompt>`, the same quiet
  prompt styling as the conversation rail) with its turns → tools → sub-agents nested under
  it. The current run stays expanded while it streams; **sending the next message folds the
  previous runs** to one line each (`▸ ❯ <prompt> · N turns`).
- **Workspace sections** pinned at the pane bottom behind a `── workspace ──` rule:
  **files changed** (`+/-` diffstat per file), foldable **skills** and **instructions**.

It has its own block cursor over all of it (tree + sections).

| Action | Keys |
|---|---|
| Move the cursor | `j` / `k` · `{` / `}` |
| Jump to the next head (turn / section) | `[` / `]` |
| First / last row | `gg` / `G` |
| Fold a tree node or a section | `⇥` / `↵` · `h` / `l` · `←` / `→` |
| Search the rows | `/` |
| Back to the composer | `i` |

### Context viewer (`:context`)

A navigable tree of foldable, **selectable** turns and handoffs. It partitions the
conversation into **archived** segments (folded away, not loaded into the model) and the
**loaded** segment — so you can *see* what a handoff replaced.

| Action | Keys |
|---|---|
| Move / fold / jump | `j` `k` · `{` `}` · `[` `]` · `gg` `G` · `⇥`/`↵`/`h`/`l`/`←`/`→` |
| Jump the conversation to a unit | `↵` (Enter) |
| **Select / deselect** a turn or a handoff | `Space` |
| **Build a new session** from the selection | `b` (or `:build`) |
| Search the rows | `/` |

Selecting a **handoff** contributes only its summary (one synthetic message), not the folded
originals — so a handoff and its own inner turns are mutually exclusive (picking one clears the
other). The original conversation is never modified; `:build` seeds a *new* one.

### Agent navigation pane (`:tree`)

The workspace's whole session graph, drawn as a **git-log-`--graph`-style tree**. The depth-0
roots are your **conversations** (the manual branches — every chat, resume, and `:build` fork;
the live one is tagged **`◀ active`**). Beneath each hangs its **agent branch** subtree: every
sub-agent that conversation spawned via `run_agent`, persisted across sessions, connected by
`├─`/`└─` rails with `│` continuation columns (a **branched** fork's connector is tinted in the
side accent). Each node shows its folder, status (`✓` ok / `✗` error / `●` running), provenance
(**spawned** / **branched** / **resumed**), seed kind, files-changed count, **billed tokens**,
and the return summary — plus a yellow **`stale`** badge when the repo's HEAD moved since the
node ran (resuming a stale node auto-injects a what-changed brief so the model re-reads before
editing). Sub-agents in different folders run **in parallel** — expect several `●` nodes at
once; the view refreshes when a run finishes spawning them.

| Action | Keys |
|---|---|
| Move / jump | `j` `k` · `{` `}` · `[` `]` (conversation roots) · `gg` `G` |
| Fold a subtree | `⇥` / `h` / `l` / `←` / `→` |
| **Open** the row | `↵` — a conversation becomes the **active session**; an agent node opens a read-only **session preview** in the conversation pane (`↵` again / `q` / `Esc` when idle closes it) |
| **Fork** an agent node | `c` — copies its full context into a **new conversation**, makes it active, and drops you in the composer (take over where the agent stopped) |
| **Drop** a node + its descendants | `d` (nodes only; a running node can't be dropped) |
| Search the rows | `/` |
| Back to the composer | `i` |

The **session preview** replays the node's persisted messages as a normal rail — title flips to
`agent: <folder>`, a header line gives folder · provenance · seed, and (for nodes that recorded
it) `── seed … ──` / `── run starts ──` rules mark where the spawn-time context ends and the
agent's own work begins. It's an overlay: a running turn keeps appending to the live rail
underneath, untouched. Session swaps and forks are refused while a turn is running.

**While a preview is open, the composer talks to that agent.** The input title flips to
`input → agent: <folder>`; sending a message appends it to the node's persisted context and
**re-runs that sub-agent in place** (folder-scoped, staleness brief if the repo moved, its
children hang off the node) — it does *not* go to the parent conversation. The preview
re-fetches when the run ends; `q`/Esc returns the composer to the active session.

The agent drives resume/branch itself (`run_agent({ seedFromNode, seedMode: "resume" \| "branch" })`);
the preview follow-up is the human-driven resume, `c` the human-driven fork.

---

## Bash approval

When the agent wants to run a shell command, a modal asks — and three of the four answers are
**rules** that stop future prompts for the same command family:

```
┌─ Bash wants to run ────────────────────────────┐
│  bun test packages/core                        │
│  in ~/work/myrepo                              │
│  ──────────────────────────────────            │
│  a  allow once                                 │
│  s  allow bun test … for this session          │
│  p  always allow bun test … in this project    │
│  d  deny — tell the agent why                  │
└────────────────────────────────────────────────┘
```

`p` persists to the project's `.efferent/config.json` (`approvedBashRules`). `d` opens a reason
line — **the agent reads your reason** as the tool failure and adjusts course in the same turn.
`Esc` denies (the safe default never runs the command). Commands with pipes/substitutions only
ever match exactly; plain commands match on `command + subcommand`. Headless modes (`--print`,
`--mode json/rpc`) never prompt — they keep the static `--allow-bash` gate.

---

## The input composer

A multi-line `<textarea>` that grows from 1 to 8 rows.

| Action | Keys |
|---|---|
| Insert a newline | `Enter` |
| **Send** the message | `Enter` (also `Alt-Enter`) |
| Insert a **newline** | `Shift-Enter` (Kitty-protocol terminals) · `Ctrl-J` (everywhere) · pasted newlines are kept |
| Interrupt a running turn | `Esc` |
| Recall sent-message history | `↑` / `↓` (on an empty single-line buffer) |
| Open the command palette | type `:` |
| Start a pane search | type `/` |

While a `:` command or `/` search is being typed:

- **`Enter` runs it** outright (no Shift needed).
- **`⇥` / `→`** completes the highlighted palette entry.
- **`↑` / `↓`** move the palette highlight (in command mode) — they don't recall history there.

---

## Commands (`:` palette)

Type `:` to open the palette; it filters by prefix as you type, `Enter` runs the highlight,
`⇥`/`→` completes it. Commands take a `:` prefix (vim ex-style); `/` is reserved for search.
A unique prefix resolves (`:mod` → `:model`).

**Session & history**

| Command | What it does |
|---|---|
| `:clear` | Start a fresh conversation — new id, empty scrollback, reset tree/stats |
| `:handoff` | Summarize & hand off — replace the loaded history with a brief, keep the originals |
| `:context` | Toggle the context viewer (turn tree — `Space` select, `b` build) |
| `:tree` | Toggle the agent navigation pane (sessions + sub-agents — `↵` switch/preview, `c` fork, `d` drop) |
| `:build` | Build a new session from the turns selected in `:context` |
| `:browse` | List the conversations in this workspace |
| `:resume <#\|id>` | Resume one (a `:browse` number or a raw id) |

**Model & providers**

| Command | What it does |
|---|---|
| `:model [fast\|cheap]` | Open the model picker for **main** — or for the **fast**/**cheap** role (leading *default (follow main)* row clears it) |
| `:effort [level]` | Pick the thinking/reasoning effort |
| `:search [target]` | Web-search model picker, or `:search openai:gpt-4o` / `default` |
| `:login` | Add a provider — subscription (OAuth) or API key |
| `:logout <provider>` | Remove a provider's credential |

**Appearance & config**

| Command | What it does |
|---|---|
| `:theme [name]` | Switch the colour theme (↑↓ / ↵), or `:theme <name>` — ships `efferent` (default) + `one-dark` + `tokyo-night` |
| `:settings` | Open the settings modal (arrow + ↵ to edit) |
| `:set <key> <value>` | Update a config setting, e.g. `:set maxSteps 30` or `:set fastModel google:gemini-3.1-flash-lite` (latency-sensitive helper calls: tool summaries, approval judgments) / `:set cheapModel …` (background: session titles); unset roles follow main. Headroom: `:set toolResultMaxTokens 4000` (tool-result clip budget, 0 = off) · `:set autoHandoffPct 85` (auto-fold threshold, 0 = off) |
| `:db [pg <url>\|sqlite [path]]` | Show or set the conversation store (trailing `global` writes `~/.efferent/config.json`) |

**Meta**

| Command | What it does |
|---|---|
| `:cwd` | Print the workspace directory |
| `:exit` / `:quit` | Quit |

---

## Search, selection, and yank

- **`/` searches the focused read-only pane.** Typing `/` in a pane seeds the composer; the
  match jumps into view with an `[i/N]` counter, `n`/`N` cycle, `Esc` clears. The current match
  is highlighted and the fold cursor parks on it.
- **Selection is OpenTUI's native mouse** (`useMouse:true`): drag to highlight. **`y`** (in a
  read-only pane) copies the highlighted selection to the system clipboard via **OSC 52** —
  `Ctrl-Shift-C` does the same. (Copying assistant *prose* may come back empty: it's a native
  markdown component, which doesn't expose selectable text the way plain text rows do.)
- The input `<textarea>` owns its own selection and editing while you type.

---

## Theming

The colours come from a two-tier design system: a `palette` of raw values feeds a set of
**semantic tokens** every view paints against. A **theme is one complete set of token values**;
`:theme` swaps the whole UI live (code highlighting included) with no restart, and the choice
persists to `config.json`. Ships **`efferent`** (the default — warm near-black with an ember/verdigris/chartreuse accent triad), **`one-dark`**, and **`tokyo-night`**.

---

## Overlays

Several commands float a modal picker over the UI — all share the same select/prompt shapes:

- **`:model` / `:effort` / `:search` / `:theme`** — a filterable select list (↑↓ / type to
  filter / ↵ to choose).
- **`:login`** — a small state machine: *Use a subscription* (OAuth) **or** *Use an API key* →
  pick a provider (status-tagged) → paste a masked key **or** run the browser OAuth flow →
  usable that same turn, no restart.
- **`:settings`** — an editable table of config knobs.

---

## Startup

With no `--resume`, if the workspace has prior conversations the TUI floats a **startup
picker** — a leading "＋ Start a new conversation" row, then `<date> · <title|first-prompt>` per
conversation. `Enter` resumes; `Esc` (or "start new") leaves you in a fresh session. No prior
conversations → straight to an empty rail.

If no provider credential exists yet, the rail shows a `:login` hint and sending a message
short-circuits to the same hint — run `:login` to add one.

---

## Status bar & footer

- **Status bar:** `model · tokens · storage · cwd`. Tokens read `used (cached) / window`, with
  cache-read tokens dim.
- **Footer:** the log path plus the send/interrupt/quit reminders.

---

## Deferred

What the TUI **doesn't** do yet (see `docs/roadmap.md` for the full backlog): token-level
streaming (the loop is `generateText` per turn, so prose lands a turn at a time, not
token-by-token); charwise vim motions (`w/b/e`) and VISUAL mode; an interactive per-command
bash-approval modal; syntax highlighting beyond JS/TS/markdown/zig; and a few search-highlight
refinements.
